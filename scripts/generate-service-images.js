require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { PrismaClient } = require('@prisma/client');
const { getS3Client, isS3Configured, buildPublicUrl } = require('../src/config/s3');
const env = require('../src/config/env');

const WIDTH = 1200;
const HEIGHT = 750;
const OUT_DIR = path.join(__dirname, '..', 'generated', 'service-images');

const args = new Set(process.argv.slice(2));
const NO_UPLOAD = args.has('--no-upload');
const ONLY_MISSING = args.has('--only-missing');

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND'),
  ]);
}

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function mix(a, b, t) {
  return [
    Math.round(a[0] * (1 - t) + b[0] * t),
    Math.round(a[1] * (1 - t) + b[1] * t),
    Math.round(a[2] * (1 - t) + b[2] * t),
  ];
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

class Raster {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
  }

  pixel(x, y, color, alpha = 255) {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height || alpha <= 0) return;
    const idx = (iy * this.width + ix) * 4;
    const a = alpha / 255;
    const inv = 1 - a;
    this.data[idx] = Math.round(color[0] * a + this.data[idx] * inv);
    this.data[idx + 1] = Math.round(color[1] * a + this.data[idx + 1] * inv);
    this.data[idx + 2] = Math.round(color[2] * a + this.data[idx + 2] * inv);
    this.data[idx + 3] = Math.min(255, Math.round(alpha + this.data[idx + 3] * inv));
  }

  fill(color) {
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = color[0];
      this.data[i + 1] = color[1];
      this.data[i + 2] = color[2];
      this.data[i + 3] = 255;
    }
  }

  gradient(base, accent) {
    const white = [255, 255, 255];
    const paleAccent = mix(white, accent, 0.18);
    const warm = [248, 250, 252];
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const nx = x / this.width;
        const ny = y / this.height;
        const t = Math.min(1, Math.max(0, nx * 0.28 + ny * 0.45));
        const color = mix(paleAccent, base, t);
        const glow = Math.max(0, 1 - Math.hypot(nx - 0.12, ny - 0.08) * 2.6);
        const finalColor = mix(color, warm, 0.28);
        const withGlow = mix(finalColor, accent, glow * 0.1);
        const idx = (y * this.width + x) * 4;
        this.data[idx] = withGlow[0];
        this.data[idx + 1] = withGlow[1];
        this.data[idx + 2] = withGlow[2];
        this.data[idx + 3] = 255;
      }
    }
  }

  rect(x, y, w, h, color, alpha = 255) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w));
    const y1 = Math.min(this.height, Math.ceil(y + h));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) this.pixel(px, py, color, alpha);
    }
  }

  roundRect(x, y, w, h, r, color, alpha = 255) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w));
    const y1 = Math.min(this.height, Math.ceil(y + h));
    const right = x + w - r;
    const bottom = y + h - r;
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const cx = px < x + r ? x + r : px > right ? right : px;
        const cy = py < y + r ? y + r : py > bottom ? bottom : py;
        const dx = px - cx;
        const dy = py - cy;
        if (dx * dx + dy * dy <= r * r) this.pixel(px, py, color, alpha);
      }
    }
  }

  strokeRoundRect(x, y, w, h, r, color, alpha = 255, width = 3) {
    this.roundRect(x, y, w, h, r, color, alpha);
    this.roundRect(x + width, y + width, w - width * 2, h - width * 2, Math.max(1, r - width), [255, 255, 255], 255);
  }

  circle(cx, cy, radius, color, alpha = 255) {
    const x0 = Math.max(0, Math.floor(cx - radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const x1 = Math.min(this.width, Math.ceil(cx + radius));
    const y1 = Math.min(this.height, Math.ceil(cy + radius));
    const rr = radius * radius;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= rr) this.pixel(x, y, color, alpha);
      }
    }
  }

  ellipse(cx, cy, rx, ry, color, alpha = 255) {
    const x0 = Math.max(0, Math.floor(cx - rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const x1 = Math.min(this.width, Math.ceil(cx + rx));
    const y1 = Math.min(this.height, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.pixel(x, y, color, alpha);
      }
    }
  }

  line(x1, y1, x2, y2, width, color, alpha = 255) {
    const half = width / 2;
    const minX = Math.floor(Math.min(x1, x2) - half - 1);
    const minY = Math.floor(Math.min(y1, y2) - half - 1);
    const maxX = Math.ceil(Math.max(x1, x2) + half + 1);
    const maxY = Math.ceil(Math.max(y1, y2) + half + 1);
    const vx = x2 - x1;
    const vy = y2 - y1;
    const len2 = vx * vx + vy * vy || 1;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const t = Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / len2));
        const px = x1 + t * vx;
        const py = y1 + t * vy;
        const dx = x - px;
        const dy = y - py;
        if (dx * dx + dy * dy <= half * half) this.pixel(x, y, color, alpha);
      }
    }
    this.circle(x1, y1, half, color, alpha);
    this.circle(x2, y2, half, color, alpha);
  }
}

const ink = [15, 23, 42];
const slate = [71, 85, 105];
const light = [248, 250, 252];
const white = [255, 255, 255];
const blue = [47, 95, 255];
const teal = [14, 165, 233];
const green = [16, 185, 129];
const amber = [245, 158, 11];
const red = [239, 68, 68];

function drawBase(c, accent) {
  c.gradient(light, accent);
  c.circle(1040, 88, 190, accent, 24);
  c.circle(145, 650, 230, mix(accent, white, 0.2), 22);
  c.circle(965, 590, 145, mix(accent, white, 0.45), 20);
  c.roundRect(88, 72, 1024, 600, 48, [15, 23, 42], 18);
  c.roundRect(80, 64, 1024, 600, 48, white, 220);
  c.roundRect(120, 112, 18, 502, 9, accent, 210);
  c.ellipse(610, 604, 420, 52, [15, 23, 42], 24);
}

function drawSparkles(c, accent) {
  const pts = [
    [920, 155, 20],
    [990, 230, 13],
    [835, 190, 10],
  ];
  for (const [x, y, r] of pts) {
    c.line(x - r, y, x + r, y, 4, accent, 190);
    c.line(x, y - r, x, y + r, 4, accent, 190);
    c.circle(x, y, 4, white, 220);
  }
}

function drawWrench(c, x, y, scale, color = slate) {
  c.line(x, y + 92 * scale, x + 112 * scale, y - 20 * scale, 22 * scale, color, 230);
  c.circle(x + 123 * scale, y - 31 * scale, 36 * scale, color, 230);
  c.circle(x + 135 * scale, y - 43 * scale, 24 * scale, white, 255);
  c.line(x - 8 * scale, y + 100 * scale, x + 20 * scale, y + 128 * scale, 16 * scale, color, 230);
}

function drawCylinder(c, x, y, scale, accent) {
  c.ellipse(x + 64 * scale, y + 24 * scale, 64 * scale, 24 * scale, mix(accent, white, 0.42), 255);
  c.roundRect(x, y + 18 * scale, 128 * scale, 220 * scale, 28 * scale, mix(accent, white, 0.62), 255);
  c.ellipse(x + 64 * scale, y + 238 * scale, 64 * scale, 24 * scale, mix(accent, ink, 0.14), 210);
  c.roundRect(x + 42 * scale, y - 18 * scale, 44 * scale, 42 * scale, 12 * scale, slate, 220);
  c.circle(x + 64 * scale, y - 48 * scale, 28 * scale, white, 255);
  c.circle(x + 64 * scale, y - 48 * scale, 22 * scale, accent, 190);
  c.line(x + 64 * scale, y - 48 * scale, x + 78 * scale, y - 60 * scale, 5 * scale, white, 255);
}

function drawDroplets(c, accent) {
  const water = mix(teal, accent, 0.15);
  for (let i = 0; i < 14; i += 1) {
    const x = 815 + (i % 5) * 46 + Math.floor(i / 5) * 10;
    const y = 205 + Math.floor(i / 5) * 62 + (i % 2) * 12;
    c.circle(x, y + 13, 13, water, 175);
    c.line(x, y - 9, x - 10, y + 12, 10, water, 175);
    c.line(x, y - 9, x + 10, y + 12, 10, water, 175);
  }
}

function drawChecklist(c, x, y, scale, accent) {
  c.roundRect(x, y, 170 * scale, 220 * scale, 20 * scale, white, 255);
  c.roundRect(x + 18 * scale, y + 22 * scale, 134 * scale, 18 * scale, 9 * scale, mix(accent, white, 0.55), 255);
  for (let i = 0; i < 4; i += 1) {
    const yy = y + (70 + i * 34) * scale;
    c.circle(x + 34 * scale, yy, 8 * scale, accent, 190);
    c.line(x + 28 * scale, yy, x + 33 * scale, yy + 6 * scale, 4 * scale, white, 255);
    c.line(x + 33 * scale, yy + 6 * scale, x + 45 * scale, yy - 8 * scale, 4 * scale, white, 255);
    c.roundRect(x + 58 * scale, yy - 6 * scale, 78 * scale, 12 * scale, 6 * scale, [203, 213, 225], 255);
  }
}

function drawArrowBox(c, accent) {
  c.roundRect(785, 402, 236, 128, 22, mix(accent, white, 0.7), 255);
  c.line(790, 402, 838, 356, 12, accent, 200);
  c.line(1020, 402, 968, 356, 12, accent, 200);
  c.line(838, 356, 968, 356, 12, accent, 200);
  c.line(902, 188, 902, 334, 18, accent, 220);
  c.line(902, 334, 862, 294, 18, accent, 220);
  c.line(902, 334, 942, 294, 18, accent, 220);
}

function drawAc(c, serviceName, accent) {
  c.roundRect(230, 212, 470, 168, 24, white, 255);
  c.roundRect(254, 236, 422, 54, 18, mix(accent, white, 0.88), 255);
  c.line(278, 320, 650, 320, 9, [203, 213, 225], 255);
  c.line(300, 350, 628, 350, 7, [203, 213, 225], 255);
  c.line(330, 380, 330, 460, 9, teal, 115);
  c.line(462, 380, 462, 476, 9, teal, 115);
  c.line(594, 380, 594, 455, 9, teal, 115);

  c.roundRect(768, 328, 210, 188, 28, mix(accent, white, 0.72), 255);
  c.roundRect(790, 350, 166, 145, 20, white, 225);
  c.circle(873, 422, 58, slate, 65);
  c.circle(873, 422, 35, accent, 180);
  c.line(873, 422, 873, 374, 8, slate, 150);
  c.line(873, 422, 918, 438, 8, slate, 150);
  c.line(873, 422, 832, 447, 8, slate, 150);

  if (/jet|water/i.test(serviceName)) drawDroplets(c, accent);
  else if (/install/i.test(serviceName)) {
    drawChecklist(c, 788, 176, 0.86, accent);
    c.line(752, 285, 900, 285, 10, accent, 210);
    c.line(900, 285, 948, 235, 10, accent, 210);
  } else if (/gas/i.test(serviceName)) {
    drawCylinder(c, 795, 245, 1, accent);
    c.line(860, 205, 700, 290, 8, slate, 170);
  } else if (/uninstall/i.test(serviceName)) {
    drawArrowBox(c, accent);
  }
  drawSparkles(c, accent);
}

function drawFridge(c, serviceName, accent) {
  c.roundRect(320, 150, 320, 450, 34, white, 255);
  c.roundRect(344, 176, 272, 148, 22, mix(accent, white, 0.82), 255);
  c.roundRect(344, 342, 272, 230, 22, mix(accent, white, 0.92), 255);
  c.line(591, 216, 591, 294, 9, slate, 180);
  c.line(591, 388, 591, 502, 9, slate, 180);
  c.roundRect(388, 208, 86, 40, 14, white, 200);

  if (/repair/i.test(serviceName)) drawWrench(c, 785, 382, 1.08, accent);
  else if (/gas/i.test(serviceName)) {
    drawCylinder(c, 792, 270, 1, accent);
    c.line(792, 370, 642, 405, 8, slate, 160);
  } else {
    drawChecklist(c, 792, 224, 1, accent);
    c.line(736, 525, 1010, 525, 9, accent, 180);
    c.line(812, 495, 960, 495, 6, slate, 130);
  }
  drawSparkles(c, accent);
}

function drawWasher(c, serviceName, accent) {
  c.roundRect(318, 162, 350, 410, 38, white, 255);
  c.roundRect(344, 190, 298, 74, 20, mix(accent, white, 0.82), 255);
  c.circle(493, 387, 126, mix(accent, white, 0.8), 255);
  c.circle(493, 387, 88, white, 235);
  c.circle(493, 404, 58, teal, 45);
  c.circle(585, 226, 18, white, 245);
  c.roundRect(376, 218, 114, 18, 9, white, 220);

  if (/repair/i.test(serviceName)) drawWrench(c, 790, 382, 1.05, accent);
  else if (/install/i.test(serviceName)) {
    c.line(712, 420, 820, 350, 14, accent, 190);
    c.line(820, 350, 965, 424, 14, accent, 190);
    c.roundRect(932, 360, 78, 112, 22, white, 250);
    c.line(970, 360, 970, 300, 10, slate, 180);
    c.circle(970, 286, 18, accent, 200);
  } else {
    for (let i = 0; i < 18; i += 1) {
      c.circle(778 + (i % 6) * 42, 232 + Math.floor(i / 6) * 58, 12 + (i % 3) * 4, teal, 110);
    }
    drawSparkles(c, accent);
  }
}

function drawMicrowave(c, serviceName, accent) {
  c.roundRect(250, 222, 540, 300, 34, white, 255);
  c.roundRect(286, 260, 330, 216, 24, mix(accent, white, 0.86), 255);
  c.roundRect(650, 260, 102, 216, 22, mix(slate, white, 0.86), 255);
  c.circle(701, 324, 24, white, 245);
  c.circle(701, 404, 24, white, 245);
  c.line(330, 304, 572, 448, 6, white, 120);
  c.line(340, 448, 560, 304, 5, white, 90);

  if (/repair/i.test(serviceName)) drawWrench(c, 846, 400, 0.95, accent);
  else {
    c.roundRect(852, 222, 170, 260, 26, white, 245);
    c.line(876, 282, 996, 282, 8, accent, 190);
    c.line(876, 360, 996, 360, 8, accent, 190);
    c.line(876, 438, 996, 438, 8, accent, 190);
    c.line(852, 482, 1022, 482, 12, slate, 110);
  }
  drawSparkles(c, accent);
}

function drawGeyser(c, serviceName, accent) {
  c.roundRect(360, 150, 286, 440, 80, white, 255);
  c.roundRect(395, 190, 216, 290, 58, mix(accent, white, 0.78), 255);
  c.circle(503, 520, 34, white, 255);
  c.line(466, 590, 466, 650, 12, teal, 145);
  c.line(540, 590, 540, 650, 12, red, 120);
  c.circle(466, 662, 16, teal, 130);
  c.circle(540, 662, 16, red, 100);

  if (/repair/i.test(serviceName)) drawWrench(c, 792, 382, 1.05, accent);
  else {
    c.line(746, 220, 998, 220, 13, accent, 190);
    c.line(746, 500, 998, 500, 13, accent, 190);
    c.line(802, 220, 802, 500, 8, slate, 120);
    c.line(942, 220, 942, 500, 8, slate, 120);
    for (let i = 0; i < 8; i += 1) c.circle(805 + i * 30, 580 - (i % 3) * 28, 12, teal, 95);
  }
  drawSparkles(c, accent);
}

function drawTv(c, accent) {
  c.roundRect(232, 170, 620, 350, 34, ink, 230);
  c.roundRect(262, 202, 560, 286, 20, mix(accent, white, 0.82), 255);
  c.line(542, 522, 542, 590, 14, slate, 170);
  c.line(450, 594, 634, 594, 14, slate, 170);
  c.line(850, 332, 1010, 258, 14, accent, 190);
  c.line(850, 332, 1010, 406, 14, accent, 190);
  c.roundRect(984, 238, 50, 188, 14, white, 250);
  c.line(288, 232, 790, 458, 5, white, 80);
  c.line(315, 456, 790, 232, 5, white, 70);
  drawSparkles(c, accent);
}

function drawService(service) {
  const accent = hexToRgb(service.category?.color || '#2F5FFF');
  const c = new Raster(WIDTH, HEIGHT);
  drawBase(c, accent);

  const category = (service.category?.name || '').toLowerCase();
  if (category.includes('air')) drawAc(c, service.name, accent);
  else if (category.includes('refrigerator')) drawFridge(c, service.name, accent);
  else if (category.includes('washing')) drawWasher(c, service.name, accent);
  else if (category.includes('microwave')) drawMicrowave(c, service.name, accent);
  else if (category.includes('geyser')) drawGeyser(c, service.name, accent);
  else if (category.includes('tv')) drawTv(c, accent);
  else drawChecklist(c, 500, 210, 1.2, accent);

  return encodePng(WIDTH, HEIGHT, c.data);
}

async function uploadImage(key, buffer) {
  const client = getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: 'image/png',
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
  return buildPublicUrl(key);
}

async function main() {
  if (!NO_UPLOAD && !isS3Configured()) {
    throw new Error('S3 is not configured. Run with --no-upload to only generate local files.');
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const prisma = new PrismaClient();

  try {
    const services = await prisma.service.findMany({
      where: ONLY_MISSING ? { imageUrl: null } : undefined,
      include: { category: { select: { id: true, name: true, color: true } } },
      orderBy: [{ category: { sortOrder: 'asc' } }, { createdAt: 'asc' }],
    });

    if (services.length === 0) {
      console.log('No services matched.');
      return;
    }

    for (const service of services) {
      const slug = slugify(service.name);
      const fileName = `${slug}.png`;
      const localPath = path.join(OUT_DIR, fileName);
      const buffer = drawService(service);
      await fs.writeFile(localPath, buffer);

      if (NO_UPLOAD) {
        console.log(`generated ${service.name}: ${localPath}`);
        continue;
      }

      const key = `services/generated/${service.id}-${fileName}`;
      const imageUrl = await uploadImage(key, buffer);
      await prisma.service.update({
        where: { id: service.id },
        data: { imageUrl },
      });
      console.log(`uploaded ${service.name}: ${imageUrl}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


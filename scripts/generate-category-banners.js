require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { PrismaClient } = require('@prisma/client');
const { getS3Client, isS3Configured, buildPublicUrl } = require('../src/config/s3');
const env = require('../src/config/env');

const WIDTH = 1200;
const HEIGHT = 675;
const OUT_DIR = path.join(__dirname, '..', 'generated', 'category-banners');

const args = new Set(process.argv.slice(2));
const NO_UPLOAD = args.has('--no-upload');
const ONLY_MISSING = args.has('--only-missing');

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND'),
  ]);
}

function hexToRgb(hex) {
  const value = (hex || '#2F5FFF').replace('#', '');
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

  gradient(accent) {
    const white = [255, 255, 255];
    const cool = [241, 245, 249];
    const soft = mix(white, accent, 0.18);
    const deep = mix(accent, [15, 23, 42], 0.2);
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const nx = x / this.width;
        const ny = y / this.height;
        const t = Math.min(1, nx * 0.35 + ny * 0.52);
        const glow = Math.max(0, 1 - Math.hypot(nx - 0.85, ny - 0.18) * 2.4);
        const base = mix(soft, cool, t);
        const color = mix(base, deep, glow * 0.22);
        const idx = (y * this.width + x) * 4;
        this.data[idx] = color[0];
        this.data[idx + 1] = color[1];
        this.data[idx + 2] = color[2];
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

const white = [255, 255, 255];
const ink = [15, 23, 42];
const slate = [71, 85, 105];
const border = [203, 213, 225];
const blue = [47, 95, 255];
const teal = [14, 165, 233];
const green = [16, 185, 129];
const amber = [245, 158, 11];
const red = [239, 68, 68];

function shell(c, accent) {
  c.gradient(accent);
  c.circle(1010, 80, 210, accent, 26);
  c.circle(120, 610, 250, mix(accent, white, 0.45), 22);
  c.roundRect(82, 76, 1036, 520, 48, ink, 18);
  c.roundRect(70, 64, 1036, 520, 48, white, 224);
  c.roundRect(130, 132, 24, 386, 12, accent, 230);
  c.ellipse(608, 555, 410, 44, ink, 26);
}

function sparkles(c, accent) {
  for (const [x, y, r] of [[895, 132, 25], [966, 208, 16], [836, 222, 12]]) {
    c.line(x - r, y, x + r, y, 5, accent, 185);
    c.line(x, y - r, x, y + r, 5, accent, 185);
    c.circle(x, y, 4, white, 240);
  }
}

function drawAc(c, accent) {
  c.roundRect(250, 190, 520, 170, 28, white, 255);
  c.roundRect(282, 222, 456, 58, 18, mix(accent, white, 0.84), 255);
  c.line(304, 306, 716, 306, 10, border, 255);
  c.line(332, 338, 688, 338, 7, border, 255);
  for (let i = 0; i < 5; i += 1) {
    const x = 350 + i * 78;
    c.line(x, 372, x, 492 - (i % 2) * 24, 10, teal, 125);
    c.circle(x, 372, 7, teal, 150);
  }
  for (let i = 0; i < 16; i += 1) {
    const x = 818 + (i % 5) * 44 + Math.floor(i / 5) * 12;
    const y = 228 + Math.floor(i / 5) * 56 + (i % 2) * 12;
    c.circle(x, y + 12, 12, teal, 160);
    c.line(x, y - 8, x - 9, y + 12, 9, teal, 160);
    c.line(x, y - 8, x + 9, y + 12, 9, teal, 160);
  }
}

function drawFridge(c, accent) {
  c.roundRect(340, 126, 318, 440, 34, white, 255);
  c.roundRect(366, 154, 266, 142, 22, mix(accent, white, 0.78), 255);
  c.roundRect(366, 316, 266, 222, 22, mix(accent, white, 0.9), 255);
  c.line(606, 192, 606, 270, 9, slate, 175);
  c.line(606, 366, 606, 482, 9, slate, 175);
  c.roundRect(780, 202, 230, 232, 38, mix(green, white, 0.78), 255);
  c.circle(840, 285, 38, green, 180);
  c.circle(910, 310, 48, green, 160);
  c.circle(864, 374, 32, amber, 160);
  c.line(815, 444, 990, 444, 12, slate, 120);
  sparkles(c, accent);
}

function drawWasher(c, accent) {
  c.roundRect(342, 142, 354, 406, 40, white, 255);
  c.roundRect(370, 172, 298, 76, 22, mix(accent, white, 0.82), 255);
  c.circle(520, 372, 126, mix(accent, white, 0.75), 255);
  c.circle(520, 372, 88, white, 235);
  c.circle(520, 390, 58, teal, 50);
  c.roundRect(402, 202, 120, 18, 9, white, 220);
  c.circle(610, 210, 18, white, 245);
  for (let i = 0; i < 22; i += 1) {
    c.circle(785 + (i % 6) * 42, 174 + Math.floor(i / 6) * 55, 11 + (i % 3) * 4, teal, 105);
  }
  sparkles(c, accent);
}

function drawMicrowave(c, accent) {
  c.roundRect(250, 214, 590, 292, 34, white, 255);
  c.roundRect(286, 252, 368, 212, 24, mix(accent, white, 0.84), 255);
  c.roundRect(694, 252, 108, 212, 22, mix(slate, white, 0.86), 255);
  c.circle(748, 318, 24, white, 245);
  c.circle(748, 398, 24, white, 245);
  c.line(338, 296, 610, 432, 6, white, 120);
  c.line(340, 430, 606, 294, 5, white, 100);
  for (let i = 0; i < 4; i += 1) {
    c.line(885 + i * 34, 268, 910 + i * 34, 298, 7, red, 110);
    c.line(910 + i * 34, 298, 885 + i * 34, 328, 7, red, 110);
  }
  sparkles(c, accent);
}

function drawGeyser(c, accent) {
  c.roundRect(382, 120, 300, 430, 82, white, 255);
  c.roundRect(420, 160, 224, 282, 58, mix(accent, white, 0.78), 255);
  c.circle(532, 490, 34, white, 255);
  c.line(494, 548, 494, 618, 12, teal, 145);
  c.line(570, 548, 570, 618, 12, red, 115);
  for (let i = 0; i < 10; i += 1) {
    c.circle(790 + i * 27, 420 - (i % 4) * 34, 13, teal, 105);
  }
  c.line(758, 204, 1016, 204, 13, accent, 185);
  c.line(758, 474, 1016, 474, 13, accent, 185);
  c.line(822, 204, 822, 474, 8, slate, 120);
  c.line(952, 204, 952, 474, 8, slate, 120);
  sparkles(c, accent);
}

function drawTv(c, accent) {
  c.roundRect(236, 152, 648, 350, 34, ink, 228);
  c.roundRect(268, 186, 584, 280, 20, mix(accent, white, 0.8), 255);
  c.line(560, 504, 560, 580, 14, slate, 170);
  c.line(462, 584, 658, 584, 14, slate, 170);
  c.line(884, 324, 1030, 252, 14, accent, 190);
  c.line(884, 324, 1030, 402, 14, accent, 190);
  c.roundRect(1006, 232, 54, 190, 14, white, 250);
  c.line(298, 222, 820, 434, 5, white, 80);
  c.line(326, 432, 816, 222, 5, white, 75);
  sparkles(c, accent);
}

function drawGeneric(c, accent) {
  c.roundRect(360, 160, 360, 330, 44, white, 255);
  for (let i = 0; i < 4; i += 1) {
    const y = 226 + i * 58;
    c.circle(420, y, 16, accent, 190);
    c.line(412, y, 420, y + 9, 5, white, 255);
    c.line(420, y + 9, 438, y - 12, 5, white, 255);
    c.roundRect(470, y - 10, 178, 20, 10, border, 245);
  }
  sparkles(c, accent);
}

function drawCategory(category) {
  const accent = hexToRgb(category.color);
  const c = new Raster(WIDTH, HEIGHT);
  shell(c, accent);

  const name = category.name.toLowerCase();
  if (name.includes('air') || name.includes('ac')) drawAc(c, accent);
  else if (name.includes('refrigerator')) drawFridge(c, accent);
  else if (name.includes('washing')) drawWasher(c, accent);
  else if (name.includes('microwave')) drawMicrowave(c, accent);
  else if (name.includes('geyser')) drawGeyser(c, accent);
  else if (name.includes('tv')) drawTv(c, accent);
  else drawGeneric(c, accent);

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
    const categories = await prisma.category.findMany({
      where: ONLY_MISSING ? { bannerImageUrl: null } : undefined,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    if (categories.length === 0) {
      console.log('No categories matched.');
      return;
    }

    for (const category of categories) {
      const slug = slugify(category.name);
      const localFileName = `${slug}-${category.id.slice(0, 8)}.png`;
      const localPath = path.join(OUT_DIR, localFileName);
      const buffer = drawCategory(category);
      await fs.writeFile(localPath, buffer);

      if (NO_UPLOAD) {
        console.log(`generated ${category.name}: ${localPath}`);
        continue;
      }

      const key = `categories/generated/${category.id}-${slug}.png`;
      const bannerImageUrl = await uploadImage(key, buffer);
      await prisma.category.update({
        where: { id: category.id },
        data: { bannerImageUrl },
      });
      console.log(`uploaded ${category.name}: ${bannerImageUrl}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

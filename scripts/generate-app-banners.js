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
const OUT_DIR = path.join(__dirname, '..', 'generated', 'app-banners');

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
    const soft = mix(white, accent, 0.22);
    const deep = mix(accent, [15, 23, 42], 0.26);
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const nx = x / this.width;
        const ny = y / this.height;
        const t = Math.min(1, nx * 0.24 + ny * 0.44);
        const glow = Math.max(0, 1 - Math.hypot(nx - 0.85, ny - 0.14) * 2.25);
        const base = mix(soft, cool, t);
        const color = mix(base, deep, glow * 0.25);
        const idx = (y * this.width + x) * 4;
        this.data[idx] = color[0];
        this.data[idx + 1] = color[1];
        this.data[idx + 2] = color[2];
        this.data[idx + 3] = 255;
      }
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
  c.circle(1008, 72, 220, accent, 30);
  c.circle(145, 614, 260, mix(accent, white, 0.48), 24);
  c.roundRect(78, 70, 1044, 526, 52, ink, 20);
  c.roundRect(66, 58, 1044, 526, 52, white, 228);
  c.roundRect(126, 126, 24, 392, 12, accent, 225);
  c.ellipse(620, 558, 430, 44, ink, 28);
}

function sparkles(c, accent) {
  for (const [x, y, r] of [[894, 132, 24], [970, 215, 16], [838, 224, 12]]) {
    c.line(x - r, y, x + r, y, 5, accent, 185);
    c.line(x, y - r, x, y + r, 5, accent, 185);
    c.circle(x, y, 4, white, 240);
  }
}

function drawPhoneBooking(c, accent) {
  c.roundRect(276, 122, 250, 430, 40, ink, 225);
  c.roundRect(294, 154, 214, 358, 26, white, 255);
  c.roundRect(328, 198, 146, 18, 9, mix(accent, white, 0.64), 255);
  for (let i = 0; i < 4; i += 1) {
    const y = 254 + i * 56;
    c.circle(340, y, 15, accent, 170);
    c.roundRect(374, y - 12, 98, 12, 6, border, 245);
    c.roundRect(374, y + 10, 74, 10, 5, mix(border, white, 0.18), 245);
  }
  c.circle(402, 534, 13, slate, 140);

  c.roundRect(652, 180, 310, 260, 42, white, 250);
  c.roundRect(690, 222, 236, 36, 18, mix(accent, white, 0.74), 255);
  c.line(704, 302, 908, 302, 8, border, 250);
  c.line(704, 342, 858, 342, 8, border, 250);
  c.line(704, 386, 788, 386, 8, accent, 170);
  c.line(788, 386, 838, 336, 8, accent, 170);
  sparkles(c, accent);
}

function drawAc(c, accent) {
  c.roundRect(248, 190, 520, 170, 28, white, 255);
  c.roundRect(282, 222, 454, 58, 18, mix(accent, white, 0.84), 255);
  c.line(302, 306, 716, 306, 10, border, 255);
  c.line(332, 338, 688, 338, 7, border, 255);
  for (let i = 0; i < 5; i += 1) {
    const x = 350 + i * 78;
    c.line(x, 372, x, 492 - (i % 2) * 24, 10, teal, 125);
    c.circle(x, 372, 7, teal, 150);
  }
  for (let i = 0; i < 16; i += 1) {
    const x = 812 + (i % 5) * 44 + Math.floor(i / 5) * 12;
    const y = 230 + Math.floor(i / 5) * 56 + (i % 2) * 12;
    c.circle(x, y + 12, 12, teal, 160);
    c.line(x, y - 8, x - 9, y + 12, 9, teal, 160);
    c.line(x, y - 8, x + 9, y + 12, 9, teal, 160);
  }
  sparkles(c, accent);
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

function drawGeyser(c, accent) {
  c.roundRect(382, 120, 300, 430, 82, white, 255);
  c.roundRect(420, 160, 224, 282, 58, mix(accent, white, 0.78), 255);
  c.circle(532, 490, 34, white, 255);
  c.line(494, 548, 494, 618, 12, teal, 145);
  c.line(570, 548, 570, 618, 12, red, 115);
  c.line(758, 204, 1016, 204, 13, accent, 185);
  c.line(758, 474, 1016, 474, 13, accent, 185);
  c.line(822, 204, 822, 474, 8, slate, 120);
  c.line(952, 204, 952, 474, 8, slate, 120);
  for (let i = 0; i < 10; i += 1) c.circle(790 + i * 27, 420 - (i % 4) * 34, 13, teal, 105);
  sparkles(c, accent);
}

function drawBanner(banner) {
  const title = banner.title.toLowerCase();
  const accent = hexToRgb(banner.backgroundColor || '#2F5FFF');
  const c = new Raster(WIDTH, HEIGHT);
  shell(c, accent);

  if (title.includes('home services')) drawPhoneBooking(c, accent);
  else if (title.includes('ac') || title.includes('jet') || title.includes('foam')) drawAc(c, accent);
  else if (title.includes('refrigerator')) drawFridge(c, accent);
  else if (title.includes('geyser')) drawGeyser(c, accent);
  else drawPhoneBooking(c, accent);

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
    const banners = await prisma.appBanner.findMany({
      where: ONLY_MISSING ? { imageUrl: null } : undefined,
      orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    if (banners.length === 0) {
      console.log('No banners matched.');
      return;
    }

    for (const banner of banners) {
      const placement = banner.placement.toLowerCase().replace(/_/g, '-');
      const slug = slugify(banner.title);
      const idPart = String(banner.id).slice(0, 8);
      const localFileName = `${placement}-${slug}-${idPart}.png`;
      const localPath = path.join(OUT_DIR, localFileName);
      const buffer = drawBanner(banner);
      await fs.writeFile(localPath, buffer);

      if (NO_UPLOAD) {
        console.log(`generated ${banner.placement} ${banner.title}: ${localPath}`);
        continue;
      }

      const key = `banners/generated/${banner.id}-${placement}-${slug}.png`;
      const imageUrl = await uploadImage(key, buffer);
      await prisma.appBanner.update({
        where: { id: banner.id },
        data: { imageUrl },
      });
      console.log(`uploaded ${banner.placement} ${banner.title}: ${imageUrl}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

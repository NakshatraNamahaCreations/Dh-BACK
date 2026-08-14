/**
 * Render the extracted API surface (scripts/extract-api.js) as a PDF
 * reference: cover page, per-group summary, then every endpoint with its
 * method, path, required access level, permission and request schema.
 *
 * Run:  node scripts/generate-api-doc.js
 * Out:  docs/Dhoond-API-Reference.pdf
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { extract } = require('./extract-api');

const OUT_DIR = path.join(__dirname, '..', '..', '..', 'docs');
const OUT = path.join(OUT_DIR, 'Dhoond-API-Reference.pdf');
const LOGO = path.join(__dirname, '..', 'src', 'assets', 'dhoond-logo.png');

const BRAND = '#1E99FE';
const INK = '#1c1c1c';
const SOFT = '#5f6672';
const RULE = '#e2e6ec';

/// Method → colour, so the eye can scan for writes vs reads.
const METHOD_COLOR = {
  GET: '#1F8F6A',
  POST: '#1E70E0',
  PUT: '#B7791F',
  PATCH: '#B7791F',
  DELETE: '#C13C32',
};

/// Access level → colour. Public is called out in amber because those are
/// the endpoints reachable without any token.
const ACCESS_COLOR = {
  Public: '#B7791F',
  Customer: '#1E70E0',
  Partner: '#7C3AED',
  Admin: '#C13C32',
  Authenticated: '#5f6672',
};

const MARGIN = 44;
const PAGE_W = 595;
const RIGHT = PAGE_W - MARGIN;

const groups = extract();
const total = groups.reduce((n, g) => n + g.endpoints.length, 0);

const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
doc.pipe(fs.createWriteStream(OUT));

// ── Cover ──────────────────────────────────────────────────────────────
if (fs.existsSync(LOGO)) doc.image(LOGO, MARGIN, 90, { height: 34 });
doc.font('Helvetica-Bold').fontSize(30).fillColor(INK).text('API Reference', MARGIN, 150);
doc.font('Helvetica').fontSize(11).fillColor(SOFT)
   .text('Dhoond backend — complete HTTP endpoint listing', MARGIN, 188);

doc.moveTo(MARGIN, 214).lineTo(RIGHT, 214).strokeColor(BRAND).lineWidth(2).stroke();

doc.font('Helvetica').fontSize(10).fillColor(INK).text('', MARGIN, 236);
const coverRow = (k, v) => {
  doc.font('Helvetica-Bold').fontSize(10).fillColor(SOFT).text(k, MARGIN, doc.y, { continued: true });
  doc.font('Helvetica').fillColor(INK).text('   ' + v);
  doc.moveDown(0.45);
};
coverRow('Base URL', 'https://dhoond.nakshatranamahacreations.in/api/v1');
coverRow('Endpoints', String(total));
coverRow('Route groups', String(groups.length));
coverRow('Auth', 'Bearer JWT in the Authorization header (except Public routes)');
coverRow('Generated', new Date().toLocaleDateString('en-IN', {
  day: '2-digit', month: 'short', year: 'numeric',
}));

doc.moveDown(1);
doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('Access levels', MARGIN, doc.y);
doc.moveDown(0.4);
[
  ['Public', 'No token required — login/OTP, catalog reads, provider webhooks.'],
  ['Customer', 'Customer JWT (requireType CUSTOMER).'],
  ['Partner', 'Partner JWT (requireType PARTNER).'],
  ['Admin', 'Admin JWT; many also require a named permission.'],
  ['Authenticated', 'Any valid token, type not restricted.'],
].forEach(([level, note]) => {
  doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCESS_COLOR[level])
     .text(level.padEnd(15), MARGIN + 6, doc.y, { continued: true, width: 110 });
  doc.font('Helvetica').fontSize(9).fillColor(SOFT).text('  ' + note);
  doc.moveDown(0.3);
});

doc.moveDown(1);
doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('Contents', MARGIN, doc.y);
doc.moveDown(0.4);
/// Two-column contents list so all groups fit without a second cover page.
const half = Math.ceil(groups.length / 2);
const contentsTop = doc.y;
groups.forEach((g, i) => {
  const col = i < half ? 0 : 1;
  const x = MARGIN + 6 + col * 250;
  const y = contentsTop + (i % half) * 14;
  doc.font('Helvetica').fontSize(9).fillColor(INK)
     .text(`${g.prefix}`, x, y, { width: 190, ellipsis: true, continued: true });
  doc.fillColor(SOFT).text(`  (${g.endpoints.length})`);
});

// ── Endpoint pages ─────────────────────────────────────────────────────
const ensureRoom = (needed) => {
  if (doc.y + needed > 780) doc.addPage();
};

let drawn = 0;
groups.forEach((g) => {
  doc.addPage();

  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(g.prefix, MARGIN, MARGIN);
  doc.font('Helvetica').fontSize(9).fillColor(SOFT)
     .text(`${g.endpoints.length} endpoint${g.endpoints.length === 1 ? '' : 's'}  ·  ${g.file}`);
  doc.moveTo(MARGIN, doc.y + 6).lineTo(RIGHT, doc.y + 6).strokeColor(BRAND).lineWidth(1.5).stroke();
  doc.moveDown(1.1);

  g.endpoints.forEach((e) => {
    ensureRoom(56);
    const top = doc.y;

    /// Method chip
    const label = e.method;
    doc.font('Helvetica-Bold').fontSize(8);
    const w = Math.max(doc.widthOfString(label) + 12, 42);
    doc.roundedRect(MARGIN, top, w, 14, 3).fill(METHOD_COLOR[e.method] || SOFT);
    doc.fillColor('#fff').text(label, MARGIN, top + 3.5, { width: w, align: 'center' });

    /// Path
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
       .text(e.path, MARGIN + w + 8, top + 2, { width: RIGHT - MARGIN - w - 90 });

    /// Access level, right-aligned on the same row
    doc.font('Helvetica-Bold').fontSize(8).fillColor(ACCESS_COLOR[e.access] || SOFT)
       .text(e.access, RIGHT - 88, top + 3, { width: 88, align: 'right' });

    let y = Math.max(doc.y, top + 16);

    if (e.description) {
      doc.font('Helvetica').fontSize(8.5).fillColor(SOFT)
         .text(e.description, MARGIN + 4, y + 1, { width: RIGHT - MARGIN - 8 });
      y = doc.y;
    }

    const meta = [];
    if (e.permission) meta.push(`permission: ${e.permission}`);
    if (e.schema) meta.push(`validates: ${e.schema}`);
    if (meta.length) {
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#8a919c')
         .text(meta.join('   ·   '), MARGIN + 4, y + 1, { width: RIGHT - MARGIN - 8 });
      y = doc.y;
    }

    doc.moveTo(MARGIN, y + 5).lineTo(RIGHT, y + 5).strokeColor(RULE).lineWidth(0.5).stroke();
    doc.y = y + 11;
    drawn += 1;
  });
});

// ── Footers ────────────────────────────────────────────────────────────
const range = doc.bufferedPageRange();
for (let i = 0; i < range.count; i += 1) {
  doc.switchToPage(range.start + i);
  doc.font('Helvetica').fontSize(7.5).fillColor('#9aa1ad')
     .text('Dhoond API Reference', MARGIN, 800, { width: 200 })
     .text(`${i + 1} / ${range.count}`, RIGHT - 100, 800, { width: 100, align: 'right' });
}

doc.end();
console.log(
  `writing ${OUT} — ${drawn}/${total} endpoints drawn, ` +
  `${groups.length} groups, ${range.count} pages`,
);

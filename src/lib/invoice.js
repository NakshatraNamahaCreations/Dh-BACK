/**
 * Invoice generator — GST-compliant PDF (pdfkit) + HTML email body.
 *
 * Breakdown model (from business design):
 *   grandTotal is split 20% Dhoond / 80% Partner.
 *
 *   Dhoond portion (20%):
 *     gross  = grandTotal × 20%
 *     CGST   = gross × 9%
 *     SGST   = gross × 9%
 *     net    = gross − CGST − SGST          (18% total GST)
 *
 *   Partner portion (80%):
 *     gross  = grandTotal × 80%
 *     CGST   = gross × 2.5%
 *     SGST   = gross × 2.5%
 *     credited = gross − CGST − SGST        (5% total GST)
 *
 * SAC codes:
 *   999799 — Convenience & Platform Fee
 *   998539 — Home / cleaning services
 */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const env = require('../config/env');

/// Blue Dhoond wordmark for the invoice header (760px wide, ~52 KB).
/// Regenerate from dhoond-customer/src/assets/Images/Blue-Logo.png if the
/// brand mark changes. The generator falls back to a text wordmark when
/// the file is missing so invoice generation can never crash on assets.
const LOGO_PATH = path.resolve(__dirname, '..', 'assets', 'dhoond-logo.png');

// ── Constants ─────────────────────────────────────────────────────────────

const DHOOND_SHARE = 0.20;   // 20% to Dhoond
const PARTNER_SHARE = 0.80;  // 80% to Partner

const DHOOND_GST_RATE = 0.18;    // 18% on platform fee
const PARTNER_GST_RATE = 0.05;   // 5%  on service charges

const SAC_SERVICE  = '998539';   // Home / cleaning services
const SAC_PLATFORM = '999799';   // Convenience & platform fee

// ── Math helpers ──────────────────────────────────────────────────────────

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Derive the full breakdown from the booking's grandTotal.
 * All amounts are in whole rupees (Int), matching Prisma storage.
 *
 * The partner/Dhoond split comes from the CATEGORY's commission rule
 * when the caller resolved one onto the booking (`partnerCommissionPct`,
 * e.g. 80 = partner keeps 80%). Callers that don't resolve it fall back
 * to the default 80/20. GST rates (5% partner / 18% Dhoond) are fixed
 * regardless of the split.
 */
const breakdown = (booking) => {
  const total = booking.grandTotal || booking.total || 0;
  const pct = Number(booking.partnerCommissionPct);
  const partnerShare = Number.isFinite(pct) && pct > 0 && pct < 100 ? pct / 100 : PARTNER_SHARE;
  const dhoondShare = 1 - partnerShare;

  const partnerGross   = r2(total * partnerShare);
  const partnerCGST    = r2(partnerGross * (PARTNER_GST_RATE / 2));  // 2.5%
  const partnerSGST    = partnerCGST;
  const partnerGST     = r2(partnerCGST + partnerSGST);              // 5%
  const partnerNet     = r2(partnerGross - partnerGST);              // credited to partner

  const dhoondGross    = r2(total * dhoondShare);
  const dhoondCGST     = r2(dhoondGross * (DHOOND_GST_RATE / 2));   // 9%
  const dhoondSGST     = dhoondCGST;
  const dhoondGST      = r2(dhoondCGST + dhoondSGST);               // 18%
  const dhoondNet      = r2(dhoondGross - dhoondGST);               // Dhoond after tax

  return {
    total,
    partnerGross, partnerCGST, partnerSGST, partnerGST, partnerNet,
    dhoondGross,  dhoondCGST,  dhoondSGST,  dhoondGST,  dhoondNet,
  };
};

// ── Misc helpers ──────────────────────────────────────────────────────────

const fmtRs = (n) => `Rs. ${Number(n ?? 0).toFixed(2)}`;
const fmtRsInt = (n) => `Rs. ${Number(n ?? 0)}`;

const invoiceNumber = (booking) => booking.bookingRef ?? `DHND-${booking.id}`;

const invoiceDate = (booking) => {
  const d = booking.paidAt ?? booking.createdAt ?? new Date();
  return new Date(d).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
};

const deliveryAddress = (booking) =>
  booking.customerAddress?.addressLine ?? booking.addressLine ?? 'Address not provided';

// ── Amount in words (Indian format, Urban-Company style) ─────────────────
//   488.5  →  "four hundred and eighty eight point five only"

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
  'eighty', 'ninety'];

const below100 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);

const intToWords = (n) => {
  if (n === 0) return 'zero';
  const parts = [];
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const hundred = Math.floor((n % 1000) / 100);
  const rest = n % 100;
  if (crore) parts.push(`${intToWords(crore)} crore`);
  if (lakh) parts.push(`${below100(lakh)} lakh`);
  if (thousand) parts.push(`${below100(thousand)} thousand`);
  if (hundred) parts.push(`${ONES[hundred]} hundred`);
  if (rest) parts.push(`${parts.length ? 'and ' : ''}${below100(rest)}`);
  return parts.join(' ');
};

const amountInWords = (n) => {
  const [int, dec] = Number(n ?? 0).toFixed(2).replace(/\.?0+$/, '').split('.');
  let words = intToWords(Number(int));
  if (dec) words += ` point ${[...dec].map((d) => ONES[Number(d)] || 'zero').join(' ')}`;
  return `(${words} only)`;
};

// ── PDF (pdfkit) — Urban-Company style tax invoice ────────────────────────

const MARGIN  = 40;
const PAGE_W  = 595;               // A4 pt width
const RIGHT_X = PAGE_W - MARGIN;   // right content edge
const COL_L_X = MARGIN;            // left info column
const COL_L_W = 250;
const COL_R_X = 330;               // right info column
const COL_R_W = RIGHT_X - COL_R_X;
const AMT_LBL_X = 300;             // labels of the amount stack
const INK    = '#1c1c1c';
const SOFT   = '#6f6f6f';
const FAINT  = '#a5a5a5';
const RULE   = '#dedede';
const BAND   = '#f4f4f4';

/**
 * Shared renderer for both documents — the Urban-Company "To (Recipient) /
 * From (Supplier)" layout the client signed off on (see the 26INU / 26INP
 * samples): logo top-left, badge top-right, two underlined info columns,
 * an "Items | Amount" band, one item block with an amount stack, and a
 * Subtotal band. `spec` carries everything that differs between the two.
 */
const renderDoc = (booking, spec) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Header: logo + badge ──────────────────────────────────────────
    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, MARGIN, MARGIN, { height: 26 });
    } else {
      doc.font('Helvetica-Bold').fontSize(21).fillColor('#1E99FE').text('Dhoond', MARGIN, MARGIN);
    }
    /// Badge — bordered pill, right-aligned (UC style).
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK);
    const bw = doc.widthOfString(spec.badge) + 24;
    doc.roundedRect(RIGHT_X - bw, MARGIN - 2, bw, 26, 4).strokeColor(RULE).lineWidth(1).stroke();
    doc.text(spec.badge, RIGHT_X - bw + 12, MARGIN + 6);

    // ── To / From columns ─────────────────────────────────────────────
    const infoTop = MARGIN + 56;
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor(INK).text('To (Recipient)', COL_L_X, infoTop);
    doc.text('From (Supplier)', COL_R_X, infoTop);
    let yL = infoTop + 24;
    for (const [label, value] of spec.recipient) {
      yL = field(doc, COL_L_X, COL_L_W, label, value, yL);
    }
    let yR = infoTop + 24;
    for (const [label, value] of spec.supplier) {
      yR = field(doc, COL_R_X, COL_R_W, label, value, yR);
    }

    // ── Items band ────────────────────────────────────────────────────
    let y = Math.max(yL, yR) + 16;
    y = band(doc, y, 'Items', 'Amount');
    y += 16;

    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK)
       .text(spec.itemTitle, MARGIN, y, { width: 250 });
    doc.font('Helvetica').fontSize(8).fillColor(FAINT)
       .text(`SAC: ${spec.sac}`, MARGIN, doc.y + 2);

    for (const [i, [label, value, words]] of spec.rows.entries()) {
      y = amount(doc, i === 0 ? y : y + 12, label, value, words);
    }

    // ── Subtotal band ─────────────────────────────────────────────────
    y += 14;
    band(doc, y, 'Subtotal', spec.subtotal, 11);

    // ── Signature (documents issued by Dhoond carry one) ──────────────
    if (spec.signature) {
      y += 40;
      /// Signatory image (admin-uploaded) sits above the caption, right-
      /// aligned like the UC sample's handwritten scrawl. Height-capped;
      /// pdfkit keeps the aspect ratio. Absent → just the text block.
      if (spec.signatureImage) {
        try {
          doc.image(spec.signatureImage, RIGHT_X - 160, y, { fit: [160, 44], align: 'right' });
          y += 50;
        } catch {
          /* corrupt/unsupported image — fall through to text-only */
        }
      }
      doc.font('Helvetica-BoldOblique').fontSize(10).fillColor(INK)
         .text(`For ${spec.signature}`, RIGHT_X - 260, y, { width: 260, align: 'right' });
      doc.font('Helvetica').fontSize(8.5).fillColor(INK)
         .text('Signature of supplier/authorized representative',
               RIGHT_X - 260, y + 26, { width: 260, align: 'right' });
    }

    doc.fontSize(7).font('Helvetica').fillColor(SOFT)
       .text('*Reverse Charge mechanism not applicable', MARGIN, 764)
       .text('*This is a computer-generated document and does not require a physical signature.')
       .text('*For support write to support@dhoond.co');

    doc.end();
  });

const fmtInr = (n) => `INR ${Number(n ?? 0).toFixed(2).replace(/\.00$/, '')}`;

/// Admin-configurable company / GST details (admin → Policy → Company),
/// falling back to env when nothing was ever saved or the DB is down —
/// invoice generation must never crash on identity data.
const loadCompany = async () => {
  try {
    const policy = require('../modules/policy/policy.service');
    const c = await policy.getCompanyDetails();
    return {
      name: c?.name || env.COMPANY_NAME,
      gstin: c?.gstin || env.COMPANY_GSTIN || 'Applied For',
      address: c?.address || env.COMPANY_ADDRESS,
      stateNameCode: c?.stateNameCode || 'Karnataka 29',
      signatureUrl: c?.signatureUrl || null,
    };
  } catch {
    return {
      name: env.COMPANY_NAME,
      gstin: env.COMPANY_GSTIN || 'Applied For',
      address: env.COMPANY_ADDRESS,
      stateNameCode: 'Karnataka 29',
      signatureUrl: null,
    };
  }
};

/// Fetch the signatory image for embedding. Best-effort with a short
/// timeout — a slow/broken S3 URL degrades to the plain signature line,
/// never a failed invoice.
const fetchSignatureImage = async (url) => {
  if (!url) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    /// pdfkit can only embed PNG/JPEG — but the admin upload pipeline
    /// compresses images to AVIF/WebP, so normalise EVERYTHING to PNG
    /// (sharp keeps the transparency). Without this the .avif signature
    /// threw inside doc.image and the invoice silently fell back to the
    /// text-only block.
    try {
      const sharp = require('sharp');
      return await sharp(buf).png().toBuffer();
    } catch {
      /// sharp unavailable/decode failed — pass through and hope the
      /// buffer is already PNG/JPEG; renderDoc guards the draw anyway.
      return buf;
    }
  } catch {
    return null;
  }
};

const recipientFields = (booking, noLabel, noValue) => {
  const customer = booking.customer ?? {};
  return [
    ['Name', customer.name ?? 'Customer'],
    [noLabel, noValue],
    ['Delivery Address', deliveryAddress(booking)],
    ['Date', invoiceDate(booking)],
    ['State Name & Code', 'Karnataka 29'],
    ['Place of Supply', 'Karnataka 29'],
  ];
};

/**
 * Document 1 — Dhoond TAX INVOICE (customer-facing): the 20% convenience
 * & platform fee slice with 18% GST carved out of it, per the agreed
 * formula (499 → 99.80 = 81.84 taxable + 8.98 CGST + 8.98 SGST).
 */
const generateCustomerInvoicePdf = async (booking) => {
  const bd = breakdown(booking);
  const firstService = booking.items?.[0]?.service?.name;
  const company = await loadCompany();
  const signatureImage = await fetchSignatureImage(company.signatureUrl);
  return renderDoc(booking, {
    badge: 'TAX INVOICE',
    recipient: recipientFields(booking, 'Invoice No.', `${invoiceNumber(booking)}-F`),
    supplier: [
      ['Name', company.name],
      ['Business GST', company.gstin],
      ['Address', company.address],
      ['State Name & Code', company.stateNameCode],
    ],
    itemTitle: `Convenience Fee & Platform Fee${firstService ? ` - ${firstService}` : ''}`,
    sac: SAC_PLATFORM,
    rows: [
      ['Gross Amount', fmtInr(bd.dhoondNet)],
      ['Discount', `- ${fmtInr(0)}`],
      ['Taxable Amount', fmtInr(bd.dhoondNet), amountInWords(bd.dhoondNet)],
      ['CGST @9%', fmtInr(bd.dhoondCGST)],
      ['SGST @9%', fmtInr(bd.dhoondSGST)],
      ['Total Tax', fmtInr(bd.dhoondGST), amountInWords(bd.dhoondGST)],
    ],
    subtotal: fmtInr(bd.dhoondGross),
    signature: company.name,
    signatureImage,
  });
};

/**
 * Document 2 — PARTNER RECEIPT (customer-facing, issued on behalf of the
 * service partner): the 80% service-charge slice. Like the UC sample, a
 * plain receipt — gross / discount / subtotal, no tax lines (the 5%
 * carve-out is payout bookkeeping between Dhoond and the partner, not a
 * tax the customer is charged on this document).
 */
const generatePartnerReceiptPdf = (booking) => {
  const bd = breakdown(booking);
  const firstService = booking.items?.[0]?.service?.name;
  const partner = booking.partner ?? {};
  const partnerAddress =
    partner.document?.aadharAddress ?? [partner.city, 'Karnataka'].filter(Boolean).join(', ');
  return renderDoc(booking, {
    badge: 'RECEIPT (PARTNER RECEIPT)',
    recipient: recipientFields(booking, 'Receipt No.', `${invoiceNumber(booking)}-S`),
    supplier: [
      ['Name', partner.name ?? partner.businessName ?? 'Service Partner'],
      ['Business GST', ''],
      ['Address', partnerAddress || '—'],
      ['State Name & Code', 'Karnataka 29'],
    ],
    itemTitle: `Service Charge${firstService ? ` - ${firstService}` : ''}`,
    sac: SAC_SERVICE,
    rows: [
      ['Gross Amount', fmtInr(bd.partnerGross)],
      ['Discount', `- ${fmtInr(0)}`],
    ],
    subtotal: fmtInr(bd.partnerGross),
    signature: null,
  });
};

/// Back-compat alias — older call sites get the Dhoond tax invoice.
const generateInvoicePdf = generateCustomerInvoicePdf;

// ── PDF draw helpers ──────────────────────────────────────────────────────

/// One underlined label/value pair (Urban-Company style): bold label,
/// value below, thin rule under the pair. Returns the y for the next field.
function field(doc, x, w, label, value, y) {
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(label, x, y, { width: w });
  doc.font('Helvetica').fontSize(9).fillColor(INK)
     .text(String(value), x, doc.y + 2.5, { width: w });
  const lineY = doc.y + 5;
  doc.moveTo(x, lineY).lineTo(x + w, lineY).strokeColor(RULE).lineWidth(0.6).stroke();
  return lineY + 10;
}

/// Full-width grey band with a left + right bold label (section headers and
/// the TOTAL row). Returns the band's bottom y.
function band(doc, y, left, right, size = 10) {
  const h = size + 12;
  doc.rect(MARGIN - 6, y - 6, RIGHT_X - MARGIN + 12, h).fill(BAND);
  doc.font('Helvetica-Bold').fontSize(size).fillColor(INK)
     .text(left, MARGIN, y)
     .text(right, AMT_LBL_X, y, { width: RIGHT_X - AMT_LBL_X, align: 'right' });
  return y + h - 6;
}

/// One row of the amount stack: label at the centre column, amount right-
/// aligned, optional grey amount-in-words line underneath. Returns next y.
function amount(doc, y, label, amt, words) {
  doc.font('Helvetica').fontSize(9.5).fillColor(INK)
     .text(label, AMT_LBL_X, y)
     .text(amt, AMT_LBL_X, y, { width: RIGHT_X - AMT_LBL_X, align: 'right' });
  let next = y + 13;
  if (words) {
    doc.font('Helvetica').fontSize(7.5).fillColor(FAINT)
       .text(words, RIGHT_X - 190, next, { width: 190, align: 'right' });
    next = doc.y + 2;
  }
  return next;
}

// ── HTML email body ────────────────────────────────────────────────────────

const buildInvoiceEmailHtml = (booking) => {
  const co     = env.COMPANY_NAME;
  const coAddr = env.COMPANY_ADDRESS;
  const coGstin = env.COMPANY_GSTIN ?? 'Applied For';
  const customer = booking.customer ?? {};
  const bd = breakdown(booking);
  const invNo  = invoiceNumber(booking);
  const invDate = invoiceDate(booking);
  const addr   = deliveryAddress(booking);

  const itemRows = (booking.items ?? []).map((it) => {
    const lineTotal = (it.qty ?? 1) * (it.basePrice ?? 0);
    return `<tr>
      <td style="padding:8px 10px;font-size:13px;border-bottom:1px solid #f3f3f3;">
        ${it.service?.name ?? 'Service'} &nbsp;<span style="color:#888;font-size:11px;">×${it.qty ?? 1}</span>
      </td>
      <td style="padding:8px 10px;text-align:right;font-size:13px;border-bottom:1px solid #f3f3f3;">
        Rs. ${lineTotal}
      </td>
    </tr>`;
  }).join('');

  const sectionRow = (label, value, sub = false) => `
    <tr>
      <td style="padding:5px 10px;font-size:${sub ? 11 : 12}px;color:${sub ? '#666' : '#222'};">${label}</td>
      <td style="padding:5px 10px;text-align:right;font-size:${sub ? 11 : 12}px;color:${sub ? '#666' : '#222'};">${value}</td>
    </tr>`;

  const sectionTotal = (label, value) => `
    <tr style="background:#f0f4ff;">
      <td style="padding:8px 10px;font-size:12px;font-weight:700;color:#1a1a2e;">${label}</td>
      <td style="padding:8px 10px;text-align:right;font-size:12px;font-weight:700;color:#1a1a2e;">${value}</td>
    </tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dhoond Invoice — ${invNo}</title></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;background:#f4f4f7;">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.09);">

  <!-- ── Header ── -->
  <tr style="background:#1a1a2e;">
    <td style="padding:22px 30px;">
      <table width="100%"><tr>
        <td>
          <div style="color:#fff;font-size:22px;font-weight:700;">${co}</div>
          <div style="color:#9999cc;font-size:11px;margin-top:3px;">${coAddr}</div>
        </td>
        <td align="right">
          <div style="color:#fff;font-size:17px;font-weight:700;letter-spacing:1px;">TAX INVOICE</div>
          <div style="color:#9999cc;font-size:11px;margin-top:3px;">GSTIN: ${coGstin}</div>
        </td>
      </tr></table>
    </td>
  </tr>

  <!-- ── Customer / Provider info ── -->
  <tr><td style="padding:22px 30px 0;">
    <table width="100%"><tr valign="top">
      <td width="50%" style="padding-right:16px;">
        <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px;">Bill To</div>
        <div style="font-size:16px;font-weight:700;margin-bottom:10px;">${customer.name ?? 'Customer'}</div>
        <table cellpadding="0" cellspacing="0">
          <tr><td style="font-size:11px;color:#888;padding:2px 0;">Invoice No.</td>
              <td style="font-size:11px;padding:2px 10px;font-weight:600;">${invNo}</td></tr>
          <tr><td style="font-size:11px;color:#888;padding:2px 0;">Date</td>
              <td style="font-size:11px;padding:2px 10px;">${invDate}</td></tr>
          <tr><td style="font-size:11px;color:#888;padding:2px 0;vertical-align:top;">Address</td>
              <td style="font-size:11px;padding:2px 10px;">${addr}</td></tr>
          <tr><td style="font-size:11px;color:#888;padding:2px 0;">State</td>
              <td style="font-size:11px;padding:2px 10px;">Karnataka 29</td></tr>
        </table>
      </td>
      <td width="50%" style="padding-left:16px;border-left:1px solid #f0f0f0;">
        <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px;">Delivery Service Provider</div>
        <div style="font-size:14px;font-weight:700;margin-bottom:10px;">${co}</div>
        <table cellpadding="0" cellspacing="0">
          <tr><td style="font-size:11px;color:#888;padding:2px 0;">GSTIN</td>
              <td style="font-size:11px;padding:2px 10px;">${coGstin}</td></tr>
          <tr><td style="font-size:11px;color:#888;padding:2px 0;vertical-align:top;">Address</td>
              <td style="font-size:11px;padding:2px 10px;">${coAddr}</td></tr>
          <tr><td style="font-size:11px;color:#888;padding:2px 0;">State</td>
              <td style="font-size:11px;padding:2px 10px;">Karnataka 29</td></tr>
        </table>
      </td>
    </tr></table>
  </td></tr>

  <!-- ── Items ── -->
  <tr><td style="padding:20px 30px 0;">
    <table width="100%" cellpadding="0" cellspacing="0"
           style="border:1px solid #e8e8e8;border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="background:#f8f8f8;">
          <th style="padding:10px;text-align:left;font-size:11px;color:#555;border-bottom:1px solid #e8e8e8;">Items</th>
          <th style="padding:10px;text-align:right;font-size:11px;color:#555;border-bottom:1px solid #e8e8e8;">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${itemRows}

        <!-- ── Service Charges section ── -->
        <tr style="background:#f9f9ff;">
          <td colspan="2" style="padding:10px 10px 4px;">
            <span style="font-size:12px;font-weight:700;color:#1a1a2e;">Service Charges</span>
            <span style="font-size:10px;color:#999;margin-left:8px;">SAC: ${SAC_SERVICE}</span>
          </td>
        </tr>
        ${sectionRow('Gross Amount (80% of total)',  `Rs. ${bd.partnerGross.toFixed(2)}`)}
        ${sectionRow(`CGST @2.5%`,                  `Rs. ${bd.partnerCGST.toFixed(2)}`, true)}
        ${sectionRow(`SGST @2.5%`,                  `Rs. ${bd.partnerSGST.toFixed(2)}`, true)}
        ${sectionTotal('Partner Credited',           `Rs. ${bd.partnerNet.toFixed(2)}`)}

        <tr><td colspan="2"><hr style="border:none;border-top:1px solid #e8e8e8;margin:0;"></td></tr>

        <!-- ── Convenience Fee section ── -->
        <tr style="background:#f9f9ff;">
          <td colspan="2" style="padding:10px 10px 4px;">
            <span style="font-size:12px;font-weight:700;color:#1a1a2e;">Convenience &amp; Platform Fee</span>
            <span style="font-size:10px;color:#999;margin-left:8px;">SAC: ${SAC_PLATFORM}</span>
          </td>
        </tr>
        ${sectionRow('Gross Amount (20% of total)',  `Rs. ${bd.dhoondGross.toFixed(2)}`)}
        ${sectionRow(`CGST @9%`,                    `Rs. ${bd.dhoondCGST.toFixed(2)}`,  true)}
        ${sectionRow(`SGST @9%`,                    `Rs. ${bd.dhoondSGST.toFixed(2)}`,  true)}
        ${sectionTotal('After Tax Commission',       `Rs. ${bd.dhoondNet.toFixed(2)}`)}

        <tr><td colspan="2"><hr style="border:none;border-top:2px solid #1a1a2e;margin:0;"></td></tr>

        <!-- ── Grand Total ── -->
        <tr style="background:#1a1a2e;">
          <td style="padding:14px 10px;font-size:15px;font-weight:700;color:#fff;">TOTAL AMOUNT</td>
          <td style="padding:14px 10px;text-align:right;font-size:15px;font-weight:700;color:#fff;">
            Rs. ${bd.total}
          </td>
        </tr>
      </tbody>
    </table>
  </td></tr>

  <!-- ── Partner Earning Summary (informational) ── -->
  <tr><td style="padding:16px 30px 0;">
    <div style="background:#f0fff4;border:1px solid #c6f6d5;border-radius:6px;padding:12px 16px;">
      <div style="font-size:11px;color:#276749;font-weight:700;margin-bottom:4px;">Partner Earning Summary</div>
      <table cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size:11px;color:#555;padding:2px 0;">Partner Gross (80%)</td>
          <td style="font-size:11px;padding:2px 16px;font-weight:600;">Rs. ${bd.partnerGross.toFixed(2)}</td>
          <td style="font-size:11px;color:#555;padding:2px 0;">GST @5%</td>
          <td style="font-size:11px;padding:2px 16px;color:#e53e3e;">− Rs. ${bd.partnerGST.toFixed(2)}</td>
          <td style="font-size:11px;color:#555;padding:2px 0;">Credited</td>
          <td style="font-size:11px;padding:2px 0 2px 16px;font-weight:700;color:#276749;">Rs. ${bd.partnerNet.toFixed(2)}</td>
        </tr>
      </table>
    </div>
  </td></tr>

  <!-- ── Footer ── -->
  <tr><td style="padding:18px 30px 26px;">
    <p style="margin:0;font-size:10px;color:#aaa;line-height:1.6;">
      *This is a computer-generated invoice. Reverse Charge mechanism not applicable.<br>
      *For support write to <a href="mailto:support@dhoond.in" style="color:#1a1a2e;">support@dhoond.in</a>
    </p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
};

module.exports = {
  generateInvoicePdf,
  generateCustomerInvoicePdf,
  generatePartnerReceiptPdf,
  buildInvoiceEmailHtml,
  invoiceNumber,
  breakdown,
};

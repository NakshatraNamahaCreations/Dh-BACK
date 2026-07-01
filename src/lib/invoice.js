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

const PDFDocument = require('pdfkit');
const env = require('../config/env');

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
 */
const breakdown = (booking) => {
  const total = booking.grandTotal || booking.total || 0;

  const partnerGross   = r2(total * PARTNER_SHARE);
  const partnerCGST    = r2(partnerGross * (PARTNER_GST_RATE / 2));  // 2.5%
  const partnerSGST    = partnerCGST;
  const partnerGST     = r2(partnerCGST + partnerSGST);              // 5%
  const partnerNet     = r2(partnerGross - partnerGST);              // credited to partner

  const dhoondGross    = r2(total * DHOOND_SHARE);
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

// ── PDF (pdfkit) ───────────────────────────────────────────────────────────

const MARGIN  = 50;
const PAGE_W  = 595;   // A4 pt width
const COL_W   = (PAGE_W - MARGIN * 2) / 2;
const AMT_COL = 145;
const ITEM_COL = PAGE_W - MARGIN * 2 - AMT_COL;

const generateInvoicePdf = (booking) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const co     = env.COMPANY_NAME;
    const coAddr = env.COMPANY_ADDRESS;
    const coGstin = env.COMPANY_GSTIN ?? '';
    const customer = booking.customer ?? {};
    const bd = breakdown(booking);

    // ── Header ────────────────────────────────────────────────────────
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#000')
       .text(co, MARGIN, MARGIN);
    doc.fontSize(19).font('Helvetica-Bold')
       .text('TAX INVOICE', PAGE_W - MARGIN - 180, MARGIN, { width: 180, align: 'right' });

    doc.moveDown(0.3).fontSize(8.5).font('Helvetica').fillColor('#444')
       .text(coAddr,                 MARGIN)
       .text(`GSTIN: ${coGstin || 'Applied For'}`)
       .text('Email: support@dhoond.in')
       .text('www.dhoond.in');

    const afterHeader = doc.y + 10;
    hline(doc, afterHeader);

    // ── Two-column info block ─────────────────────────────────────────
    const infoTop = afterHeader + 14;
    const rightX  = MARGIN + COL_W + 16;

    // Left — customer details
    doc.fontSize(9).font('Helvetica').fillColor('#000').text('', MARGIN, infoTop);
    infoRow(doc, 'Customer Name',    customer.name ?? 'Customer');
    infoRow(doc, 'Invoice no.',       invoiceNumber(booking));
    infoRow(doc, 'Delivery Address', deliveryAddress(booking));
    infoRow(doc, 'Invoice Date',     invoiceDate(booking));
    infoRow(doc, 'State & Code',     'Karnataka 29');
    infoRow(doc, 'Place of Supply',  'Karnataka 29');

    // Right — provider details
    doc.text('', rightX, infoTop);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000')
       .text('DELIVERY SERVICE PROVIDER', rightX);
    doc.moveDown(0.3);
    infoRow(doc, 'Business Name', co);
    if (coGstin) infoRow(doc, 'Business GSTIN', coGstin);
    infoRow(doc, 'Address',       coAddr);
    infoRow(doc, 'State & Code',  'Karnataka 29');

    const afterInfo = doc.y + 14;
    hline(doc, afterInfo);

    // ── Items table header ────────────────────────────────────────────
    let y = afterInfo + 12;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000')
       .text('Items', MARGIN, y)
       .text('Taxable Value', MARGIN + ITEM_COL, y, { width: AMT_COL, align: 'right' });

    y += 14;
    hline(doc, y, '#eeeeee');
    y += 10;

    // ── Section 1: Service Charges (Partner 80%) ──────────────────────
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a2e')
       .text('Service Charges', MARGIN, y);
    doc.font('Helvetica').fontSize(8).fillColor('#666')
       .text(`SAC: ${SAC_SERVICE}`, MARGIN, doc.y);

    // List individual booking items
    y = doc.y + 6;
    for (const item of (booking.items ?? [])) {
      const name     = item.service?.name ?? 'Service';
      const lineAmt  = (item.qty ?? 1) * (item.price ?? 0);
      doc.font('Helvetica').fontSize(8.5).fillColor('#333')
         .text(`${name}  ×${item.qty ?? 1}`, MARGIN + 10, y)
         .text(fmtRsInt(lineAmt), MARGIN + ITEM_COL, y, { width: AMT_COL, align: 'right' });
      y += 13;
    }

    y += 4;
    amtRow(doc, y, 'Gross Amount (80% of total)',   fmtRs(bd.partnerGross));   y += 16;
    amtRow(doc, y, `CGST @2.5%`,                    fmtRs(bd.partnerCGST));   y += 16;
    amtRow(doc, y, `SGST @2.5%`,                    fmtRs(bd.partnerSGST));   y += 16;
    amtRow(doc, y, 'Partner Credited',               fmtRs(bd.partnerNet), true); y += 20;

    hline(doc, y, '#dddddd');
    y += 12;

    // ── Section 2: Convenience & Platform Fee (Dhoond 20%) ───────────
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a2e')
       .text('Convenience & Platform Fee', MARGIN, y);
    doc.font('Helvetica').fontSize(8).fillColor('#666')
       .text(`SAC: ${SAC_PLATFORM}`, MARGIN, doc.y);

    y = doc.y + 8;
    amtRow(doc, y, 'Gross Amount (20% of total)',   fmtRs(bd.dhoondGross));   y += 16;
    amtRow(doc, y, `CGST @9%`,                      fmtRs(bd.dhoondCGST));   y += 16;
    amtRow(doc, y, `SGST @9%`,                      fmtRs(bd.dhoondSGST));   y += 16;
    amtRow(doc, y, 'After Tax Commission',           fmtRs(bd.dhoondNet));    y += 20;

    hline(doc, y);
    y += 10;

    // ── Grand Total ───────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000')
       .text('TOTAL AMOUNT', MARGIN, y)
       .text(fmtRsInt(bd.total), MARGIN + ITEM_COL, y, { width: AMT_COL, align: 'right' });

    y += 28;
    hline(doc, y);

    // ── Footer ────────────────────────────────────────────────────────
    doc.fontSize(7.5).font('Helvetica').fillColor('#888')
       .text('*This is a computer-generated invoice. Reverse Charge mechanism not applicable.', MARGIN, y + 10)
       .text('*For support, email support@dhoond.in');

    doc.end();
  });

// ── PDF draw helpers ──────────────────────────────────────────────────────

function hline(doc, y, color = '#cccccc') {
  doc.moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y)
     .strokeColor(color).lineWidth(0.75).stroke();
}

function infoRow(doc, label, value) {
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#555')
     .text(`${label}:  `, { continued: true });
  doc.font('Helvetica').fillColor('#000').text(value);
}

function amtRow(doc, y, label, amount, bold = false) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#000')
     .text(label, MARGIN + 4, y)
     .text(amount, MARGIN + ITEM_COL, y, { width: AMT_COL, align: 'right' });
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
    const lineTotal = (it.qty ?? 1) * (it.price ?? 0);
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

module.exports = { generateInvoicePdf, buildInvoiceEmailHtml, invoiceNumber, breakdown };

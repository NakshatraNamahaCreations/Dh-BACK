const nodemailer = require('nodemailer');
const env = require('../config/env');
const logger = require('../config/logger');

let _transporter = null;

const getTransporter = () => {
  if (_transporter) return _transporter;
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null;

  _transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  return _transporter;
};

/**
 * Send an email. Returns the nodemailer info object on success or null
 * when SMTP is not configured (dev environments without keys).
 *
 * @param {{ to: string, subject: string, html: string, attachments?: Array }} opts
 */
const sendMail = async ({ to, subject, html, attachments = [] }) => {
  const t = getTransporter();
  if (!t) {
    logger.warn(`[email] SMTP not configured — skipping "${subject}" → ${to}`);
    return null;
  }
  try {
    const info = await t.sendMail({
      from: `"Dhoond" <${env.SMTP_FROM}>`,
      to,
      subject,
      html,
      attachments,
    });
    logger.info(`[email] sent: "${subject}" → ${to} (${info.messageId})`);
    return info;
  } catch (err) {
    logger.error(`[email] send failed: "${subject}" → ${to}: ${err.message}`);
    throw err;
  }
};

module.exports = { sendMail };

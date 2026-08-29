const prisma = require('../../config/prisma');
const logger = require('../../config/logger');

/**
 * Cancellation + refund policy, persisted in the `platform_settings`
 * key-value table and edited from the admin Policy config pages.
 *
 * Reads fall back to the defaults below when the key is absent (fresh
 * install, admin never saved) OR when the table itself is missing
 * (migration not yet applied) — so the app keeps serving the previous
 * hard-coded behaviour instead of 500ing. Saves upsert the JSON blob.
 *
 * The policy is now actually enforced:
 *   - `computeCustomerCancelFee` is called from bookings.cancelOwn to
 *     turn a cancel into a partial refund (paid − fee).
 *   - `partnerPenalty` / `partnerStrikeLimit` drive bookings.partnerCancel
 *     (penalty ledger row + rolling 7-day strike → auto-suspend).
 */

const CANCELLATION_KEY = 'cancellation_policy';
const REFUND_KEY = 'refund_policy';
const DISPATCH_KEY = 'dispatch_config';
const APP_VERSIONS_KEY = 'app_version_config';
const COMPANY_KEY = 'company_details';

const DEFAULT_CANCELLATION = {
  freeWindowMins: 5,
  customerTiers: [
    { fromMins: 5, feePercent: 25 },
    { fromMins: 15, feePercent: 50 },
    { fromMins: 30, feePercent: 100 },
  ],
  partnerPenalty: 200,
  partnerStrikeLimit: 3,
};

const DEFAULT_REFUND = {
  autoApproveBelow: 500,
  manualReviewAbove: 2000,
  processingDaysBank: 5,
  processingDaysWallet: 1,
  partialRefundEnabled: true,
  reasonRequired: true,
};

/// Broadcast-radius config. The dispatcher widens the search in three
/// stages — `radii[0]` → `radii[1]` → `radii[2]` km — each tried as an
/// initial + retry attempt before handing off to admin. Only the three
/// DISTANCES are admin-editable; the wave count, per-attempt timing, and
/// retry behaviour stay fixed in the dispatcher. Must be 3 ascending
/// positive numbers; the dispatcher falls back to these defaults if the
/// stored value is missing or malformed.
const DEFAULT_DISPATCH = {
  radii: [3, 5, 7],
};

/// In-app update config, per app. The apps fetch this on launch and compare
/// their own version against it:
///   version < minVersion    → BLOCKING "Update required" (can't dismiss)
///   version < latestVersion → dismissible "Update available" prompt
/// `storeUrl` opens the Play Store listing. Admin bumps these after each
/// Play Store release. Defaults keep the apps working (no prompt) when the
/// row is absent — minVersion '0.0.0' never blocks, latest matches typical
/// first release so nobody is nagged until admin sets real values.
const DEFAULT_APP_VERSIONS = {
  customer: {
    latestVersion: '1.0.0',
    minVersion: '0.0.0',
    storeUrl: 'https://play.google.com/store/apps/details?id=com.dhoond.customer',
    message: '',
  },
  partner: {
    latestVersion: '1.0.0',
    minVersion: '0.0.0',
    storeUrl: 'https://play.google.com/store/apps/details?id=com.dhoond.partner',
    message: '',
  },
};

/// Read a settings key, falling back to `fallback` on absence or any
/// DB error (e.g. the platform_settings table not existing yet). We
/// merge over the defaults so a partially-saved blob can't drop a field
/// the rest of the code relies on.
const readSetting = async (key, fallback) => {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key } });
    if (!row || row.value == null || typeof row.value !== 'object') return { ...fallback };
    return { ...fallback, ...row.value };
  } catch (err) {
    logger.warn(`[policy] read "${key}" failed, using defaults: ${err.message}`);
    return { ...fallback };
  }
};

const writeSetting = async (key, value) => {
  const row = await prisma.platformSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
  return row.value;
};

exports.getCancellation = async () => readSetting(CANCELLATION_KEY, DEFAULT_CANCELLATION);
exports.saveCancellation = async (policy) => writeSetting(CANCELLATION_KEY, policy);

exports.getRefund = async () => readSetting(REFUND_KEY, DEFAULT_REFUND);
exports.saveRefund = async (policy) => writeSetting(REFUND_KEY, policy);

/// Returns the dispatch config, sanitised so the dispatcher can trust it:
/// exactly 3 ascending positive integers. Any malformed stored value
/// silently falls back to the [3,5,7] default rather than risking a bad
/// radius (e.g. 0 km = nobody, or descending = the 7km wave searching a
/// smaller area than the 3km wave).
exports.getDispatch = async () => {
  const raw = await readSetting(DISPATCH_KEY, DEFAULT_DISPATCH);
  const radii = Array.isArray(raw.radii) ? raw.radii.map(Number) : [];
  const valid =
    radii.length === 3 &&
    radii.every((r) => Number.isFinite(r) && r > 0) &&
    radii[0] <= radii[1] &&
    radii[1] <= radii[2];
  return { radii: valid ? radii : [...DEFAULT_DISPATCH.radii] };
};
exports.saveDispatch = async (config) => writeSetting(DISPATCH_KEY, config);
exports.DEFAULT_DISPATCH = DEFAULT_DISPATCH;

/// Full app-version config (both apps) — for the admin editor.
/// Company / GST details printed on the invoice pair (and anywhere else
/// the platform identifies itself as a legal entity). Defaults come from
/// env so a fresh install keeps working before the admin ever saves.
/// `signatureUrl` is the authorised-signatory image (S3) drawn above the
/// signature line on the Dhoond tax invoice.
const env = require('../../config/env');
const DEFAULT_COMPANY = {
  name: env.COMPANY_NAME,
  gstin: env.COMPANY_GSTIN ?? '',
  address: env.COMPANY_ADDRESS,
  stateNameCode: 'Karnataka 29',
  signatureUrl: null,
  /// Debited for partner payouts — fills the Bank Payout Excel's
  /// "Debit Account Number" column; blank until an admin sets it.
  debitAccountNumber: '',
};
exports.getCompanyDetails = async () => readSetting(COMPANY_KEY, DEFAULT_COMPANY);
exports.saveCompanyDetails = async (config) => writeSetting(COMPANY_KEY, config);

exports.getAppVersions = async () => readSetting(APP_VERSIONS_KEY, DEFAULT_APP_VERSIONS);
exports.saveAppVersions = async (config) => writeSetting(APP_VERSIONS_KEY, config);
exports.DEFAULT_APP_VERSIONS = DEFAULT_APP_VERSIONS;

/// Single-app config served to the launching app. `app` is 'customer' |
/// 'partner'; anything else falls back to the customer block. Returns a
/// FLAT { latestVersion, minVersion, storeUrl, message } resolved for the
/// caller's platform:
///   - android (default): the base fields — unchanged behaviour.
///   - ios: the block's optional `ios` overrides (own version pair +
///     App Store URL, since iOS ships on its own cadence). Falls back to
///     the Android values when no iOS block is configured, so pre-launch
///     iOS builds never break on a missing config.
exports.getAppConfig = async (app, platform) => {
  const all = await exports.getAppVersions();
  const key = app === 'partner' ? 'partner' : 'customer';
  const block = { ...DEFAULT_APP_VERSIONS[key], ...(all[key] ?? {}) };
  const { ios, ...base } = block;
  if (platform === 'ios' && ios) {
    return { ...base, ...ios };
  }
  return base;
};

/// Pure fee math, exported separately so it's unit-testable without a
/// DB and reusable by both the cancel flow and the customer-app quote
/// endpoint. Pass the live policy in so callers that already loaded it
/// don't double-read.
///
/// Rules (mirrors the admin "Customer-side rules" card):
///   - elapsed ≤ freeWindowMins      → no fee, full refund
///   - otherwise pick the tier with the LARGEST `fromMins` that is
///     still ≤ elapsed, and charge that tier's `feePercent` of the
///     amount paid. Tiers are sorted defensively in case the admin
///     entered them out of order.
///
/// `amountPaid` is the customer-facing grandTotal that was captured —
/// the fee (and therefore the refund) is computed against what they
/// actually paid, not the partner-facing job `total`.
const computeCustomerCancelFee = ({ policy, amountPaid, bookedAt, now = new Date() }) => {
  const freeWindowMins = policy?.freeWindowMins ?? 0;
  const tiers = [...(policy?.customerTiers ?? [])].sort((a, b) => a.fromMins - b.fromMins);

  const elapsedMs = now.getTime() - new Date(bookedAt).getTime();
  const elapsedMins = Math.max(0, Math.floor(elapsedMs / 60000));

  if (elapsedMins <= freeWindowMins || tiers.length === 0) {
    return {
      elapsedMins,
      freeWindowMins,
      withinFreeWindow: true,
      feePercent: 0,
      feeAmount: 0,
      refundAmount: amountPaid,
    };
  }

  let feePercent = 0;
  for (const t of tiers) {
    if (elapsedMins >= t.fromMins) feePercent = t.feePercent;
  }

  /// Round the fee to whole rupees and clamp the refund to [0, paid] so
  /// a misconfigured >100% tier can never produce a negative refund or
  /// a refund larger than the capture.
  const feeAmount = Math.min(amountPaid, Math.max(0, Math.round((amountPaid * feePercent) / 100)));
  return {
    elapsedMins,
    freeWindowMins,
    withinFreeWindow: false,
    feePercent,
    feeAmount,
    refundAmount: Math.max(0, amountPaid - feeAmount),
  };
};

exports.computeCustomerCancelFee = computeCustomerCancelFee;
exports.DEFAULT_CANCELLATION = DEFAULT_CANCELLATION;
exports.DEFAULT_REFUND = DEFAULT_REFUND;

/**
 * Shared address helpers.
 *
 * Extracted from bookings.service so the admin Booking History table and
 * the Booking Analytics "By area" chart derive the locality the SAME way.
 * They previously each did `addressLine.split(',')[0]`, which returns the
 * HOUSE NUMBER — hence areas rendering as "1002", "393", "No 867".
 */

/// Human-meaningful locality for an address. Address lines
/// look like "868, 25th Main Rd, 1st Sector, HSR Layout, Bengaluru,
/// Karnataka 560102, India" — the FIRST segment is the house number, so
/// the column used to read "868" / "No 867" / "403". Instead: take the
/// segment closest to (just before) the city, skipping pure house-number
/// patterns and pincode/state/country noise; fall back to the city.
const areaFromAddress = (line, city) => {
  if (!line) return city ?? '';
  const segs = line.split(',').map((x) => x.trim()).filter(Boolean);
  const isNoise = (x) =>
    /^india$/i.test(x) ||
    /\d{6}/.test(x) ||
    (city && x.toLowerCase() === String(city).toLowerCase());
  const isHouseish = (x) =>
    /^#?\s*(no\.?\s*)?\d+[\w\/-]*$/i.test(x) ||
    /^(flat|house|door|plot|site|apt|apartment)\b/i.test(x);
  let cityIdx = city
    ? segs.findIndex((x) => x.toLowerCase() === String(city).toLowerCase())
    : -1;
  if (cityIdx === -1) cityIdx = segs.findIndex((x) => isNoise(x));
  const candidates = (cityIdx > 0 ? segs.slice(0, cityIdx) : segs).filter(
    (x) => !isNoise(x) && !isHouseish(x),
  );
  return candidates[candidates.length - 1] ?? city ?? segs[0] ?? '';
};

module.exports = { areaFromAddress };

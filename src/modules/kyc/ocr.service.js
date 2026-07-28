/**
 * Lightweight OCR helper — given an image URL and an expected document
 * number, confirms the number actually appears in the image text.
 *
 * Uses tesseract.js (pure-JS WASM port, no system Tesseract needed).
 * The worker is initialised once and reused for all subsequent calls.
 *
 * Returns:
 *   { found: true }  — number detected in image
 *   { found: false, extracted: string }  — number NOT in image; `extracted`
 *                                          is the raw OCR text for debugging
 *
 * Throws only for unrecoverable errors (bad image URL, worker crash).
 * A false-negative (OCR misreads a valid card) returns found:false, not
 * an exception — callers decide whether to treat that as a hard block.
 */

const { createWorker } = require('tesseract.js');
const sharp = require('sharp');
const logger = require('../../config/logger');

let _worker = null;
let _workerInitPromise = null;

const initWorker = async () => {
  const worker = await createWorker('eng', 1, {
    /// Suppress tesseract's own console noise in production.
    logger: () => {},
  });
  /// OSD + LSTM give the best accuracy on printed document numbers.
  /// PSM 6 = assume a uniform block of text (good for ID cards).
  await worker.setParameters({ tessedit_pageseg_mode: '6' });
  return worker;
};

const getWorker = async () => {
  if (_worker) return _worker;
  /// Coalesce concurrent first-callers onto the same init promise so
  /// two parallel `recognize()` calls (front + back) don't each pay
  /// the ~5s WASM cold-start independently.
  if (!_workerInitPromise) {
    _workerInitPromise = initWorker().then((w) => {
      _worker = w;
      return w;
    });
  }
  return _workerInitPromise;
};

/// Second worker dedicated to the digits-only RESCUE pass (see
/// digitsRescuePass below). Its own worker — not setParameters swaps on
/// the shared one — because concurrent front+back checks queue jobs on
/// the same worker, and a whitelist set for one job could leak into the
/// other. Lazy: only partners whose primary pass misses ever pay the
/// init cost.
let _digitWorker = null;
let _digitWorkerInitPromise = null;
const getDigitWorker = async () => {
  if (_digitWorker) return _digitWorker;
  if (!_digitWorkerInitPromise) {
    _digitWorkerInitPromise = (async () => {
      const w = await createWorker('eng', 1, { logger: () => {} });
      /// PSM 11 = sparse text — hunts for isolated text blobs, which
      /// finds the big printed Aadhaar number line that PSM 6's
      /// uniform-block assumption walks straight past on busy
      /// mixed-script (Kannada/Hindi + English) cards and photos of
      /// phone screens. The digit whitelist stops regional-script
      /// glyphs being force-fitted onto letters.
      await w.setParameters({
        tessedit_pageseg_mode: '11',
        tessedit_char_whitelist: '0123456789 ',
      });
      _digitWorker = w;
      return w;
    })();
  }
  return _digitWorkerInitPromise;
};

/// Pre-warm at module load time so the FIRST partner OTP request
/// after a server restart doesn't pay the worker init latency. Fire-
/// and-forget — failure here just falls back to lazy init on first
/// `recognize()` call, which is the previous behaviour.
exports.warmup = () => {
  getWorker().catch((err) => {
    logger.warn(`[ocr] worker warmup failed: ${err.message}`);
  });
};
exports.warmup();

/// Max width the OCR-bound image is downscaled to. Tesseract compute
/// is roughly O(pixels), so a 4000×3000 phone-camera capture takes
/// ~9x as long as a 1600×1200 one. 2000 px preserves enough detail for
/// the small printed DL number ("DL No.: KA53 20160024297") to survive
/// the resize while still being ~4x faster than full-res OCR.
const OCR_MAX_WIDTH = 2000;

/// Fetch the uploaded image and pre-process for OCR. We:
///   1. resize to OCR_MAX_WIDTH (speed)
///   2. greyscale + normalise (contrast stretch — KILLER for OCR on
///      glossy laminated IDs where text-vs-card-surface contrast is
///      weak in colour space but strong in luminance)
///   3. sharpen (counters the slight softness of resize + JPEG capture)
/// Returns a Buffer the tesseract worker accepts directly. Errors fall
/// through to the caller's catch — if the image is unreachable we'd
/// rather log + return found:true than hard-block a real Aadhaar on an
/// S3 hiccup.
const fetchAndDownscale = async (imageUrl) => {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`fetch ${res.status} ${imageUrl}`);
  const inputBuf = Buffer.from(await res.arrayBuffer());
  return sharp(inputBuf)
    .resize({ width: OCR_MAX_WIDTH, withoutEnlargement: true })
    .grayscale()
    .normalize()
    .sharpen()
    .toBuffer();
};

/// Normalise a string for comparison: strip spaces, dashes, dots, and
/// punctuation, then uppercase. So "DL No.: KA53 20160024297" becomes
/// "DLNOKA5320160024297" which a substring-includes can still match.
const normalise = (s) =>
  String(s)
    .replace(/[\s\-\.:,;()\/]/g, '')
    .toUpperCase();

/// Tesseract often confuses these character pairs on glossy / laminated
/// cards: 0↔O, 1↔I↔L, 5↔S, 8↔B, 2↔Z, 6↔G. We canonicalise both the OCR
/// output AND the expected number through the same map so a misread "I"
/// in the OCR side still matches the real "1" on the card.
const OCR_CLASS = {
  O: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6', Q: '0',
};
const canonicalise = (s) =>
  normalise(s)
    .split('')
    .map((ch) => OCR_CLASS[ch] ?? ch)
    .join('');

/// True if `needle` appears in `haystack` allowing up to (1 - threshold)
/// fraction of character mismatches per window. Tolerates the 1-2
/// per-card misreads tesseract makes on real Aadhaar / PAN / DL photos
/// without opening the door to wholly unrelated uploads.
const fuzzyContains = (haystack, needle, threshold = 0.85) => {
  if (!needle || needle.length === 0) return false;
  if (haystack.includes(needle)) return true;
  const need = needle.length;
  const limit = haystack.length - need;
  for (let i = 0; i <= limit; i++) {
    let matches = 0;
    for (let j = 0; j < need; j++) {
      if (haystack[i + j] === needle[j]) matches++;
    }
    if (matches / need >= threshold) return true;
  }
  return false;
};

/// Digits-only rescue pass on an already-preprocessed buffer. Run only
/// after the primary pass misses — a real-world example: an Aadhaar
/// front where PSM 6 read the English header + DOB but skipped the big
/// number line entirely (mixed-script layout). The sparse-text digit
/// worker found it. ~1s extra latency, paid only on primary-pass misses.
/// Fuzzy tolerance 0.9 over 12 digits allows a single misread digit.
const digitsRescuePass = async (buf, numDigits) => {
  if (!numDigits || numDigits.length < 8) return false;
  const w = await getDigitWorker();
  const { data } = await w.recognize(buf);
  const digits = (data.text ?? '').replace(/\D/g, '');
  return (
    digits.includes(numDigits) ||
    digits.includes(numDigits.slice(-8)) ||
    /// 0.85 over 12 digits tolerates ~1-2 misread digits — enough for a
    /// glossy card, still tight enough not to match an unrelated number.
    fuzzyContains(digits, numDigits, 0.85)
  );
};

/**
 * @param {string} imageUrl   - publicly accessible URL of the uploaded image
 * @param {string} number     - document number to look for (PAN / DL / Aadhaar)
 * @returns {Promise<{ found: boolean, extracted?: string }>}
 */
exports.numberExistsInImage = async (imageUrl, number) => {
  const t0 = Date.now();
  const [worker, buf] = await Promise.all([getWorker(), fetchAndDownscale(imageUrl)]);
  const { data } = await worker.recognize(buf);
  const raw = data.text ?? '';

  const canonRaw = canonicalise(raw);
  const canonNum = canonicalise(number);

  /// Four escalating tolerances, ordered from strict → forgiving:
  ///   1. exact   — substring match after canonicalisation (cleanest)
  ///   2. fuzzy   — substring with 15% character-error budget (real-world OCR)
  ///   3. digits  — for Indian IDs that are "state-code letters + long digit
  ///                suffix" (DL: KA…, PAN: …, Aadhaar: all digits), strip any
  ///                leading letters from BOTH the entered number and the OCR
  ///                text, then require the full digit run to appear. This is
  ///                the most reliable match because digits OCR far more
  ///                cleanly than mixed alphanumeric on glossy / laminated cards.
  ///   4. tail8   — last-ditch: only the last 8 digits must appear. Catches
  ///                cases where the state code is wholly unreadable in the
  ///                photo (severe glare, partial crop, etc).
  const canonDigits = canonRaw.replace(/\D/g, '');
  const numDigits = canonNum.replace(/\D/g, '');

  let found = canonRaw.includes(canonNum);
  let strategy = found ? 'exact' : null;
  if (!found) {
    found = fuzzyContains(canonRaw, canonNum, 0.85);
    if (found) strategy = 'fuzzy';
  }
  if (!found && numDigits.length >= 8 && canonDigits.includes(numDigits)) {
    found = true;
    strategy = 'digits';
  }
  if (!found && numDigits.length >= 8 && canonDigits.includes(numDigits.slice(-8))) {
    found = true;
    strategy = 'tail8';
  }
  ///   5. digits-only rescue — a second recognize with the sparse-text
  ///      digit-whitelisted worker. Catches numbers the mixed-script
  ///      primary pass skipped entirely (see digitsRescuePass).
  if (!found && (await digitsRescuePass(buf, numDigits).catch(() => false))) {
    found = true;
    strategy = 'digit-pass';
  }

  logger.info(
    `[ocr] number=${canonNum} found=${found}${strategy ? ` via=${strategy}` : ''} (extracted ${raw.length} chars, ${Date.now() - t0}ms)`,
  );
  if (!found) {
    /// Dump what tesseract actually read so we can tell whether the
    /// problem is OCR misreading characters (tweak class map / fuzziness)
    /// or OCR not finding the digits at all (image quality issue —
    /// glare, angle, downscale too aggressive).
    logger.warn(
      `[ocr] miss — expected digits "${numDigits}", OCR digits "${canonDigits.slice(0, 200)}"`,
    );
  }
  return { found, extracted: found ? undefined : raw.slice(0, 300) };
};

/// Markers that appear on every legitimate Aadhaar back side. The number
/// itself is NOT a reliable anchor — some Aadhaar back layouts don't
/// repeat the 12-digit number on the back at all — but these UIDAI
/// strings are mandatory on the printed template regardless of state,
/// language, or year of issue. Stored lowercase since we lower-case the
/// OCR output before matching. `1947` is the UIDAI helpline number —
/// pairing it with "aadhaar" rejects coincidental year matches in random
/// images.
const BACK_MARKERS = [
  'uidai',
  'unique identification authority',
  /// Partial of the header — survives when "unique"/"of india" misreads on
  /// a busy mixed-script back.
  'identification authority',
  'help@uidai',
  'uidai.gov.in',
  'www.uidai',
  /// UIDAI toll-free helpline printed on every back template. The
  /// digits-only form is matched separately (see `helplineDigitHit`) so OCR
  /// spacing variations don't matter.
  '1800 180 1947',
];

/**
 * Returns true if the image text contains at least one UIDAI marker
 * that's expected on every Aadhaar back side. Designed to reject
 * arbitrary uploads (screenshots, selfies, blank pages) without
 * requiring the partner's specific Aadhaar number to be on the back.
 *
 * When `number` is passed, the 12-digit Aadhaar number appearing in
 * the image also counts as a match (same single OCR pass) — most card
 * layouts DO repeat it on the back, so it rescues photos where the
 * small UIDAI footer text is blurred but the large number is legible.
 *
 * @param {string} imageUrl - publicly accessible URL of the back-of-card image
 * @param {string} [number] - the partner's typed Aadhaar number
 * @returns {Promise<{ found: boolean, extracted?: string }>}
 */
exports.aadhaarBackMarkersInImage = async (imageUrl, number) => {
  const t0 = Date.now();
  const [worker, buf] = await Promise.all([getWorker(), fetchAndDownscale(imageUrl)]);
  const { data } = await worker.recognize(buf);
  const raw = data.text ?? '';
  const lower = raw.toLowerCase();
  const matched = BACK_MARKERS.find((m) => lower.includes(m));
  /// Fallback: "1947" appears in the UIDAI helpline footer. Only count
  /// it if "aadhaar" / "aadhar" is also somewhere in the text, so a
  /// random photo from 1947 doesn't slip through.
  const helplineHit =
    lower.includes('1947') && (lower.includes('aadhaar') || lower.includes('aadhar'));
  /// Digits-only view of the OCR text — used for both the helpline and the
  /// Aadhaar-number matches (digits OCR far more reliably than the tiny
  /// footer text, and this ignores OCR spacing quirks).
  const canonDigits = canonicalise(raw).replace(/\D/g, '');
  /// UIDAI toll-free helpline (1800 180 1947) as a digit run — a strong
  /// Aadhaar-back signal on its own, regardless of how OCR spaces it.
  const helplineDigitHit = canonDigits.includes('18001801947');
  /// Number-on-back match — same digit-run / tail8 tolerance the front
  /// check uses.
  let numberHit = false;
  const numDigits = number ? canonicalise(number).replace(/\D/g, '') : '';
  if (numDigits) {
    numberHit =
      numDigits.length >= 8 &&
      (canonDigits.includes(numDigits) || canonDigits.includes(numDigits.slice(-8)));
  }
  let found = Boolean(matched) || helplineHit || helplineDigitHit || numberHit;
  let via =
    matched ||
    (helplineHit ? '1947+aadhaar' : helplineDigitHit ? 'helpline' : numberHit ? 'number' : 'none');
  /// Same digits-only rescue the front check uses — a back photo whose
  /// footer text is blurred can still pass on its big number line.
  if (!found && (await digitsRescuePass(buf, numDigits).catch(() => false))) {
    found = true;
    via = 'digit-pass';
  }
  logger.info(
    `[ocr] aadhaar-back found=${found} marker=${via} (extracted ${raw.length} chars, ${Date.now() - t0}ms)`,
  );
  return { found, extracted: found ? undefined : raw.slice(0, 300) };
};

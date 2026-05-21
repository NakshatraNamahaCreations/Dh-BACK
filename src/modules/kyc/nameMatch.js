/**
 * Backend name-similarity check for KYC cross-document matching.
 *
 * Ported from partner-app/src/utils/nameMatch.ts — the same scoring is
 * applied on both sides so the partner-app's pre-flight error message
 * and the backend's enforced gate always agree on whether the names
 * match (otherwise admin would see "verified" while the partner was
 * told it was rejected — the bug we're closing here).
 *
 * Three strategies, best score wins:
 *   1. Token Dice          — "Rajesh Kumar" vs "Rajesh K Kumar"
 *   2. Character bigram    — single-token names and typos
 *   3. Initial-aware score — "Yogesha P V" vs "Poojaridoddi Venkatachala Yogesha"
 */

const HONORIFICS_RE = /\b(mr|mrs|ms|dr|shri|smt|kumari|late|s\/o|d\/o|w\/o)\b\.?/gi;

const normalizeName = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(HONORIFICS_RE, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/// Two tokens are "related" when identical, one is an initial of the
/// other, or one is a 3+ char prefix.
const tokensRelated = (a, b) => {
  if (a === b) return true;
  if (a.length === 1) return b.startsWith(a);
  if (b.length === 1) return a.startsWith(b);
  if (a.length >= 3 && b.startsWith(a)) return true;
  if (b.length >= 3 && a.startsWith(b)) return true;
  return false;
};

const initialAwareScore = (tokA, tokB) => {
  if (!tokA.length || !tokB.length) return 0;
  const [shorter, longer] = tokA.length <= tokB.length ? [tokA, tokB] : [tokB, tokA];
  const used = new Set();
  let matched = 0;
  for (const tok of shorter) {
    for (let i = 0; i < longer.length; i++) {
      if (used.has(i)) continue;
      if (tokensRelated(tok, longer[i])) {
        matched++;
        used.add(i);
        break;
      }
    }
  }
  return (matched / shorter.length + matched / longer.length) / 2;
};

const tokenDice = (a, b) => {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let common = 0;
  setA.forEach((t) => {
    if (setB.has(t)) common++;
  });
  return (2 * common) / (setA.size + setB.size);
};

const bigramDice = (a, b) => {
  const pairs = (s) => {
    const out = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const bA = pairs(a);
  const bB = pairs(b);
  if (!bA.length || !bB.length) return 0;
  const setB = new Set(bB);
  let common = 0;
  bA.forEach((bg) => {
    if (setB.has(bg)) common++;
  });
  return (2 * common) / (bA.length + bB.length);
};

const nameSimilarity = (a, b) => {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const tokA = na.split(' ').filter(Boolean);
  const tokB = nb.split(' ').filter(Boolean);
  return Math.max(
    tokenDice(tokA, tokB),
    bigramDice(na.replace(/\s/g, ''), nb.replace(/\s/g, '')),
    initialAwareScore(tokA, tokB),
  );
};

const NAME_MATCH_THRESHOLD = 0.75;

module.exports = { nameSimilarity, NAME_MATCH_THRESHOLD };

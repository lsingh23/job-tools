// Mechanical validators (blueprint Part 4 Move 2 + Part 6 step 10). These are the "code
// enforces" half of the design: the AI proposes, code proves. None of these encode any
// adjacency judgment — they check only what code can check with certainty, so a hallucinated
// justification or a rule-breaking rewrite dies automatically rather than on trust.

// ── evidence substring check (proposer output) ───────────────────────────────────
// The proposer must quote its evidence VERBATIM from the master. Normalize smart quotes,
// dashes, and whitespace on both sides so a faithful quote that only differs in typography
// still passes, but a paraphrase (different words) still fails.
const canon = (s) => String(s ?? "")
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
  .replace(/\s+/g, " ").trim();

/** True iff `evidence` appears verbatim (typography-normalized) in the master resume text. */
export function isVerbatimEvidence(evidence, masterText) {
  const e = canon(evidence);
  return e.length > 0 && canon(masterText).includes(e);
}

// ── character-budget contract (one-page safety) ───────────────────────────────────
// Replacements must be 90%–100% of the original's length: ≤100% guarantees no new wrap;
// ≥90% stops the model gutting a bullet to hit the cap. Returns:
//   "ok"    within [90%,100%]              → apply
//   "over"  >100% (would risk a wrap)      → retry-once-then-drop
//   "short" <90% (suspiciously truncated)  → apply but flag
export function checkBudget(origChars, nextText) {
  const n = String(nextText ?? "").length;
  if (n > origChars) return "over";
  if (n < Math.floor(origChars * 0.9)) return "short";
  return "ok";
}

// ── numbers / dates unchanged (honesty rule 1) ────────────────────────────────────
// Every metric, percentage, duration, and date must survive a rewrite byte-for-byte. We
// compare the MULTISET of numeric tokens (digits with optional %, decimal, comma, ×, +, k/m
// suffix, or a → range arrow) — order may change (reordering within a sentence is allowed) but
// the set may not. "67%" must still be "67%"; a dropped or altered "60%" fails.
const numberTokens = (s) =>
  (String(s ?? "").match(/\d[\d,.]*\s*(?:%|k|m|x|×|\+|hrs?|hours?|mins?|min|days?|weeks?|months?|years?|yrs?)?/gi) ?? [])
    .map((t) => t.toLowerCase().replace(/\s+/g, "")).sort();

const sameMultiset = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** True iff `next` preserves exactly the numeric tokens of `orig` (any order). */
export function numbersPreserved(orig, next) {
  return sameMultiset(numberTokens(orig), numberTokens(next));
}

// ── no new tech noun beyond approved respellings (honesty rule 2) ─────────────────
// The tailor call may reword and reorder but may NOT introduce any technology/tool/methodology
// not already on the resume, except via an approved respelling. Code can't enumerate every tech
// noun, so it works structurally: split the text into whole "words" (letters/digits joined by
// ./+# separators, so "Node.js", "CI/CD", "C++", "WCAG2.2" stay intact), then flag a word as
// tech-ish when it carries a separator or digit, is an ACRONYM (2+ caps), has an internal
// capital ("GraphQL", "PostgreSQL", "TypeScript"), or is a plain Capitalized word mid-sentence
// ("Kubernetes"). Every tech-ish token in the rewrite must already exist in the allowed
// vocabulary (all master text + respelling targets); a novel one is a fabrication → edit rejected.
const WORD = /[A-Za-z][A-Za-z0-9]*(?:[./+#][A-Za-z0-9+#]+)*/g;

function isTechish(word, { atStart }) {
  if (/[./+#]/.test(word)) return true;          // Node.js, CI/CD, C++
  if (/[0-9]/.test(word)) return true;           // E2E, WCAG2.2
  if (/^[A-Z0-9]{2,}$/.test(word)) return true;  // GCP, AWS, SSR, RBAC
  if (/[a-z][A-Z]|[A-Z].*[A-Z]/.test(word)) return true; // GraphQL, PostgreSQL, TypeScript
  if (/^[A-Z][a-z]+$/.test(word)) return !atStart; // Kubernetes mid-sentence; not sentence casing
  return false;                                   // ordinary lowercase word
}

function techTokens(s, { keepSentenceInitial = false } = {}) {
  const out = new Set();
  const str = String(s ?? "");
  let m;
  WORD.lastIndex = 0;
  while ((m = WORD.exec(str)) !== null) {
    const atStart = !keepSentenceInitial &&
      (m.index === 0 || /[.!?]\s$/.test(str.slice(Math.max(0, m.index - 2), m.index)));
    if (isTechish(m[0], { atStart })) out.add(m[0].toLowerCase());
  }
  return out;
}

/**
 * Build the allowed-vocabulary checker from the full master text plus the approved respelling
 * TARGETS (the JD spellings the tailor may introduce). Returns (newText) → string[] of the
 * offending novel tech tokens (empty ⇒ the edit introduces no new tech noun).
 */
export function makeNounGuard(masterText, respellingTargets = []) {
  const allowed = new Set([
    ...techTokens(masterText, { keepSentenceInitial: true }),
    ...respellingTargets.flatMap((t) => [...techTokens(t, { keepSentenceInitial: true })]),
  ]);
  return (newText) => [...techTokens(newText)].filter((tok) => !allowed.has(tok));
}

// ── headline allow-list (honesty rule 5) ──────────────────────────────────────────
/** True iff `headline` is exactly one of the allowed titles (case/space-insensitive). */
export function isAllowedTitle(headline, allowedTitles) {
  const squash = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const h = squash(headline);
  return !!h && allowedTitles.some((t) => squash(t) === h);
}

/**
 * Validate one tailor edit against a unit. Returns { status, reasons[] }:
 *   status "ok"    — apply as-is
 *   status "retry" — over budget; shorten-and-retry once, then drop
 *   status "drop"  — a hard honesty violation (number changed / new tech noun); keep original
 * `nounGuard` from makeNounGuard; `unit` is { chars } for the id being edited.
 */
export function validateEdit(unit, newText, nounGuard) {
  const reasons = [];
  if (!numbersPreserved(unit.text, newText)) reasons.push("numbers-changed");
  const novel = nounGuard(newText);
  if (novel.length) reasons.push(`new-tech-noun:${novel.join(",")}`);
  if (reasons.length) return { status: "drop", reasons };

  const budget = checkBudget(unit.chars, newText);
  if (budget === "over") return { status: "retry", reasons: ["over-budget"] };
  if (budget === "short") return { status: "ok", reasons: ["short"] }; // allowed, just noted
  return { status: "ok", reasons: [] };
}

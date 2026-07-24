// Score gate (blueprint Part 6 step 12 + Part 4 "where the score gains come from").
//
// score = weighted coverage of the CALL-1 keywords against a resume's text:
//   title match  × 5   (highest single signal — the exact-title effect)
//   must-have    × 3
//   other keyword× 1
// Same normalization on both sides (lowercase, exact-string token match). The gate is only
// required to be MONOTONIC: the tailor's edits are respell / reorder / append, so a tailored
// resume can only gain coverage — never lose it — versus the master. If validation dropped
// everything and tailored somehow scores below master, we serve the master unchanged. That is
// the hard guarantee: the tailored output is never worse than the master.

// Token-complete, case-insensitive presence test. Not glued to a letter/digit on either side,
// and not the head of a dotted compound (so "React" does NOT match inside "React.js"). "/" and
// "-" count as boundaries so multi-word/compound spellings match.
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function mentions(text, term) {
  const t = String(term ?? "").trim();
  if (t.length < 2) return false;
  return new RegExp(`(?<![A-Za-z0-9.])${escRe(t)}(?![A-Za-z0-9])(?!\\.[A-Za-z])`, "i").test(text);
}

/**
 * Weighted coverage score of `resumeText` against a JD analysis.
 * jd = { exact_title, must_haves[], keywords[] }. `keywords` are the general terms; any that
 * are also in must_haves get the higher weight (must-haves win). The title contributes only
 * when it appears in the resume (typically the headline/summary the tailor writes).
 * Returns { score, max, coverage, titleHit, hits:{must,other}, misses:[] }.
 */
export function coverageScore(resumeText, jd) {
  const title = String(jd?.exact_title ?? "").trim();
  const musts = dedupeLc(jd?.must_haves ?? []);
  const mustSet = new Set(musts.map((s) => s.toLowerCase()));
  // General keywords minus the ones already weighted as must-haves.
  const others = dedupeLc(jd?.keywords ?? []).filter((k) => !mustSet.has(k.toLowerCase()));

  const W_TITLE = 5, W_MUST = 3, W_OTHER = 1;
  let score = 0, max = 0, mustHit = 0, otherHit = 0;
  const misses = [];

  if (title) {
    max += W_TITLE;
    if (mentions(resumeText, title)) score += W_TITLE; else misses.push({ term: title, kind: "title" });
  }
  for (const k of musts) {
    max += W_MUST;
    if (mentions(resumeText, k)) { score += W_MUST; mustHit++; } else misses.push({ term: k, kind: "must" });
  }
  for (const k of others) {
    max += W_OTHER;
    if (mentions(resumeText, k)) { score += W_OTHER; otherHit++; } else misses.push({ term: k, kind: "other" });
  }

  const covered = mustHit + otherHit + (title && mentions(resumeText, title) ? 1 : 0);
  const totalTerms = (title ? 1 : 0) + musts.length + others.length;
  return {
    score,
    max,
    coverage: totalTerms ? covered / totalTerms : 1,
    titleHit: title ? mentions(resumeText, title) : false,
    hits: { must: mustHit, mustTotal: musts.length, other: otherHit, otherTotal: others.length },
    misses,
  };
}

const dedupeLc = (arr) => {
  const seen = new Set(), out = [];
  for (const x of arr) {
    const s = String(x ?? "").trim();
    const k = s.toLowerCase();
    if (s && !seen.has(k)) { seen.add(k); out.push(s); }
  }
  return out;
};

/**
 * The gate itself. Given master and tailored resume text and the JD analysis, decide which to
 * ship. `serve` is "tailored" only when it scores strictly higher OR ties (a tie means edits
 * were pure reordering/respelling that didn't move the metric but are still ≥ master); "master"
 * whenever tailored somehow scored lower. Returns everything the badge needs.
 */
export function scoreGate(masterText, tailoredText, jd) {
  const master = coverageScore(masterText, jd);
  const tailored = coverageScore(tailoredText, jd);
  const serve = tailored.score >= master.score ? "tailored" : "master";
  return { serve, master, tailored, delta: tailored.score - master.score };
}

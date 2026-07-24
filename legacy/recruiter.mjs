// Recruiter-scan logic: the "will a human who scans 200 resumes/day stop on this one?"
// layer that sits on top of the honesty-preserving tailor. Everything here is measurement
// and ordering — it never rewrites a claim. Two jobs:
//   1. rankBullets — order a role's bullets so the most JD-relevant + most quantified leads.
//   2. callbackScore — a single 0..100 metric across both ATS gates (surface + human scan).

import { bulletRelevance, makeBulletIdf } from "./relevance.mjs";

// A quantified outcome: %, $, multipliers, time/size units, an "N → M" delta, or any
// 2+ digit number. This is what a recruiter's eye snaps to on the left edge of the page.
export const METRIC_RE =
  /(\$\s?\d)|(\d+(\.\d+)?\s?%)|(\b\d+(\.\d+)?\s?x\b)|(\b\d+\s?(?:s|sec|secs|ms|min|mins|hr|hrs|hours?|days?|weeks?)\b)|(\b\d+(\.\d+)?\s?[kmb]\b)|(\bfrom\s+\d[\s\S]{0,14}?\bto\s+\d)|(\d+\s*(?:→|->|–|—|-)\s*\d+)|(\b\d{2,}\b)/i;

// Seniority / ownership scope signals — "this person drove the thing", not "helped with it".
export const SCOPE_RE =
  /\b(founding|founder|architected|spearheaded|led|owned|drove|shipped|end-to-end|from\s+zero|0\s*(?:→|->)\s*1)\b/i;

/** Does the text carry at least one quantified outcome? */
export function hasMetric(text) {
  return METRIC_RE.test(String(text ?? ""));
}

/** Weighted count of impact signals in a line (metrics count double vs scope words). */
export function impactScore(text) {
  const t = String(text ?? "");
  const metrics = (t.match(new RegExp(METRIC_RE, "gi")) ?? []).length;
  const scope = SCOPE_RE.test(t) ? 1 : 0;
  return metrics * 2 + scope;
}

/**
 * Rank a role's bullets for the recruiter scan. `items` is [{ id, text }] (id is the
 * caller's stable handle — the master line number). Returns the same items sorted best-first
 * with { relevance, impact, score } attached, so the caller can reorder the paragraphs.
 * score = JD relevance (tf-idf cosine) + a bounded impact bonus; relevance leads, but a
 * quantified bullet reliably outranks an unquantified one of similar topical fit.
 */
export function rankBullets(items, jd, idf = null) {
  const _idf = idf ?? makeBulletIdf(jd, items.map((b) => b.text));
  return items
    .map((b) => {
      const relevance = bulletRelevance(b.text, jd, _idf);
      const impact = impactScore(b.text);
      return { ...b, relevance, impact, score: relevance + Math.min(impact, 4) / 4 * 0.6 };
    })
    .sort((a, b) => b.score - a.score);
}

// Clamp helper.
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * A single 0..100 "will this get a callback?" score, blended across both ATS gates:
 *   Gate 1 (surface in search):  exact-title hit, 25-35 keyword band, honest coverage.
 *   Gate 2 (win the 7s scan):    lead punch, impact density up top, keywords-in-context.
 * Inputs are all pre-computed by the caller (which owns the whitelist gate); this stays pure.
 *
 *   summary        final summary string
 *   jdTitle        the JD's exact target title (or "")
 *   roles          [{ mostRecent, bulletTexts:[...] }] in final (post-reorder) order
 *   jdKeywords     array of target JD keyword strings (the placeable universe found in the JD)
 *   placedKeywords array/Set of jdKeywords actually present in the final resume text
 *   bulletKeywords array/Set of jdKeywords present specifically inside bullets (not skills)
 */
export function callbackScore({
  summary = "",
  jdTitle = "",
  roles = [],
  jdKeywords = [],
  placedKeywords = [],
  bulletKeywords = [],
} = {}) {
  const placed = new Set([...placedKeywords].map((k) => k.toLowerCase()));
  const inBullets = new Set([...bulletKeywords].map((k) => k.toLowerCase()));
  const total = jdKeywords.length;

  // Gate 1 — exact title present in the summary (the single biggest callback multiplier).
  // Compare on alphanumerics only so "Full-Stack" / "Fullstack" / "Full Stack" all match.
  const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const titleHit = jdTitle && squash(summary).includes(squash(jdTitle)) ? 1 : 0;

  // Gate 1 — keyword count in the 25-35 sweet spot: ramp up to 25, full 25..35, decay past 35.
  const count = placed.size;
  const keywordBand =
    count <= 25 ? count / 25 : count <= 35 ? 1 : clamp01(1 - (count - 35) / 15);

  // Gate 1 — honest coverage of the placeable JD keywords.
  const coverage = total ? placed.size / total : 1;

  // Gate 2 — lead punch: the most-recent role's first bullet is quantified.
  const recent = roles.find((r) => r.mostRecent) ?? roles[0];
  const leadPunch = recent && recent.bulletTexts?.length && hasMetric(recent.bulletTexts[0]) ? 1 : 0;

  // Gate 2 — impact density in the top half of each role (recruiters read top-down, F-pattern).
  let topSlots = 0, topQuant = 0;
  for (const r of roles) {
    const bts = r.bulletTexts ?? [];
    const half = Math.max(1, Math.ceil(bts.length / 2));
    for (let i = 0; i < half; i++) { topSlots++; if (hasMetric(bts[i])) topQuant++; }
  }
  const impactDensity = topSlots ? topQuant / topSlots : 0;

  // Gate 2 — top JD terms proven inside achievements, not just parked on the skills line.
  const keywordInContext = total ? inBullets.size / total : 0;

  const components = {
    titleHit,         // 0/1
    keywordBand,      // 0..1
    coverage,         // 0..1
    leadPunch,        // 0/1
    impactDensity,    // 0..1
    keywordInContext, // 0..1
    keywordCount: count,
  };

  const score = Math.round(
    100 * (
      0.30 * titleHit +
      0.18 * keywordBand +
      0.12 * coverage +
      0.20 * leadPunch +
      0.10 * impactDensity +
      0.10 * keywordInContext
    ),
  );

  return {
    score,
    components,
    belowBand: count < 25,
    aboveBand: count > 35,
  };
}

import type { KeywordSpec } from "../config.js";
import { CONFIG } from "../config.js";
import type { Job, ScoredJob, KeywordHit } from "./types.js";

/** Escape a string for safe use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match `alias` as a whole token. Boundaries use alphanumeric lookarounds so:
 *  - "java" does NOT match inside "javascript" (next char is a letter), but
 *  - "typescript" DOES match in "TypeScript." (a trailing period is fine), and
 *  - dotted aliases like "next.js" still match (the dot is literal in the alias).
 */
function aliasPresent(haystack: string, alias: string): boolean {
  const a = escapeRe(alias.toLowerCase());
  const re = new RegExp(`(?<![a-z0-9])${a}(?![a-z0-9])`, "i");
  return re.test(haystack);
}

function inferSeniority(text: string): ScoredJob["seniority"] {
  const t = text.toLowerCase();
  if (/(senior|staff|principal|lead|sr\.?|6\+\s*years|[6-9]\+?\s*years|architect)/.test(t)) return "stretch";
  // Word-bounded: unbounded `intern` matched "internal"/"international", which
  // labelled a large share of ordinary JDs "favored" on a stray word.
  if (/(?<![a-z])(junior|fresher|intern|internship|trainee|entry[- ]level|0-1\s*years|graduate)(?![a-z])/.test(t))
    return "favored"; // still worth surfacing
  return "unknown";
}

/** Generic words in titles that carry no role signal (don't help/hurt fit). */
const TITLE_STOP = new Set([
  "sr", "jr", "senior", "junior", "i", "ii", "iii", "iv", "the", "a", "an", "of",
  "and", "for", "with", "to", "in", "at", "job", "jobs", "hiring", "remote",
  "hybrid", "onsite", "contract", "fulltime", "parttime", "years", "yrs", "exp",
]);

/**
 * Normalise a title to a token set for similarity. Collapses the common
 * compound spellings of YOUR target terms (front end↔frontend, react js↔react,
 * etc.) so wording differences don't look like different roles.
 */
function titleTokens(s: string): Set<string> {
  const norm = s
    .toLowerCase()
    .replace(/[._/\\\-]+/g, " ")
    .replace(/\bfront\s*end\b/g, "frontend")
    .replace(/\bback\s*end\b/g, "backend")
    .replace(/\bfull\s*stack\b/g, "fullstack")
    .replace(/\breact\s*js\b/g, "react")
    .replace(/\bnext\s*js\b/g, "next")
    .replace(/\bnode\s*js\b/g, "node")
    .replace(/\bui\s*ux\b/g, "ui");
  return new Set(norm.split(/\s+/).filter((t) => t.length > 1 && !TITLE_STOP.has(t)));
}

// Anchor titles = YOUR declared targets (config), normalised once.
const TARGET_TOKEN_SETS = [...CONFIG.titles, ...CONFIG.linkedinSearchTerms]
  .map(titleTokens)
  .filter((s) => s.size > 0);

export type TitleClass = "frontend" | "fullstack" | "generic";

/**
 * What KIND of role the title describes. Fullstack is checked FIRST so
 * "Full Stack React Developer" classes as fullstack, not frontend — a title
 * that advertises both halves is a fullstack job.
 *
 * Token tests run on the same normalised form as titleTokens(), so "Full-Stack",
 * "Fullstack" and "Full Stack" are one thing, as are React/ReactJS/React.js.
 */
export function classifyTitle(title: string): TitleClass {
  const jt = titleTokens(title);
  // A config phrase matches when every token of its NORMALISED form is present,
  // so "full stack" (→ "fullstack") and "react" (→ "react") both work.
  const has = (phrase: string) => {
    const want = [...titleTokens(phrase)];
    return want.length > 0 && want.every((t) => jt.has(t));
  };
  if (CONFIG.relevance.fullstackTitleTokens.some(has)) return "fullstack";
  if (CONFIG.filter.frontendTitleTokens.some(has)) return "frontend";
  return "generic";
}

/**
 * Does the title itself declare one of your roles (React / Next.js / Frontend),
 * without a disqualifying language in it? See CONFIG.relevance.titleBoost.
 *
 * Both sides are tested on the NORMALISED token set, so "Front-End", "Front
 * End", "ReactJS" and "Next.js" all reduce to the same tokens as the config
 * entries. Disqualifiers are checked with the alias rule instead of the token
 * set, because ".net" and "c#" don't survive tokenisation.
 */
export function titleBoosted(title: string): boolean {
  const b = CONFIG.relevance.titleBoost;
  if (!b.enabled) return false;
  const jt = titleTokens(title);
  const hasToken = (phrase: string) => {
    const want = [...titleTokens(phrase)];
    return want.length > 0 && want.every((t) => jt.has(t));
  };
  if (!b.tokens.some(hasToken)) return false;
  const t = title.toLowerCase();
  return !b.disqualifiers.some((d) => aliasPresent(t, d));
}

/**
 * Does this JD ask for nothing outside your stack? See CONFIG.relevance.purity.
 *
 * `anchored` and `backendGroups` come from stackProfile()/backendMass() so the
 * three tests read the same JD text: React or TypeScript is named, no foreign
 * backend group is, and the title carries no disqualifying language.
 */
export function stackPure(title: string, backendGroups: string[], anchored: boolean): boolean {
  if (!CONFIG.relevance.purity.enabled) return false;
  if (!anchored || backendGroups.length > 0) return false;
  const t = title.toLowerCase();
  return !CONFIG.relevance.titleBoost.disqualifiers.some((d) => aliasPresent(t, d));
}

/** Best Jaccard similarity of a title against your anchor titles, in [0,1]. */
function titleSimilarity(title: string): number {
  const jt = titleTokens(title);
  if (jt.size === 0) return 0;
  let best = 0;
  for (const tt of TARGET_TOKEN_SETS) {
    let inter = 0;
    for (const t of jt) if (tt.has(t)) inter++;
    const sim = inter / (jt.size + tt.size - inter); // Jaccard
    if (sim > best) best = sim;
  }
  return best;
}

/**
 * Title multiplier: the CLASS sets the band (frontend 1.0 / fullstack 0.85 /
 * generic 0.8) and similarity to your target wording only breaks ties WITHIN
 * that band. See CONFIG.relevance for why this replaced raw Jaccard.
 *
 * `pure` (CONFIG.relevance.purity) promotes the two non-frontend classes into
 * their own higher bands when the JD asks for nothing outside your stack. The
 * frontend class is already at the top and is unaffected.
 */
export function titleRelevance(title: string, pure = false): number {
  const r = CONFIG.relevance;
  const cls = classifyTitle(title);
  let base: number = r.titleClass[cls];
  if (pure && cls === "fullstack") base = r.purity.fullstackClean;
  else if (pure && cls === "generic") base = r.purity.genericClean;
  return base - r.tiebreak * (1 - titleSimilarity(title));
}

/** Best-effort required-experience band from free text (for sources without a structured field). */
function parseExperienceYears(text: string): string | null {
  if (!text) return null;
  const t = text.toLowerCase();
  const range = t.match(/(\d{1,2})\s*(?:-|to|–|—)\s*(\d{1,2})\s*\+?\s*(?:years|yrs|year|yr)\b/);
  if (range) return `${range[1]}-${range[2]} yrs`;
  const single = t.match(/(?:minimum|min|at least|over|atleast)?\s*(\d{1,2})\s*\+\s*(?:years|yrs|year|yr)\b/);
  if (single) return `${single[1]}+ yrs`;
  return null;
}

/**
 * Framework implications: a JD that demonstrates the KEY skill also demonstrably
 * uses the VALUE skills, even when it never spells them out. Next.js is a React
 * meta-framework — a pure-Next.js posting IS a React role — so without this a
 * "we build on Next.js" JD loses the React core keyword (weight 5), which pulls
 * genuine frontend roles down to just above the score floor. Keyed/valued by the
 * KeywordSpec.label (not alias), and only ever ADDS credit, never removes it.
 */
const IMPLIES: Record<string, string[]> = {
  "Next.js": ["React"],
};

/**
 * How much BACKEND the JD asks for, as distinct technology GROUPS (see
 * CONFIG.backendPenalty for the rationale and why it counts groups, not tokens).
 * Returns the matched group labels plus the multiplier to apply to the score.
 */
export function backendMass(hay: string): { groups: string[]; multiplier: number } {
  const bp = CONFIG.backendPenalty;
  if (!bp.enabled) return { groups: [], multiplier: 1 };
  const groups = bp.groups
    .filter((g) => g.aliases.some((a) => aliasPresent(hay, a)))
    .map((g) => g.label);
  return { groups, multiplier: 1 - Math.min(bp.max, bp.perGroup * groups.length) };
}

/**
 * How much of YOUR WHOLE STACK, as a set of distinct items, this JD describes —
 * see CONFIG.stackProfile for the reasoning, the anchor gate and the sizing.
 *
 * Returns the matched item labels, the points to ADD to the score, and whether
 * the anchor gate opened, so the dashboard can explain a zero ("6 of your stack
 * matched, but no React/TypeScript — no bonus") instead of silently withholding
 * it. `hits` always lists the ungated matches even when unanchored; gated items
 * (Mongo/Docker/AWS/…) are not reported at all without an anchor, because
 * outside a React stack they are not evidence of anything.
 */
export function stackProfile(hay: string): { hits: string[]; bonus: number; anchored: boolean } {
  const sp = CONFIG.stackProfile;
  if (!sp.enabled) return { hits: [], bonus: 0, anchored: false };

  const anchored = sp.anchors.some((a) => aliasPresent(hay, a));
  const hits = sp.items
    .filter((it) => (anchored || !it.gated) && it.aliases.some((a) => aliasPresent(hay, a)))
    .map((it) => it.label);

  // No React and no TypeScript ⇒ nothing to overlap with, so nothing is paid,
  // however many items happened to match.
  const bonus = anchored ? Math.min(sp.max, Math.max(0, hits.length - sp.free) * sp.perItem) : 0;
  return { hits, bonus: Math.round(bonus), anchored };
}

/**
 * Reverse-ATS scoring: tiered match % of the keyword set against the job's
 * title + description. Instead of a flat gained/total (which compresses every
 * good role near ~60% because no JD lists the whole long tail), we score each
 * TIER's coverage separately and blend by CONFIG.scoreWeights. Full coverage of
 * your CORE skills (React/TS/JS) alone earns the core share (~60%), so a
 * genuine frontend role lands at 80-95%. Only tier!="ignore" keywords count.
 */
export function scoreJob(job: Job, keywords: KeywordSpec[]): ScoredJob {
  const hay = `${job.title}\n${job.tags.join(" ")}\n${job.description}`.toLowerCase();

  const scored = keywords.filter((k) => k.weight > 0 && k.tier !== "ignore");

  const matched: KeywordHit[] = [];
  const unmatched: string[] = [];
  // Per-tier got/total weight, so coverage is measured within each tier.
  const tiers: Record<"core" | "strong" | "bonus", { got: number; total: number }> = {
    core: { got: 0, total: 0 },
    strong: { got: 0, total: 0 },
    bonus: { got: 0, total: 0 },
  };

  // Pass 1: direct alias matches, then expand via framework implications
  // (Next.js ⇒ React). Implied hits count exactly like a direct hit below.
  const hitLabels = new Set<string>();
  for (const k of scored) if (k.aliases.some((a) => aliasPresent(hay, a))) hitLabels.add(k.label);
  for (const label of [...hitLabels])
    for (const implied of IMPLIES[label] ?? []) hitLabels.add(implied);

  for (const k of scored) {
    const bucket = tiers[k.tier as "core" | "strong" | "bonus"];
    bucket.total += k.weight;
    if (hitLabels.has(k.label)) {
      matched.push({ label: k.label, weight: k.weight });
      bucket.got += k.weight;
    } else {
      unmatched.push(k.label);
    }
  }

  const cov = (t: "core" | "strong" | "bonus") => (tiers[t].total === 0 ? 0 : tiers[t].got / tiers[t].total);
  const w = CONFIG.scoreWeights;
  const skillPct = 100 * (w.core * cov("core") + w.strong * cov("strong") + w.bonus * cov("bonus"));
  // Composite: skill match, scaled by what KIND of role the title is, then
  // discounted by how much backend the JD actually asks for. Both scalers can
  // only ever REDUCE a score, so a pure frontend role is never taxed.
  const titleClass = classifyTitle(job.title);
  const backend = backendMass(hay);
  // Stack-profile bonus rides on TOP of the multipliers, not through them: it
  // measures set overlap, and taxing it by title class would double-count the
  // discount the tier score already took.
  //
  // It gets its own HEADROOM rather than being clamped at 100: the tier score is
  // compressed into 0…(100 - stackProfile.max) and the bonus fills the rest, so
  // the scale still ends at 100 and a full-stack match still tops out — but the
  // best jobs keep their order instead of piling up on a clamp (measured on the
  // stored 5,724 JDs, clamping tied 105 rows at exactly 100).
  const stack = stackProfile(hay);
  // Purity needs both scalers' evidence, so it is computed after them and only
  // ever RAISES the title multiplier (see CONFIG.relevance.purity).
  const pure = stackPure(job.title, backend.groups, stack.anchored);
  const headroom = CONFIG.stackProfile.enabled ? (100 - CONFIG.stackProfile.max) / 100 : 1;
  const composite = Math.min(
    100,
    Math.round(skillPct * titleRelevance(job.title, pure) * backend.multiplier * headroom) + stack.bonus,
  );
  // A title that literally says React/Next.js/Frontend (and doesn't say Java,
  // Python, .NET…) can never score below the boost floor, however thin the JD
  // is. Only ever raises — a strong JD keeps the score it earned, and the
  // ordering among boosted jobs is still their real composite.
  const boosted = titleBoosted(job.title);
  const score = boosted ? Math.max(composite, CONFIG.relevance.titleBoost.floor) : composite;
  matched.sort((a, b) => b.weight - a.weight);

  return {
    ...job,
    matched,
    unmatched,
    score,
    stackHits: stack.hits,
    stackBonus: stack.bonus,
    stackAnchored: stack.anchored,
    titleClass,
    titleBoosted: boosted,
    stackPure: pure,
    backendGroups: backend.groups,
    seniority: inferSeniority(hay),
    // Structured band from the source (Naukri) wins; else parse from the JD text.
    experience: job.experience ?? parseExperienceYears(job.description) ?? null,
  };
}

export function scoreAll(jobs: Job[], keywords: KeywordSpec[]): ScoredJob[] {
  return jobs.map((j) => scoreJob(j, keywords)).sort((a, b) => b.score - a.score);
}

export { CONFIG };

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
  if (/(junior|fresher|intern|entry[- ]level|0-1\s*years|graduate)/.test(t)) return "favored"; // still worth surfacing
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
 */
export function titleRelevance(title: string): number {
  const r = CONFIG.relevance;
  const base = r.titleClass[classifyTitle(title)];
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
 * Reverse-ATS scoring: tiered match % of the keyword set against the job's
 * title + description. Instead of a flat gained/total (which compresses every
 * good role near ~60% because no JD lists the whole long tail), we score each
 * TIER's coverage separately and blend by CONFIG.scoreWeights. Full coverage of
 * your CORE skills (React/Next/TS/JS) alone earns the core share (~60%), so a
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
  const score = Math.round(skillPct * titleRelevance(job.title) * backend.multiplier);
  matched.sort((a, b) => b.weight - a.weight);

  return {
    ...job,
    matched,
    unmatched,
    score,
    titleClass,
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

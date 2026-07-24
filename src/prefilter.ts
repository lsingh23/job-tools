import { CONFIG } from "../config.js";
import type { Job } from "./types.js";

/**
 * Normalise a job title for reliable frontend signal detection.
 *
 * Collapses all the common variation forms seen in Indian job postings:
 *   separators   →  "React.js"  "React-JS"  "React/JS"   all yield "react"
 *   multi-word   →  "React JS"  "Front End"  "UI UX"
 *   concatenated →  "ReactJS"   "NextJS"     "NodeJS"  (no separator at all)
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[._/\\\-]+/g, " ")            // separators → space
    .replace(/\bfront\s+end\b/g, "frontend")
    .replace(/\breact\s+js\b/g, "react")
    .replace(/\bnext\s+js\b/g, "next")
    .replace(/\bnode\s+js\b/g, "node")
    .replace(/\bui\s+ux\b/g, "ui")
    // Concatenated (no-separator) framework names
    .replace(/\breactjs\b/g, "react")
    .replace(/\bnextjs\b/g, "next")
    .replace(/\bnodejs\b/g, "node")
    .replace(/\bvuejs\b/g, "vue")
    .replace(/\bangularjs\b/g, "angular")
    .replace(/\bsveltejs\b/g, "svelte")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Normalise a config pattern to be compared against a normalised title. */
function normalizePattern(p: string): string {
  return p
    .toLowerCase()
    .replace(/\\+\./g, ".")              // un-escape regex dots like \\.net → .net
    .replace(/[._/\\\-]+/g, " ")        // separators → space (mirrors title)
    .replace(/[*+?^${}()|[\]\\]+/g, " ") // strip remaining regex metacharacters
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Word-boundary token presence test on already-normalised strings. */
function hasToken(haystack: string, token: string): boolean {
  const p = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![a-z0-9])${p}(?![a-z0-9])`).test(haystack);
}

export interface PrefilterResult {
  kept: Job[];
  dropped: { job: Job; reason: string }[];
}

/**
 * Keyword-based title pre-filter.
 *
 * Removes definite non-target roles BEFORE the expensive enrichment step.
 * Uses CONFIG.filter lists with title normalisation applied first, so all
 * spelling variants are handled correctly.
 *
 * Order of checks (conservative by design — false negatives are worse than
 * false positives here; filterJobs() is the final gate):
 *   1. Frontend signal present → KEEP immediately (wins over everything else).
 *      Handles: React Native, React + Node, React + Java fullstack, etc.
 *   2. Hard reject token (Vue, Angular, Android, QA, PM…) → DROP.
 *   3. Backend-leaning token with no frontend signal → DROP.
 *   4. Ambiguous title ("Software Engineer") → KEEP (let scorer decide).
 */
export function prefilterByTitle(jobs: Job[]): PrefilterResult {
  const f = CONFIG.filter;

  const frontendPatterns = f.frontendTitleTokens.map(normalizePattern);
  const rejectPatterns = f.rejectTitles.map(normalizePattern);
  const backendPatterns = f.backendTitles.map(normalizePattern);

  const kept: Job[] = [];
  const dropped: { job: Job; reason: string }[] = [];

  for (const job of jobs) {
    const norm = normalizeTitle(job.title);

    // 1) Hard reject — competing frameworks / stacks / non-engineering roles.
    //    These win even if a generic "frontend" or "ui" token is also present,
    //    so "Angular Front-End Developer" is correctly dropped.
    const reject = rejectPatterns.find((p) => hasToken(norm, p));
    if (reject) {
      dropped.push({ job, reason: `off-target (${reject})` });
      continue;
    }

    // 2) Backend-leaning title with NO frontend signal → drop.
    //    "React + Node.js Developer" has "react" → KEEP.
    //    "Node.js Developer" alone          → DROP.
    //    "React Native Developer" → "react" present → KEEP (react native is not
    //    in rejectTitles so it reaches here and is saved by the frontend check).
    const backend = backendPatterns.find((p) => hasToken(norm, p));
    if (backend && !frontendPatterns.some((p) => hasToken(norm, p))) {
      dropped.push({ job, reason: `backend-only (${backend})` });
      continue;
    }

    // 3) Ambiguous ("Software Engineer", "Full Stack") → keep and let the
    //    scorer + filterJobs() decide.
    kept.push(job);
  }

  return { kept, dropped };
}

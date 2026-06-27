import { CONFIG } from "../config.js";
import type { ScoredJob } from "./types.js";

/**
 * Post-scoring FILTER → turns the ranked list into a genuine SHORTLIST by
 * DROPPING jobs that don't fit, rather than just ranking them lower:
 *   1. off-target titles (Vue/Angular/Android/.NET/PM/QA/… — keyword bleed
 *      can't rescue these),
 *   2. backend-leaning titles with no frontend signal in the title,
 *   3. roles whose REQUIRED MINIMUM experience is too senior for a 3-4y target,
 *   4. low overall fit (score below CONFIG.filter.minScore).
 * All knobs live in CONFIG.filter so tuning is a one-file edit.
 */

export interface DroppedJob {
  job: ScoredJob;
  reason: string;
}
export interface FilterResult {
  kept: ScoredJob[];
  dropped: DroppedJob[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-token presence test, same alphanumeric-boundary rule the scorer uses
 * for aliases — so "go developer" matches but "logo" doesn't, "c++"/".net"
 * match literally, and internal spaces tolerate any whitespace run.
 */
function patternPresent(haystack: string, pattern: string): boolean {
  const p = escapeRe(pattern.toLowerCase()).replace(/\s+/g, "\\s+");
  const re = new RegExp(`(?<![a-z0-9])${p}(?![a-z0-9])`, "i");
  return re.test(haystack);
}

/** Senior-ish title words used only when no structured experience band exists. */
const SENIOR_TITLE = /(?<![a-z])(senior|sr\.?|staff|principal|lead|architect)(?![a-z])/i;

/** Required MINIMUM years from a band like "3-5 Yrs" → 3, "10+ yrs" → 10. */
function minRequiredYears(job: ScoredJob): number | null {
  const band = job.experience;
  if (!band) return null;
  const t = band.toLowerCase();
  const range = t.match(/(\d{1,2})\s*(?:-|to|–|—)\s*\d{1,2}/);
  if (range) return parseInt(range[1]!, 10);
  const plus = t.match(/(\d{1,2})\s*\+/);
  if (plus) return parseInt(plus[1]!, 10);
  const single = t.match(/(\d{1,2})/);
  if (single) return parseInt(single[1]!, 10);
  return null;
}

export function filterJobs(jobs: ScoredJob[]): FilterResult {
  const f = CONFIG.filter;
  const kept: ScoredJob[] = [];
  const dropped: DroppedJob[] = [];
  if (!f.enabled) return { kept: jobs, dropped };

  for (const job of jobs) {
    const title = job.title.toLowerCase();

    // 1) hard off-target title — drops regardless of keyword matches in the JD.
    const offTarget = f.rejectTitles.find((p) => patternPresent(title, p));
    if (offTarget) {
      dropped.push({ job, reason: `off-target title (${offTarget})` });
      continue;
    }

    // 2) backend-leaning title with no frontend signal ("Node.js Developer" out,
    //    "React / Node.js Developer" stays because "react" is present).
    const backend = f.backendTitles.find((p) => patternPresent(title, p));
    if (backend && !f.frontendTitleTokens.some((p) => patternPresent(title, p))) {
      dropped.push({ job, reason: `backend-leaning title (${backend})` });
      continue;
    }

    // 3) experience too senior. A structured band wins; else fall back to a
    //    senior-ish title word (which implies 5y+ when no band is given).
    const min = minRequiredYears(job);
    if (min !== null && min >= f.maxRequiredYears) {
      dropped.push({ job, reason: `needs ${min}+ yrs (target 3-4)` });
      continue;
    }
    if (min === null && SENIOR_TITLE.test(title)) {
      dropped.push({ job, reason: "senior title, no junior-friendly band" });
      continue;
    }

    // 4) low overall fit.
    if (job.score < f.minScore) {
      dropped.push({ job, reason: `score ${job.score} < ${f.minScore}` });
      continue;
    }

    kept.push(job);
  }

  return { kept, dropped };
}

import { CONFIG, KEYWORDS } from "../config.js";
import { classifyTitle, titleBoosted } from "./scoring.js";
import type { ScoredJob, Penalty } from "./types.js";

/**
 * RANKING, not filtering.
 *
 * This file used to produce a shortlist by DROPPING: off-target title, backend
 * title, too-senior, score below a floor — each one a `continue` that deleted the
 * job. Every drop was a guess made from partial information, and a wrong guess
 * was both invisible (a line in a log nobody reads) and permanent.
 *
 * It now converts every one of those signals into a POINT PENALTY on the 0-100
 * match %, records the reason on the job, and returns everything. Bad jobs sink;
 * they don't disappear. The dashboard folds the bottom of the list away, so the
 * default view is still a shortlist — but the "shortlist" is now a scroll
 * position instead of a deletion, and every judgement is visible and reversible.
 *
 * Penalties applied (all sized in CONFIG.penalties):
 *   - off-target title      Vue / Android / .NET / QA / PM / data science …
 *   - backend-leaning title "Node.js Developer" with no frontend signal
 *   - over-experience       per year above CONFIG.filter.maxRequiredYears
 *   - top-of-ladder title   staff / principal / architect / head / VP, no years
 *   - internship title      "Frontend Developer Intern", trainee, apprentice
 *   - no core skill         JD names none of React / Next / TS / JS
 *   - mass recruiter        staffing agency or marketplace, not the employer
 *   - fake poster           known lead-harvesting listing (Flexiple, Jobgether…)
 *   - bulk posting          same company flooding one collection
 *
 * The ONLY thing that still leaves the list is a job we never fetched the JD
 * for — and that is not a verdict, it's an unread card: it is kept with
 * `jdMissing` so you can open the link, and re-fetched by a later run.
 */

/** Core-tier keyword labels (React/Next.js/TypeScript/JavaScript). */
const CORE_LABELS = new Set(KEYWORDS.filter((k) => k.tier === "core").map((k) => k.label));

/** How many core skills the JD actually names. */
function coreHits(job: ScoredJob): number {
  return job.matched.reduce((n, m) => n + (CORE_LABELS.has(m.label) ? 1 : 0), 0);
}

export interface DroppedJob {
  job: ScoredJob;
  reason: string;
}
export interface FilterResult {
  kept: ScoredJob[];
  /** Always empty now — kept in the shape so callers/scripts still compile. */
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

/**
 * Top-of-ladder title words. NOT the same as "senior": these describe a rung a
 * 3-4y candidate genuinely cannot reach, whereas "Senior/Sr/Lead Frontend
 * Developer" in the Indian market is routinely a 3-4y posting — which is why
 * senior/sr/lead carry no penalty at all.
 */
const TOP_TITLE = /(?<![a-z])(staff|principal|architect|head\s+of|director|vp|vice\s+president)(?![a-z])/i;

/** Parse the minimum of a years expression: "3-5" → 3, "10+" → 10, "6" → 6. */
function parseYears(t: string): number | null {
  const range = t.match(/(\d{1,2})\s*(?:-|to|–|—)\s*\d{1,2}/);
  if (range) return parseInt(range[1]!, 10);
  const plus = t.match(/(\d{1,2})\s*\+/);
  if (plus) return parseInt(plus[1]!, 10);
  const single = t.match(/(\d{1,2})/);
  if (single) return parseInt(single[1]!, 10);
  return null;
}

/**
 * Years of experience the role REQUIRES AT MINIMUM, or null if it never says.
 *
 * The structured band wins when present. Otherwise the JD text is read for the
 * usual phrasings ("5+ years of experience", "minimum 6 years", "at least 4
 * years") — most LinkedIn posts state years in prose and expose no band at all,
 * so without this the experience signal had no data and fell back to guessing
 * from title words.
 *
 * Takes the LOWEST number found: a JD asking "3+ years in React, 5+ years in web
 * development" is open to a 3y candidate.
 */
export function minRequiredYears(job: ScoredJob): number | null {
  if (job.experience) {
    const fromBand = parseYears(job.experience.toLowerCase());
    if (fromBand !== null) return fromBand;
  }
  const text = (job.description || "").toLowerCase();
  if (!text) return null;
  const found: number[] = [];
  // "3-5 years", "5+ years", "minimum 4 years", "at least 4 yrs", "4 years of experience"
  const re = /(?:(?:minimum|min|at\s+least|over|more\s+than)\s+)?(\d{1,2}\s*(?:\+|(?:-|to|–|—)\s*\d{1,2})?)\s*(?:\+\s*)?(?:years?|yrs?)\b/g;
  for (const m of text.matchAll(re)) {
    const n = parseYears(m[1]!);
    // Sanity band: "20 years" is boilerplate about the company, "0 years" is noise.
    if (n !== null && n >= 1 && n <= 15) found.push(n);
  }
  return found.length ? Math.min(...found) : null;
}

/**
 * Days since the posting went live, or null when the source never said. A
 * future-dated or unparseable stamp reads as null rather than as a negative age.
 */
export function jobAgeDays(job: { postedAt?: string | null }): number | null {
  if (!job.postedAt) return null;
  const t = new Date(job.postedAt).getTime();
  if (!Number.isFinite(t)) return null;
  const days = (Date.now() - t) / 86_400_000;
  return days < 0 ? null : days;
}

/**
 * Dashboard-only hard hide, applied to stored rows at read time (so it also
 * cleans rows collected before this rule existed). The scorer only PENALISES
 * these; on the dashboard they are pure noise:
 *  - asks for ≥ filter.maxRequiredYears (the "needs 5+ yrs" / stretch rows)
 *  - title is an internship / traineeship (filter.internTitles)
 *  - company is in CONFIG.blockedCompanies (the pipeline drops these at
 *    collection, but hot checks / ATS bypass it and older rows predate entries)
 */
export function hiddenOnDashboard(row: { title?: unknown; company?: unknown; experience?: unknown; penalties?: unknown }): boolean {
  const f = CONFIG.filter;
  if (isBlockedCompany(String(row.company ?? ""))) return true;
  const title = String(row.title ?? "");
  if (f.internTitles.some((x) => patternPresent(title, x))) return true;
  const pens = Array.isArray(row.penalties) ? (row.penalties as Penalty[]) : [];
  for (const p of pens) {
    const m = /^needs (\d+)\+ yrs$/.exec(String(p?.label ?? ""));
    if (m && Number(m[1]) >= f.maxRequiredYears) return true;
    if (String(p?.label ?? "").startsWith("internship")) return true;
  }
  const min = minRequiredYears({ experience: row.experience ? String(row.experience) : undefined } as ScoredJob);
  return min !== null && min >= f.maxRequiredYears;
}

/** Company name, normalised for comparison: lowercase, no punctuation or suffixes. */
function normCompany(name: string): string {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(pvt|private|ltd|limited|llp|inc|corp|corporation|co|technologies|technology|solutions|services|india|global|group)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Is this one of the known fake / lead-harvesting posters? Returns the matched
 * name so the penalty can say which. See CONFIG.fakePosters.
 */
export function isFakePoster(company: string): string | null {
  const raw = (company || "").toLowerCase();
  if (!raw.trim()) return null;
  return CONFIG.fakePosters.names.find((n) => patternPresent(raw, n)) ?? null;
}

/** Is this a staffing agency / marketplace rather than the hiring company? */
export function isMassRecruiter(company: string): string | null {
  const raw = (company || "").toLowerCase();
  if (!raw.trim()) return null;
  const m = CONFIG.massRecruiters;
  const name = m.names.find((n) => patternPresent(raw, n));
  if (name) return name;
  // Patterns are substrings, not whole tokens: "…Staffing Solutions" and
  // "Outsourcing" both need to hit.
  const pat = m.patterns.find((p) => raw.includes(p.toLowerCase()));
  return pat ?? null;
}

/**
 * Is this a company the user has hard-blocked? See CONFIG.blockedCompanies —
 * a deliberate exception to "penalize, don't drop": unlike mass recruiters or
 * fake posters, these are real employers excluded purely on user preference.
 */
export function isBlockedCompany(company: string): string | null {
  const raw = (company || "").toLowerCase();
  if (!raw.trim()) return null;
  return CONFIG.blockedCompanies.find((n) => patternPresent(raw, n)) ?? null;
}

/**
 * Enrich priority: which cards deserve the limited JD-fetch budget first.
 * Higher is better. A title that already looks wrong sorts last, so the budget
 * is spent reading the jobs most likely to be worth reading — the old prefilter
 * did this by DELETING those cards; now it only reorders them.
 */
export function enrichPriority(job: { title: string; company?: string }): number {
  const t = job.title.toLowerCase();
  const f = CONFIG.filter;
  let p = 0;
  const cls = classifyTitle(job.title);
  p += cls === "frontend" ? 3 : cls === "fullstack" ? 2 : 1;
  if (f.rejectTitles.some((r) => patternPresent(t, r))) p -= 5;
  if (f.internTitles.some((x) => patternPresent(t, x))) p -= 5;
  if (f.backendTitles.some((b) => patternPresent(t, b)) &&
      !f.frontendTitleTokens.some((x) => patternPresent(t, x))) p -= 3;
  if (titleBoosted(job.title)) p += 2; // a React/Next/Frontend title is read first
  if (job.company && isMassRecruiter(job.company)) p -= 1;
  if (job.company && isFakePoster(job.company)) p -= 5; // never spend budget reading these
  return p;
}

/**
 * Score every job, apply the penalties, sort best-first. Returns ALL jobs.
 *
 * `dropped` is always empty; it exists so the CLI and scripts that destructure
 * `{ kept, dropped }` keep working unchanged.
 */
export function rankJobs(jobs: ScoredJob[]): FilterResult {
  const f = CONFIG.filter;
  const p = CONFIG.penalties;
  if (!f.enabled || !p.enabled) return { kept: jobs, dropped: [] };

  // Bulk-posting counts, computed over the whole batch before scoring any row.
  const perCompany = new Map<string, number>();
  for (const j of jobs) {
    const key = normCompany(j.company);
    if (key) perCompany.set(key, (perCompany.get(key) ?? 0) + 1);
  }

  for (const job of jobs) {
    const title = job.title.toLowerCase();
    const penalties: Penalty[] = [];

    // 1) Title names a different discipline. Heaviest penalty — but a JD full of
    //    React can still lift it back into view, which a drop could never do.
    const offTarget = f.rejectTitles.find((x) => patternPresent(title, x));
    if (offTarget) penalties.push({ label: `off-target title (${offTarget})`, points: p.offTargetTitle });

    // 2) Backend-leaning title with no frontend signal.
    const backend = f.backendTitles.find((x) => patternPresent(title, x));
    if (backend && !f.frontendTitleTokens.some((x) => patternPresent(title, x)))
      penalties.push({ label: `backend title (${backend})`, points: p.backendTitle });

    // 3) Internship / traineeship. Title-only, and it must be its own rule:
    //    "Frontend Developer Intern" is a frontend title with a React JD, so
    //    every other signal in the scorer reads it as a great match.
    const intern = f.internTitles.find((x) => patternPresent(title, x));
    if (intern) penalties.push({ label: `internship (${intern})`, points: p.internTitle });

    // 4) Experience, scaled by HOW FAR over the target it is: a 5y ask is a
    //    stretch, a 12y ask is a different career stage.
    const min = minRequiredYears(job);
    if (min !== null && min >= f.maxRequiredYears) {
      const over = min - f.maxRequiredYears + 1;
      penalties.push({ label: `needs ${min}+ yrs`, points: Math.min(over * p.perYearOver, p.maxYearsOver) });
    } else if (min === null && TOP_TITLE.test(title)) {
      penalties.push({ label: `${title.match(TOP_TITLE)![1]} role, no stated years`, points: p.topTitleNoYears });
    }

    // 5) JD names none of your core skills. Skipped when there is no JD at all —
    //    that is an unread card (below), not a job that failed a test — and also
    //    when the TITLE already names a core skill (relevance.titleBoost): a
    //    one-line "Front End Developer" post whose JD never spells out React is
    //    a thin JD, not a role without frontend in it, and charging it 20 points
    //    here would take back most of what the boost floor just granted.
    if (job.description && coreHits(job) === 0 && !titleBoosted(job.title))
      penalties.push({ label: "no core skill in JD", points: p.noCoreSkill });

    // 6) Staffing agency / marketplace rather than the employer.
    const agency = isMassRecruiter(job.company);
    if (agency) penalties.push({ label: `mass recruiter (${agency})`, points: p.massRecruiter });

    // 6b) Known fake poster: the listing exists to harvest profiles, not to
    //     fill a seat. Stacks with (6) on purpose — several of these also read
    //     as staffing outfits, and both things being true is worse, not equal.
    const fake = isFakePoster(job.company);
    if (fake) penalties.push({ label: `fake/lead-collecting poster (${fake})`, points: p.fakePoster });

    // 7) Bulk posting: this company flooded the run with roles.
    const n = perCompany.get(normCompany(job.company)) ?? 0;
    if (n > p.floodFrom)
      penalties.push({
        label: `${n} roles from this company in one run`,
        points: Math.min((n - p.floodFrom) * p.floodPer, p.floodMax),
      });

    // 8) Staleness. Only the ATS boards carry a real postedAt, and they carry
    //    ones measured in years — see penalties.staleFreeDays. Unknown age is
    //    not penalised: LinkedIn is already fetched inside a 2h f_TPR window,
    //    so a null there means "fresh by construction", not "old".
    const ageDays = jobAgeDays(job);
    if (ageDays !== null && ageDays > p.staleFreeDays) {
      const weeks = Math.ceil((ageDays - p.staleFreeDays) / 7);
      const label =
        ageDays >= 365 ? `posted ${Math.floor(ageDays / 365)}y ago`
        : ageDays >= 60 ? `posted ${Math.floor(ageDays / 30)}mo ago`
        : `posted ${Math.round(ageDays)}d ago`;
      penalties.push({ label, points: Math.min(weeks * p.stalePerWeek, p.staleMax) });
    }

    // Never read this card's JD (past the enrich cap, or the fetch failed). Not
    // a verdict — flagged so the UI shows "JD?" instead of a score that would
    // read as "bad match", and so a later run re-fetches it.
    job.jdMissing = !job.description;

    // Apply. baseScore keeps the pre-penalty match % so the dashboard can show
    // "78 → 33" and you can see exactly what the penalties cost.
    const total = penalties.reduce((s, x) => s + x.points, 0);
    job.baseScore = job.score;
    job.penalties = penalties;
    job.score = Math.max(0, job.score - total);
  }

  const kept = [...jobs].sort((a, b) => b.score - a.score);
  return { kept, dropped: [] };
}

/** Back-compat alias — every caller now gets a ranked list and an empty `dropped`. */
export const filterJobs = rankJobs;

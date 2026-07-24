/**
 * Score-calibration harness. First run fetches+enriches all cities and caches
 * the jobs to scratchpad JSON; later runs reuse it (instant). For every job it
 * prints the coverage breakdown and the score under CURRENT vs PROPOSED knobs,
 * so we can tune scoreWeights + titleFitFloor to put genuine top jobs at 90+.
 *
 *   node --env-file=.env --import tsx scripts/score-tune.ts
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { CONFIG, KEYWORDS } from "../config.js";
import { fetchLinkedInCards, type LinkedInLocation } from "../src/pipeline.js";
import { prefilterByTitle } from "../src/prefilter.js";
import { enrichLinkedInJobs } from "../src/sources/linkedin.js";
import { titleRelevance, classifyTitle, backendMass } from "../src/scoring.js";
import type { Job } from "../src/types.js";

const CACHE = "/private/tmp/claude-501/-Users-lakhveer-Desktop-job-tools/4e53951d-161e-4038-a70a-ac3fb6c6bf54/scratchpad/tune-jobs.json";
const log = (...a: unknown[]) => process.stderr.write(a.join(" ") + "\n");

let jobs: Job[];
if (existsSync(CACHE)) {
  jobs = JSON.parse(readFileSync(CACHE, "utf8"));
  log(`[cache] loaded ${jobs.length} enriched jobs from disk`);
} else {
  const union = new Map<string, Job>();
  for (const loc of CONFIG.locations.linkedin as readonly LinkedInLocation[]) {
    log(`[fetch] ${loc.label}…`);
    const cards = await fetchLinkedInCards(loc, { hours: CONFIG.collect.windowHours, pages: CONFIG.collect.pages, sortBy: CONFIG.linkedinParams.sortBy });
    for (const j of cards) if (!union.has(j.externalId)) union.set(j.externalId, j);
  }
  const { kept } = prefilterByTitle([...union.values()]);
  await enrichLinkedInJobs(kept);
  jobs = kept;
  writeFileSync(CACHE, JSON.stringify(jobs));
  log(`[cache] saved ${jobs.length} enriched jobs`);
}

// ── scoring, parameterised by weights + titleFitFloor ────────────────────────
function esc(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function hit(hay: string, alias: string) {
  return new RegExp(`(?<![a-z0-9])${esc(alias.toLowerCase())}(?![a-z0-9])`, "i").test(hay);
}
const IMPLIES: Record<string, string[]> = { "Next.js": ["React"] };

function coverage(job: Job) {
  const hay = `${job.title}\n${(job.tags ?? []).join(" ")}\n${job.description}`.toLowerCase();
  const scored = KEYWORDS.filter((k) => k.weight > 0 && k.tier !== "ignore");
  const labels = new Set<string>();
  for (const k of scored) if (k.aliases.some((a) => hit(hay, a))) labels.add(k.label);
  for (const l of [...labels]) for (const im of IMPLIES[l] ?? []) labels.add(im);
  const t: Record<string, { got: number; total: number }> = { core: { got: 0, total: 0 }, strong: { got: 0, total: 0 }, bonus: { got: 0, total: 0 } };
  for (const k of scored) { const b = t[k.tier]; b.total += k.weight; if (labels.has(k.label)) b.got += k.weight; }
  const cov = (x: string) => (t[x].total === 0 ? 0 : t[x].got / t[x].total);
  return { core: cov("core"), strong: cov("strong"), bonus: cov("bonus") };
}

/**
 * Title multiplier and backend discount come straight from scoring.ts (they are
 * class-based now, not a recoverable floor formula), so only the TIER WEIGHTS
 * are parameterised here. To try different class multipliers / penalty rates,
 * edit CONFIG.relevance / CONFIG.backendPenalty and re-run — the cache makes it
 * instant.
 */
function score(job: Job, w: { core: number; strong: number; bonus: number }) {
  const c = coverage(job);
  const skillPct = 100 * (w.core * c.core + w.strong * c.strong + w.bonus * c.bonus);
  const hay = `${job.title}\n${(job.tags ?? []).join(" ")}\n${job.description}`.toLowerCase();
  return Math.round(skillPct * titleRelevance(job.title) * backendMass(hay).multiplier);
}

const CUR = { w: CONFIG.scoreWeights };
const NEW = { w: { core: 0.92, strong: 0.06, bonus: 0.02 } };

const rows = jobs.map((j) => {
  const c = coverage(j);
  const hay = `${j.title}\n${(j.tags ?? []).join(" ")}\n${j.description}`.toLowerCase();
  return { j, c, cls: classifyTitle(j.title), be: backendMass(hay).groups.length, cur: score(j, CUR.w), neu: score(j, NEW.w) };
}).sort((a, b) => b.neu - a.neu);

log(`\n  core  strong bonus │ class      be │ CUR → NEW │ title`);
log(`  ──────────────────────────────────────────────────────`);
for (const r of rows.slice(0, 30)) {
  const pc = (n: number) => String(Math.round(n * 100)).padStart(3);
  log(`  ${pc(r.c.core)}  ${pc(r.c.strong)}  ${pc(r.c.bonus)} │ ${r.cls.padEnd(9)} ${String(r.be).padStart(2)} │ ${String(r.cur).padStart(3)} → ${String(r.neu).padStart(3)} │ "${r.j.title}" @ ${r.j.company}`);
}
process.exit(0);

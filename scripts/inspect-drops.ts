/**
 * Debug-only: reproduce the collector's pipeline across all cities but DO NOT
 * persist. Prints every dropped job grouped by gate, with its real score, so we
 * can see whether the "low-fit" (score < minScore) rejects are genuinely weak.
 *
 *   node --env-file=.env --import tsx scripts/inspect-drops.ts
 */
import { CONFIG } from "../config.js";
import { fetchLinkedInCards, type LinkedInLocation } from "../src/pipeline.js";
import { prefilterByTitle } from "../src/prefilter.js";
import { enrichLinkedInJobs } from "../src/sources/linkedin.js";
import { loadKeywords, loadResumeText } from "../src/resume.js";
import { scoreAll, titleRelevance } from "../src/scoring.js";
import { dedupe } from "../src/dedupe.js";
import { scoreResumeVsJds } from "../src/tfidf.js";
import { filterJobs } from "../src/filter.js";
import type { Job } from "../src/types.js";

const log = (...a: unknown[]) => process.stderr.write(a.join(" ") + "\n");
const hours = CONFIG.collect.windowHours;
const pages = CONFIG.collect.pages;

const union = new Map<string, Job>();
for (const loc of CONFIG.locations.linkedin as readonly LinkedInLocation[]) {
  log(`[fetch] ${loc.label}…`);
  const cards = await fetchLinkedInCards(loc, { hours, pages, sortBy: CONFIG.linkedinParams.sortBy });
  for (const j of cards) if (!union.has(j.externalId)) union.set(j.externalId, j);
}
const cards = [...union.values()];
log(`\n[fetch] ${cards.length} unique cards`);

// prefilter
const { kept: prefiltered } = prefilterByTitle(cards);

// enrich the best-title-fit up to the cap (exactly like runPipeline)
const byFit = [...prefiltered].sort((a, b) => titleRelevance(b.title) - titleRelevance(a.title));
const cap = CONFIG.linkedinEnrich.maxEnrich;
const toEnrich = byFit.slice(0, cap);
const enrichedIds = new Set(toEnrich.map((j) => j.externalId));
await enrichLinkedInJobs(toEnrich);

// score
const scored = scoreAll(prefiltered, loadKeywords());
const resumeText = loadResumeText();
if (resumeText) {
  const sims = scoreResumeVsJds(resumeText, scored.map((j) => j.description || j.title));
  scored.forEach((j, i) => { j.tfidfScore = sims[i]; });
}

// dedupe + filter
const deduped = dedupe(scored);
const { kept, dropped } = filterJobs(deduped);

const bucket = (r: string) =>
  /off-target/.test(r) ? "off-target" :
  /backend/.test(r) ? "backend" :
  /yrs|senior title/.test(r) ? "too-senior" :
  /score/.test(r) ? "low-fit" : "other";

const groups: Record<string, typeof dropped> = {};
for (const d of dropped) (groups[bucket(d.reason)] ??= []).push(d);

log(`\n=== KEPT: ${kept.length} | DROPPED: ${dropped.length} (of ${deduped.length} deduped) ===\n`);
for (const g of ["low-fit", "too-senior", "backend", "off-target", "other"]) {
  const list = groups[g];
  if (!list?.length) continue;
  log(`\n── ${g.toUpperCase()} (${list.length}) ──`);
  list.sort((a, b) => b.job.score - a.job.score);
  for (const d of list) {
    const wasEnriched = enrichedIds.has(d.job.externalId);
    const hasJD = (d.job.description?.length ?? 0) > 0;
    const flag = g === "low-fit" ? (!wasEnriched ? "  [NOT-ENRICHED→no JD]" : !hasJD ? "  [enriched but empty JD]" : "") : "";
    log(`  score=${String(d.job.score).padStart(3)}  "${d.job.title}" @ ${d.job.company}${flag}`);
  }
}
process.exit(0);

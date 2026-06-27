import { CONFIG } from "../config.js";
import { loadKeywords } from "./resume.js";
import { scoreAll } from "./scoring.js";
import { writeCsv } from "./csv.js";
import { runSource, type Source } from "./sources/base.js";
import { remotiveSource } from "./sources/remotive.js";
import { remoteokSource } from "./sources/remoteok.js";
import { linkedinSource, enrichLinkedInJobs } from "./sources/linkedin.js";
import { naukriSource } from "./sources/naukri.js";
import { dedupe, dupKey } from "./dedupe.js";
import { filterJobs } from "./filter.js";
import { splitNewVsSeen, record, stats } from "./tracker.js";
import type { Job, SourceResult } from "./types.js";

/** Build the enabled source list (toggles in config.ts). */
function enabledSources(): Source[] {
  const list: Source[] = [];
  if (CONFIG.sources.remotive.enabled) list.push(remotiveSource);
  if (CONFIG.sources.remoteok.enabled) list.push(remoteokSource);
  if (CONFIG.sources.linkedin.enabled) list.push(linkedinSource);
  if (CONFIG.sources.naukri.enabled) list.push(naukriSource); // local-only (residential India IP); nkparam unblock
  return list;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`\n=== job-tools daily run @ ${new Date().toISOString()} ===`);
  if (CONFIG.forbidLogin) console.log("Login to LinkedIn/Naukri is hard-disabled. Logged-out endpoints only.");

  const sources = enabledSources();
  if (sources.length === 0) {
    console.error("No sources enabled in config.ts → nothing to do.");
    process.exit(1);
  }

  // Sequential, single-concurrency = polite.
  const results: SourceResult[] = [];
  for (const s of sources) results.push(await runSource(s));

  const allJobs: Job[] = results.flatMap((r) => r.jobs);
  const failed = results.filter((r) => !r.ok);

  console.log(`\nCollected ${allJobs.length} jobs from ${results.length - failed.length}/${results.length} sources.`);
  if (failed.length) console.warn(`Failed sources: ${failed.map((f) => f.source).join(", ")}`);

  if (allJobs.length === 0) {
    console.warn("No jobs collected. Not writing a CSV.");
    return;
  }

  const keywords = loadKeywords();

  // LinkedIn listing cards are title-only, so their title-only score can't tell
  // us which jobs are worth enriching — a perfect-fit JD behind a generic title
  // ("Software Engineer") would score ~0% and be skipped. So enrich the whole
  // LinkedIn set (bounded by maxEnrich for politeness) BEFORE scoring, then
  // score everything once on the real JD text.
  if (CONFIG.sources.linkedin.enabled && CONFIG.linkedinEnrich.enabled && !dryRun) {
    const liJobs = allJobs
      .filter((j) => j.source === "linkedin")
      .slice(0, CONFIG.linkedinEnrich.maxEnrich);
    if (liJobs.length) {
      console.log(`\nEnriching ${liJobs.length} LinkedIn jobs with full descriptions…`);
      const n = await enrichLinkedInJobs(liJobs); // mutates jobs in place
      console.log(`  enriched ${n}/${liJobs.length}`);
    }
  }

  const scored = scoreAll(allJobs, keywords);

  // Collapse cross-posts (same role reposted across pages/locations/sources).
  const deduped = dedupe(scored);
  console.log(`\nDeduped ${scored.length} → ${deduped.length} unique postings.`);

  // Filter to a genuine shortlist: drop off-target / over-senior / low-fit roles.
  const { kept, dropped } = filterJobs(deduped);
  console.log(`Filtered ${deduped.length} → ${kept.length} on-target (dropped ${dropped.length}).`);
  if (dropped.length) {
    const tally = new Map<string, number>();
    for (const d of dropped) {
      const key = d.reason.replace(/\(.*\)/, "").replace(/\d+/g, "N").trim();
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    const summary = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}: ${n}`);
    console.log(`  drop reasons → ${summary.join("; ")}`);
  }

  // Split into genuinely NEW vs already-seen using the local tracker. We split
  // on the SHORTLIST, but still record the full deduped set below so dropped
  // jobs aren't re-surfaced as "new" on the next run.
  const { fresh, seen } = splitNewVsSeen(kept, dupKey);
  console.log(`New since last run: ${fresh.length}  (already seen: ${seen.length})`);

  // Console preview of the top NEW jobs.
  const preview = fresh.slice(0, 12);
  console.log(`\nTop ${Math.min(fresh.length, CONFIG.output.topN)} NEW by match %:`);
  for (const j of preview) {
    console.log(
      `  ${String(j.score).padStart(3)}%  ${j.title} @ ${j.company} [${j.source}]${j.seniority === "stretch" ? " (stretch)" : ""}`,
    );
  }

  if (dryRun) {
    console.log("\n--dry-run: skipping CSV write and tracker update.");
    return;
  }

  if (fresh.length === 0) {
    console.log("\nNo new jobs this run — not writing a CSV.");
    record(deduped, dupKey, new Date().toISOString()); // still bump last_seen
    const s = stats();
    console.log(`Tracker: ${s.total} jobs known, ${s.applied} marked applied.`);
    return;
  }

  // CSV contains only the NEW jobs (ranked), per the "only show new" requirement.
  const file = writeCsv(fresh, timestamp());
  record(deduped, dupKey, new Date().toISOString());
  const s = stats();
  console.log(`Tracker: ${s.total} jobs known, ${s.applied} marked applied.`);
  console.log(`\n✓ Wrote ${fresh.length} NEW ranked jobs → ${file}`);
  if (CONFIG.attribution) {
    console.log("Attribution: job data via RemoteOK (remoteok.com) and Remotive (remotive.com).");
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});

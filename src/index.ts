import { CONFIG } from "../config.js";
import { loadKeywords, loadResumeText } from "./resume.js";
import { prefilterByTitle } from "./prefilter.js";
import { scoreResumeVsJds } from "./tfidf.js";
import { scoreAll } from "./scoring.js";
import { writeCsv } from "./csv.js";
import { runSource, type Source } from "./sources/base.js";
import { remotiveSource } from "./sources/remotive.js";
import { remoteokSource } from "./sources/remoteok.js";
import { linkedinSource, enrichLinkedInJobs } from "./sources/linkedin.js";
import { naukriSource } from "./sources/naukri.js";
import { dedupe, dupKey } from "./dedupe.js";
import { filterJobs } from "./filter.js";
import { enrichWithSalary, formatBand } from "./salary.js";
import { enrichWithPresence, formatPresence } from "./presence.js";
import { splitNewVsSeen, record, stats } from "./tracker.js";
import type { Job, SourceResult } from "./types.js";

/** Build the enabled source list (toggles in config.ts). */
function enabledSources(): Source[] {
  const list: Source[] = [];
  if (CONFIG.sources.remotive.enabled) list.push(remotiveSource);
  if (CONFIG.sources.remoteok.enabled) list.push(remoteokSource);
  if (CONFIG.sources.linkedin.enabled) list.push(linkedinSource);
  if (CONFIG.sources.naukri.enabled) list.push(naukriSource); // local-only (residential India IP); nkparam unblock
  // NOTE: the ATS board sources are deliberately NOT here. They run on their own
  // 15-minute scheduler inside the dashboard (src/ats-collect.ts) because their
  // cadence, cost model and staleness rules are all different from the scraped
  // sources — see CONFIG.ats.poll. `npm run ats` runs them standalone.
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

  // Two-stage LinkedIn pipeline:
  //   Stage 1 — keyword title pre-filter → drop obvious non-target roles cheaply.
  //   Stage 2 — enrich survivors (fetch full JD) → keyword-score on real text.
  let jobPool = allJobs;

  if (CONFIG.sources.linkedin.enabled) {
    const liJobs = jobPool.filter((j) => j.source === "linkedin");
    if (liJobs.length > 0) {
      const { kept, dropped } = prefilterByTitle(liJobs);
      const keepIds = new Set(kept.map((j) => j.externalId));
      jobPool = jobPool.filter((j) => j.source !== "linkedin" || keepIds.has(j.externalId));
      console.log(`\n[Stage 1] Title pre-filter: ${liJobs.length} → ${kept.length} kept, ${dropped.length} dropped`);
      if (dropped.length) {
        const sample = dropped.slice(0, 6).map((d) => `  • ${d.job.title} (${d.reason})`).join("\n");
        console.log(sample);
        if (dropped.length > 6) console.log(`  … and ${dropped.length - 6} more`);
      }
    }
  }

  if (CONFIG.sources.linkedin.enabled && CONFIG.linkedinEnrich.enabled && !dryRun) {
    const liJobs = jobPool
      .filter((j) => j.source === "linkedin")
      .slice(0, CONFIG.linkedinEnrich.maxEnrich);
    if (liJobs.length) {
      console.log(`\n[Stage 2] Enriching ${liJobs.length} LinkedIn survivors with full JDs…`);
      const n = await enrichLinkedInJobs(liJobs);
      console.log(`  enriched ${n}/${liJobs.length}`);
    }
  }

  const scored = scoreAll(jobPool, keywords);

  // TF-IDF similarity: resume vs each job's full description (post-enrichment).
  // Uses the whole batch as the IDF corpus so generic posting language is
  // down-weighted and distinctive tech terms are up-weighted automatically.
  const resumeText = loadResumeText();
  if (resumeText) {
    const jdTexts = scored.map((j) => j.description || j.title);
    const sims    = scoreResumeVsJds(resumeText, jdTexts);
    scored.forEach((j, i) => { j.tfidfScore = sims[i]; });
    console.log("\n[TF-IDF] similarity scores attached to all jobs.");
  }

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

  // Salary bands from AmbitionBox. Deliberately AFTER filtering: the shortlist
  // is a fraction of the pool, and this costs one request per unique company.
  let noAmbitionBox: string[] = [];
  if (CONFIG.salary.enabled && !dryRun && kept.length) {
    const uniq = new Set(kept.map((j) => j.company.trim()).filter(Boolean)).size;
    console.log(`\n[Salary] Looking up AmbitionBox bands for ${uniq} unique companies…`);
    const { matched, companies, unresolved } = await enrichWithSalary(kept);
    console.log(`  attached bands to ${matched}/${kept.length} jobs across ${companies} companies`);
    if (unresolved.length) {
      console.log(`  no AmbitionBox page for: ${unresolved.slice(0, 8).join(", ")}${unresolved.length > 8 ? ` … +${unresolved.length - 8}` : ""}`);
      console.log(`  → add slugs to CONFIG.salary.aliases if any of these matter.`);
    }
    noAmbitionBox = unresolved;
  }

  // Presence fallback — ONLY for the companies AmbitionBox had no page for.
  // Where AmbitionBox does have a page, its founded-year / headcount / isClosed
  // fields already answer "is this real?" better, and cost no extra request.
  // These are mostly small or new startups, which says nothing about whether
  // they're genuine — so we look at operating footprint instead of age.
  if (CONFIG.presence.enabled && !dryRun && noAmbitionBox.length) {
    console.log(`\n[Presence] No AmbitionBox page for ${noAmbitionBox.length} companies — checking online footprint…`);
    const t = await enrichWithPresence(kept, noAmbitionBox);
    console.log(`  probed ${t.probed}: ${t.operating} operating, ${t.thin} thin, ${t.unverified} unverified`);
    // Print the ones that didn't clear `operating` — those are the only ones
    // worth your eyes. One line per company, not per job.
    const shown = new Set<string>();
    for (const j of kept) {
      if (!j.presence || j.presence.verdict === "operating") continue;
      if (shown.has(j.company)) continue;
      shown.add(j.company);
      console.log(`  • ${j.company} → ${formatPresence(j.presence)}`);
    }
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
    const band = formatBand(j.salaryBand);
    console.log(
      `  ${String(j.score).padStart(3)}%  ${j.title} @ ${j.company} [${j.source}]${j.seniority === "stretch" ? " (stretch)" : ""}${band ? `  — ${band}` : ""}`,
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

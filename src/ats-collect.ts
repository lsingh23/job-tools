import { CONFIG } from "../config.js";
import { loadKeywords, loadResumeText } from "./resume.js";
import { scoreAll } from "./scoring.js";
import { scoreResumeVsJds } from "./tfidf.js";
import { dedupe } from "./dedupe.js";
import { filterJobs } from "./filter.js";
import { enrichWithSalary } from "./salary.js";
import { pollCompanies, isExcluded } from "./sources/ats.js";
import { loadRegistry, saveRegistry, type Company } from "./discover.js";
import { startRun, finishRun, upsertJobs, today, initSchema } from "./db.js";

/**
 * The ATS collector — company career boards, on their own schedule.
 *
 * Deliberately NOT part of runCollection()/`npm run daily`. The two pipelines
 * differ in every way that matters:
 *
 *   LinkedIn/Naukri            Company ATS boards
 *   ──────────────────────     ─────────────────────────────────────────────
 *   scraped, bot-detected      first-party JSON APIs, built to be called
 *   2.5-5s politeness delay    6-wide concurrency, no delay
 *   JD costs an extra fetch    JD ships inline (so no enrich budget at all)
 *   freshness window is vital  freshness window DELETES open jobs (64 → 2)
 *   ~500 cards/run             46,773 postings across 930 boards
 *
 * Sharing a scheduler would force the wrong tradeoff on one of them, so this
 * runs on an independent timer with an independent in-flight lock.
 */

export interface AtsCollectResult {
  runId: number;
  runDate: string;
  /** Boards contacted this tick (the rotating slice, not the whole registry). */
  boards: number;
  registrySize: number;
  rawPostings: number;
  matched: number;
  final: number;
  inserted: number;
  updated: number;
  failed: number;
}

export interface AtsCollectOpts {
  /** Ignore the refresh clock and poll every board. Used by the manual button. */
  all?: boolean;
  log?: (...a: unknown[]) => void;
}

/**
 * Choose this tick's slice: boards whose `lastPolledAt` is older than
 * `refreshMinutes`, oldest first, capped at `maxBoardsPerTick`. Never-polled
 * boards sort first (undefined → epoch), so a company discovered five minutes
 * ago is checked on the very next tick rather than waiting out the rotation.
 *
 * Boards that keep failing are backed off exponentially (2^failures hours, cap
 * 24h) so 404-forever slugs from a bad harvest stop consuming the tick budget —
 * without ever being deleted, since a company can re-open a board.
 */
export function dueCompanies(reg: { companies: Company[] }, now = Date.now()): Company[] {
  const refreshMs = CONFIG.ats.poll.refreshMinutes * 60_000;
  return reg.companies
    .filter((c) => !isExcluded(c))
    .filter((c) => {
      if (!c.lastPolledAt) return true;
      const backoffMs = c.failures ? Math.min(2 ** c.failures, 24) * 3_600_000 : 0;
      return now - new Date(c.lastPolledAt).getTime() >= Math.max(refreshMs, backoffMs);
    })
    .sort((a, b) => (a.lastPolledAt ?? "").localeCompare(b.lastPolledAt ?? ""))
    .slice(0, CONFIG.ats.poll.maxBoardsPerTick);
}

export async function runAtsCollection(opts: AtsCollectOpts = {}): Promise<AtsCollectResult> {
  const log = opts.log ?? ((...a: unknown[]) => process.stderr.write(a.join(" ") + "\n"));
  const runDate = today();
  const reg = loadRegistry();

  const slice = opts.all ? reg.companies.filter((c) => !isExcluded(c)) : dueCompanies(reg);
  log(
    `[ats] polling ${slice.length} of ${reg.companies.length} boards ` +
      `(${opts.all ? "all — manual" : `due for refresh, every ${CONFIG.ats.poll.refreshMinutes}m`})`,
  );

  await initSchema();
  const runId = await startRun({
    runDate,
    trigger: opts.all ? "manual" : "auto",
    windowHours: 0, // no time window — presence on the board IS the freshness proof
    source: "ats",
  });

  try {
    const { jobs, polled, failed, rawPostings } = await pollCompanies(slice);
    log(`[ats] ${rawPostings} postings → ${jobs.length} matched title/location`);

    // Stamp the rotation clock. Done even for failures, so a dead board doesn't
    // get retried on every single tick forever.
    const now = new Date().toISOString();
    const failedKeys = new Set(failed.map((c) => `${c.ats}:${c.slug}:${c.site ?? ""}`));
    for (const c of polled) {
      const target = reg.companies.find(
        (x) => x.ats === c.ats && x.slug === c.slug && x.site === c.site,
      );
      if (!target) continue;
      target.lastPolledAt = now;
      target.failures = failedKeys.has(`${c.ats}:${c.slug}:${c.site ?? ""}`)
        ? (target.failures ?? 0) + 1
        : 0;
    }
    saveRegistry(reg);

    // Score. No enrich stage — every one of these APIs already gave us the JD.
    const keywords = loadKeywords();
    const scored = scoreAll(jobs, keywords);

    const resumeText = loadResumeText();
    if (resumeText && scored.length) {
      const sims = scoreResumeVsJds(resumeText, scored.map((j) => j.description || j.title));
      scored.forEach((j, i) => { j.tfidfScore = sims[i]; });
    }

    const deduped = dedupe(scored);
    const { kept } = filterJobs(deduped);
    log(`[ats] ${scored.length} scored → ${deduped.length} deduped → ${kept.length} shortlisted`);

    // Salary bands cost one request per unique company, so only after filtering.
    if (CONFIG.salary.enabled && kept.length) {
      const { matched, companies } = await enrichWithSalary(kept);
      log(`[ats] salary bands: ${matched}/${kept.length} jobs across ${companies} companies`);
    }

    const { inserted, updated } = await upsertJobs(kept, { runDate, citiesByExternalId: new Map() });
    log(`[ats] upsert → ${inserted} new, ${updated} refreshed`);

    await finishRun(runId, {
      status: "ok",
      fetched: rawPostings,
      prefiltered: jobs.length,
      enriched: 0, // inline JDs — nothing to enrich
      final: kept.length,
      newJobs: inserted,
    });

    return {
      runId, runDate,
      boards: slice.length,
      registrySize: reg.companies.length,
      rawPostings,
      matched: jobs.length,
      final: kept.length,
      inserted, updated,
      failed: failed.length,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[ats] FAILED: ${msg}`);
    await finishRun(runId, { status: "error", error: msg }).catch(() => {});
    throw err;
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function isMain(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("ats-collect.ts") || entry.endsWith("ats-collect.js");
}

if (isMain()) {
  runAtsCollection({ all: process.argv.includes("--all"), log: (...a) => console.log(...a) })
    .then((r) => {
      console.log(`\n${r.final} shortlisted — ${r.inserted} new, ${r.updated} refreshed`);
      process.exit(0);
    })
    .catch((err) => { console.error(err); process.exit(1); });
}

/**
 * Multi-city LinkedIn collector.
 *
 *   npm run collect                       # all cities, config defaults
 *   npm run collect -- --hours 6 --pages 3 --trigger manual
 *
 * Runs the LinkedIn guest search across every CONFIG.locations.linkedin entry
 * (Bengaluru, Hyderabad, Pune, Mumbai, Delhi, Chennai, Remote-India), then:
 *
 *   1. Fetches guest cards for each city (cheap) and records, per posting, which
 *      cities surfaced it.
 *   2. Dedupes the union by externalId and runs the EXPENSIVE pipeline (enrich +
 *      score + salary + presence) exactly ONCE — a job cross-listed in 3 cities is
 *      enriched once, not three times.
 *   3. Upserts the shortlist into Neon (DATABASE_URL). Repeat sightings across the
 *      day refresh/union rather than duplicate, so the day's set accumulates.
 *
 * Exported as runCollection() so the dashboard's in-process scheduler calls it
 * directly (no child process), and also runnable as a standalone CLI.
 */

import { CONFIG } from "../config.js";
import { fetchLinkedInCards, runPipeline, type LinkedInLocation, type PipelineMemory } from "./pipeline.js";
import { startRun, finishRun, upsertJobs, today, initSchema, getSeenCards, recordSeenCards } from "./db.js";
import type { Job } from "./types.js";

export interface CollectOpts {
  hours?: number;
  pages?: number;
  trigger?: "auto" | "manual";
  log?: (...a: unknown[]) => void;
}

export interface CollectResult {
  runId: number;
  runDate: string;
  fetched: number;
  final: number;
  inserted: number;
  updated: number;
  perCity: { city: string; cards: number }[];
}

/**
 * Run one full collection across all configured LinkedIn locations and persist it.
 * Logs progress via opts.log (defaults to stderr) so the dashboard can stream it.
 */
export async function runCollection(opts: CollectOpts = {}): Promise<CollectResult> {
  const log = opts.log ?? ((...a: unknown[]) => process.stderr.write(a.join(" ") + "\n"));
  const hours = opts.hours ?? CONFIG.collect.windowHours;
  const pages = opts.pages ?? CONFIG.collect.pages;
  const trigger = opts.trigger ?? "manual";
  const runDate = today();

  const locations = CONFIG.locations.linkedin as readonly LinkedInLocation[];
  log(`[collect] ${trigger} run — ${locations.length} locations, window=${hours}h, pages=${pages}`);

  // Idempotent — also creates seen_cards on first run of a CLI-only deployment
  // (the dashboard calls this too, but the collector must not depend on it).
  await initSchema();
  const runId = await startRun({ runDate, trigger, windowHours: hours });

  // The collector's "already read this card" memory (see CONFIG.collect.skipSeenHours).
  const memory: PipelineMemory = { lookup: getSeenCards, record: recordSeenCards };

  try {
    // 1. Fetch cards per city; union by externalId, tracking which cities saw each.
    const union = new Map<string, Job>();
    const citiesByExternalId = new Map<string, string[]>();
    const perCity: { city: string; cards: number }[] = [];

    for (const loc of locations) {
      log(`[collect] fetching "${loc.label}"…`);
      const cards = await fetchLinkedInCards(loc, { hours, pages, sortBy: CONFIG.linkedinParams.sortBy, log });
      perCity.push({ city: loc.label, cards: cards.length });
      for (const j of cards) {
        if (!union.has(j.externalId)) union.set(j.externalId, j);
        const set = citiesByExternalId.get(j.externalId) ?? [];
        if (!set.includes(loc.label)) set.push(loc.label);
        citiesByExternalId.set(j.externalId, set);
      }
      log(`[collect] "${loc.label}": ${cards.length} cards (union now ${union.size})`);
    }

    const cards = [...union.values()];
    log(`[collect] ${cards.length} unique cards across ${locations.length} cities`);

    // 2. One pipeline pass over the whole union.
    const { jobs, stats } = await runPipeline(cards, { log, memory });
    log(
      `[collect] pipeline → ${jobs.length} shortlisted ` +
      `(${stats.skippedSeen} skipped as already-rejected, ${stats.reusedJd} JDs reused, ${stats.enriched} freshly enriched)`,
    );

    // 3. Persist. Cities come from the raw cards (pre-dedupe), keyed by externalId.
    const { inserted, updated } = await upsertJobs(jobs, { runDate, citiesByExternalId });
    log(`[collect] upsert → ${inserted} new, ${updated} refreshed`);

    await finishRun(runId, {
      status: "ok",
      fetched: stats.fetched,
      prefiltered: stats.prefiltered,
      enriched: stats.enriched,
      final: stats.final,
      newJobs: inserted,
    });

    return { runId, runDate, fetched: stats.fetched, final: stats.final, inserted, updated, perCity };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[collect] FAILED: ${msg}`);
    await finishRun(runId, { status: "error", error: msg }).catch(() => {});
    throw err;
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function isMain(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("collect.ts") || entry.endsWith("collect.js");
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const hours = getArg("hours") ? Math.max(1, parseInt(getArg("hours")!, 10)) : undefined;
  const pages = getArg("pages") ? Math.max(1, Math.min(10, parseInt(getArg("pages")!, 10))) : undefined;
  const trigger = getArg("trigger") === "auto" ? "auto" : "manual";

  const { closePool } = await import("./db.js");
  runCollection({ hours, pages, trigger })
    .then((r) => {
      process.stderr.write(
        `[collect] done → ${r.final} shortlisted, ${r.inserted} new / ${r.updated} refreshed (run #${r.runId})\n`,
      );
    })
    .catch((err) => {
      process.stderr.write(`[collect] FATAL: ${err instanceof Error ? err.stack : err}\n`);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}

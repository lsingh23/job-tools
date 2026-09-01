/**
 * THE NAUKRI HOT CHECKER — a fast, narrow-window Naukri poll that runs between
 * the wide daily collection (src/collect.ts / src/sources/naukri.ts).
 *
 *   npm run naukri-hot        # one tick, standalone
 *
 * Same idea as src/hot.ts (LinkedIn), simpler in practice: Naukri cards carry
 * a real `createdDate` timestamp and the full JD inline, so there's no enrich
 * step and no "is this actually fresh" uncertainty — `sort=f` + a narrow
 * client-side time window (src/naukri-cards.ts) directly IS the freshest
 * slice of the market, not a proxy for it.
 *
 * SHARING NAUKRI WITH THE WIDE COLLECTOR: both loops go through the same
 * per-host gate (CONFIG.http.gates["www.naukri.com"]), so Naukri sees one
 * request every 2.5-5s no matter how many loops are running. This tick uses
 * gate priority 0 so its handful of requests jump the collector's queue.
 */

import { CONFIG } from "../config.js";
import { runPipeline } from "./pipeline.js";
import { fetchNaukriCards } from "./naukri-cards.js";
import { getSeenCards, recordSeenCards, upsertJobs, today, initSchema } from "./db.js";
import { surfaceHotJob } from "./surface.js";
import type { ScoredJob } from "./types.js";

export interface NaukriHotTick {
  at: string;
  ms: number;
  /** Cards the query returned (pre-dedupe against seen_cards). */
  cards: number;
  /** Jobs at or above CONFIG.notify.hotScore. */
  hot: number;
  /** Jobs that were genuinely new rows (and therefore alerted). */
  alerted: number;
  inserted: number;
  updated: number;
  error?: string;
}

/**
 * In-memory ring of recent ticks, for the dashboard. Deliberately NOT written
 * to the `runs` table — same reasoning as src/hot.ts: at a 5-min cadence
 * that's ~290 rows/day of mostly "found nothing".
 */
const history: NaukriHotTick[] = [];

export function naukriHotHistory(): NaukriHotTick[] {
  return [...history].reverse();
}

function remember(tick: NaukriHotTick): NaukriHotTick {
  history.push(tick);
  while (history.length > CONFIG.naukriHot.historySize) history.shift();
  return tick;
}

/** Run a single hot tick. Never throws — a failed tick is recorded and skipped. */
export async function runNaukriHotCheck(opts: { log?: (...a: unknown[]) => void } = {}): Promise<NaukriHotTick> {
  const log = opts.log ?? ((...a: unknown[]) => process.stderr.write(a.join(" ") + "\n"));
  const nh = CONFIG.naukriHot;
  const started = Date.now();
  const at = new Date().toISOString();
  const runDate = today();

  try {
    await initSchema();
    const memory = { lookup: getSeenCards, record: recordSeenCards };
    const terms = nh.terms ?? [...CONFIG.linkedinSearchTerms];

    const cardLists = await Promise.all(
      nh.locations.map((loc) =>
        fetchNaukriCards(loc, {
          hours: nh.windowMinutes / 60,
          pages: nh.pages,
          terms,
          priority: 0, // jump the wide collector's queue
          log: (...a) => log("  ", ...a),
        }),
      ),
    );
    const seen = new Set<string>();
    const cards = cardLists.flat().filter((j) => (seen.has(j.externalId) ? false : (seen.add(j.externalId), true)));

    let alerted = 0;
    const onScored = async (job: ScoredJob) => {
      try {
        const r = await surfaceHotJob(job, { runDate, cities: nh.locations, log: (...a) => log("[naukri-hot]", ...a) });
        if (r.alerted) alerted++;
      } catch (e) {
        log(`[naukri-hot] surface failed for ${job.externalId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    const { jobs } = await runPipeline(cards, {
      log: (...a) => log("  ", ...a),
      memory,
      onScored,
      enrich: false, // Naukri cards already carry the full JD — nothing to enrich
      salary: false,   // one request per company, against a third host — a
      presence: false, // latency probe shouldn't pay for it; the wide collector does
    });

    const citiesByExternalId = new Map(jobs.map((j) => [j.externalId, nh.locations]));
    const { inserted, updated } = await upsertJobs(jobs, { runDate, citiesByExternalId });

    const hot = jobs.filter((j) => j.score >= CONFIG.notify.hotScore).length;
    const tick: NaukriHotTick = {
      at, ms: Date.now() - started, cards: cards.length, hot, alerted, inserted, updated,
    };
    log(
      `[naukri-hot] ${cards.length} cards, ${hot} >=${CONFIG.notify.hotScore}%, ` +
        `${alerted} alerted, ${inserted} new / ${updated} refreshed (${(tick.ms / 1000).toFixed(1)}s)`,
    );
    return remember(tick);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[naukri-hot] FAILED: ${msg}`);
    return remember({ at, ms: Date.now() - started, cards: 0, hot: 0, alerted: 0, inserted: 0, updated: 0, error: msg });
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function isMain(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("naukri-hot.ts") || entry.endsWith("naukri-hot.js");
}

if (isMain()) {
  const { closePool } = await import("./db.js");
  await runNaukriHotCheck();
  await closePool();
}

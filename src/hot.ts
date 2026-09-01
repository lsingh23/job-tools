/**
 * THE HOT CHECKER — a one-minute LinkedIn poll that runs between the wide sweeps.
 *
 *   npm run hot            # one tick, standalone
 *
 * The wide collector (src/collect.ts) takes ~16-19 min for ~170 listing requests
 * across 8 terms × 10 cities. That is the right shape for COVERAGE and the wrong
 * shape for LATENCY: a job posted at 14:05 is not seen until the 14:30 run
 * finishes around 14:46. This tick fixes the latency without touching coverage —
 * ONE query (the tuned pure-title boolean net), the national geo, one page, a
 * 30-minute window: ~8 requests, under a minute.
 *
 * It is cheap on the second tick onward because of `seen_cards`: a card the last
 * tick already read and judged is skipped without an HTTP call, so a typical tick
 * enriches ZERO jobs and costs only its 8 listing requests.
 *
 * SHARING LINKEDIN WITH THE SWEEP: both loops go through the same per-host gate
 * (CONFIG.http.gates), so LinkedIn still sees one request every 2.5-5s no matter
 * how many loops are running — this adds no traffic, it reallocates it. The tick
 * uses gate priority 0 so its handful of requests jump the sweep's queue; the
 * sweep pays about 30 seconds per tick for that.
 *
 * Salary and presence enrichment are OFF here on purpose: they cost one request
 * per company against a third host and add nothing to the decision "is this
 * worth looking at right now". The wide sweep fills them in later.
 */

import { CONFIG } from "../config.js";
import { fetchLinkedInCards, runPipeline, type LinkedInLocation, type PipelineMemory } from "./pipeline.js";
import { getSeenCards, recordSeenCards, upsertJobs, today, initSchema } from "./db.js";
import { surfaceHotJob } from "./surface.js";
import type { ScoredJob } from "./types.js";

export interface HotTick {
  at: string;
  ms: number;
  /** Cards the query returned (pre-dedupe against seen_cards). */
  cards: number;
  /** JDs actually fetched this tick — usually 0 once the day is warm. */
  enriched: number;
  /** Jobs at or above CONFIG.notify.hotScore. */
  hot: number;
  /** Jobs that were genuinely new rows (and therefore alerted). */
  alerted: number;
  inserted: number;
  updated: number;
  error?: string;
}

/**
 * In-memory ring of recent ticks, for the dashboard.
 *
 * Deliberately NOT written to the `runs` table: at a 5-minute cadence that
 * would be ~170 rows/day of mostly "found nothing", drowning the ~24 real sweeps
 * in the run history — and costing a Neon round-trip (~300ms) per tick to say
 * nothing happened.
 */
const history: HotTick[] = [];

export function hotHistory(): HotTick[] {
  return [...history].reverse();
}

function remember(tick: HotTick): HotTick {
  history.push(tick);
  while (history.length > CONFIG.hot.historySize) history.shift();
  return tick;
}

/** Run a single hot tick. Never throws — a failed tick is recorded and skipped. */
export async function runHotCheck(opts: { log?: (...a: unknown[]) => void } = {}): Promise<HotTick> {
  const log = opts.log ?? ((...a: unknown[]) => process.stderr.write(a.join(" ") + "\n"));
  const h = CONFIG.hot;
  const started = Date.now();
  const at = new Date().toISOString();
  const runDate = today();

  try {
    await initSchema();
    const memory: PipelineMemory = { lookup: getSeenCards, record: recordSeenCards };
    const loc: LinkedInLocation = { label: h.location.label, geoId: h.location.geoId, pages: h.pages };
    const terms = h.terms ?? [...CONFIG.linkedinPriorityTerms];

    // f_TPR takes seconds, and fetchLinkedInCards multiplies by 3600 — so a
    // 30-minute window is 0.5 "hours". Fractions are fine; the API takes any
    // seconds value (measured: r1800/r3600/r7200 all work).
    const cards = await fetchLinkedInCards(loc, {
      hours: h.windowMinutes / 60,
      pages: h.pages,
      terms,
      priority: 0, // jump the sweep's queue
      log: (...a) => log("  ", ...a),
    });

    let alerted = 0;
    const onScored = async (job: ScoredJob) => {
      try {
        const r = await surfaceHotJob(job, { runDate, cities: [loc.label], log: (...a) => log("[hot]", ...a) });
        if (r.alerted) alerted++;
      } catch (e) {
        log(`[hot] surface failed for ${job.externalId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    const { jobs, stats } = await runPipeline(cards, {
      log: (...a) => log("  ", ...a),
      memory,
      onScored,
      priority: 0,
      maxEnrich: h.maxEnrichPerTick,
      salary: false,   // one request per company, against a third host — the
      presence: false, // wide sweep pays for these, a latency probe should not
    });

    // Persist the whole (small) tick, not just the hot ones, so a 60% job still
    // lands on the dashboard — it simply doesn't get a banner.
    const citiesByExternalId = new Map(jobs.map((j) => [j.externalId, [loc.label]]));
    const { inserted, updated } = await upsertJobs(jobs, { runDate, citiesByExternalId });

    const hot = jobs.filter((j) => j.score >= CONFIG.notify.hotScore).length;
    const tick: HotTick = {
      at, ms: Date.now() - started, cards: cards.length,
      enriched: stats.enriched, hot, alerted, inserted, updated,
    };
    log(
      `[hot] ${cards.length} cards, ${stats.enriched} enriched, ${hot} >=${CONFIG.notify.hotScore}%, ` +
        `${alerted} alerted, ${inserted} new / ${updated} refreshed (${(tick.ms / 1000).toFixed(1)}s)`,
    );
    return remember(tick);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[hot] FAILED: ${msg}`);
    return remember({
      at, ms: Date.now() - started, cards: 0, enriched: 0, hot: 0,
      alerted: 0, inserted: 0, updated: 0, error: msg,
    });
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function isMain(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("hot.ts") || entry.endsWith("hot.js");
}

if (isMain()) {
  const { closePool } = await import("./db.js");
  await runHotCheck();
  await closePool();
}

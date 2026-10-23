/**
 * Surface ONE strong job immediately: persist it, then alert — without waiting
 * for the run that found it to finish.
 *
 * Shared by both LinkedIn loops (the wide sweep in collect.ts and the hot
 * checker in hot.ts) so the "have I already shouted about this?" rule lives in
 * exactly one place.
 *
 * THE RULE: alert only when the upsert actually INSERTED a row. A good job is
 * re-seen by every run inside its search window — for hours — so "score >= 70"
 * alone would re-fire the same banner all afternoon. `insertedIds` is the only
 * signal that means "nobody has ever been shown this job", and it works ACROSS
 * loops and restarts for free, because it is a property of the database rather
 * than of any process's memory.
 *
 * Persisting before alerting is deliberate: the dashboard polls every 60s, so
 * by the time you react to the banner the row is already on the page.
 */

import { upsertJobs } from "./db.js";
import { notifyHotJob, notifyDirectApplyJob } from "./notify.js";
import { shouldAlertDirect, summarizeDirectApply } from "./direct-apply.js";
import { CONFIG } from "../config.js";
import type { ScoredJob } from "./types.js";

export interface SurfaceResult {
  /** True when this call created the row (and therefore fired the alert). */
  isNew: boolean;
  alerted: boolean;
  /** The banner fired because the JD names a human to contact, not on score. */
  direct?: boolean;
}

export async function surfaceHotJob(
  job: ScoredJob,
  opts: { runDate: string; cities?: string[]; log?: (...a: unknown[]) => void },
): Promise<SurfaceResult> {
  const log = opts.log ?? (() => {});
  const citiesByExternalId = opts.cities?.length
    ? new Map([[job.externalId, opts.cities]])
    : undefined;

  const { insertedIds } = await upsertJobs([job], { runDate: opts.runDate, citiesByExternalId });
  const isNew = insertedIds.includes(job.externalId);
  if (!isNew) return { isNew: false, alerted: false };

  // Two independent reasons to shout, and a job can qualify on either. The
  // direct-apply banner wins the sound when both fire — "here is an inbox to
  // write to" is more actionable than "this scored well", and a single job
  // must never produce two banners.
  const direct = shouldAlertDirect(job);
  if (direct) {
    await notifyDirectApplyJob(job);
    log(`📩 ${job.score}% "${job.title}" @ ${job.company} — ${summarizeDirectApply(job.directApply!)} — ${job.url}`);
    return { isNew: true, alerted: true, direct: true };
  }

  await notifyHotJob(job);
  log(`🔔 ${job.score}% "${job.title}" @ ${job.company} — ${job.url}`);
  return { isNew: true, alerted: job.score >= CONFIG.notify.hotScore };
}

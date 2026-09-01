/**
 * Desktop alerts for the in-process scheduler (macOS).
 *
 * Zero dependencies, on purpose: the banner is `osascript -e 'display
 * notification'` and the sound is a separate `afplay` of a stock system sound.
 * They are deliberately two calls — `display notification … sound name "Glass"`
 * is silent whenever Notification Centre has the app's sound switched off (and
 * for a plain `node` process the "app" is Script Editor, whose sound most
 * people never enabled), so relying on it alone gives you a mute alert. afplay
 * goes straight to the audio device and always makes noise.
 *
 * Every failure is swallowed: an alert must never take down a collect run.
 */

import { execFile } from "node:child_process";
import { platform } from "node:os";
import { CONFIG } from "../config.js";

/** AppleScript string literal: escape backslashes and double quotes. */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res) => {
    try {
      execFile(cmd, args, { timeout: 10_000 }, () => res());
    } catch {
      res();
    }
  });
}

export interface NotifyOpts {
  title: string;
  /** Second line, smaller. Optional. */
  subtitle?: string;
  body: string;
  /** Stock sound from /System/Library/Sounds (no extension). "" = silent. */
  sound?: string;
}

/**
 * Fire a desktop banner + sound. No-op off macOS or when CONFIG.notify.enabled
 * is false. Never throws, never rejects.
 */
export async function notify(opts: NotifyOpts): Promise<void> {
  if (!CONFIG.notify.enabled || platform() !== "darwin") return;

  const script =
    `display notification "${esc(opts.body)}" with title "${esc(opts.title)}"` +
    (opts.subtitle ? ` subtitle "${esc(opts.subtitle)}"` : "");

  const sound = opts.sound ?? CONFIG.notify.sound;
  await Promise.all([
    run("osascript", ["-e", script]),
    sound ? run("afplay", [`/System/Library/Sounds/${sound}.aiff`]) : Promise.resolve(),
  ]);
}

/**
 * Alert for a finished auto-collect.
 *
 * Gated on `minNewJobs` because the scheduler fires 24×/day inside the active
 * window and most of those runs surface nothing new — banners on all of them
 * would train you to ignore the one that matters. `inserted` (genuinely new
 * rows), not `final` (which includes every job carried over from earlier runs
 * today), is what decides whether there's news.
 */
export async function notifyCollectDone(r: {
  final: number;
  inserted: number;
  updated: number;
}): Promise<void> {
  if (r.inserted < CONFIG.notify.minNewJobs) return;
  await notify({
    title: r.inserted === 1 ? "1 new job" : `${r.inserted} new jobs`,
    subtitle: "job-tools · auto-collect",
    body: `${r.final} shortlisted today · ${r.inserted} new / ${r.updated} refreshed`,
  });
}

/**
 * Alert for ONE strong job, the moment it is scored — not at end of run.
 *
 * Fires per job rather than per run, so it is gated hard on two things:
 *   - `CONFIG.notify.hotScore` (default 70), and
 *   - the caller having established the job is genuinely NEW (a fresh DB insert,
 *     see upsertJobs.insertedIds). Without that second gate the same 78% job
 *     re-alerts every few minutes for the whole 2h search window.
 *
 * The score passed here can be PROVISIONAL when it comes from the streaming
 * path (see runPipeline's `onScored`): a job scored alone cannot receive the
 * batch-relative bulk-posting penalty, so a consultancy flooding one run may
 * alert a little high. The end-of-run pass rewrites the stored score with the
 * batch-aware one; only the banner is ever optimistic.
 */
export async function notifyHotJob(job: {
  title: string;
  company?: string;
  score: number;
  location?: string;
}): Promise<void> {
  if (!CONFIG.notify.enabled) return;
  if (job.score < CONFIG.notify.hotScore) return;
  await notify({
    title: `${job.score}% — ${job.title}`.slice(0, 120),
    subtitle: job.company || undefined,
    body: [job.location, "job-tools"].filter(Boolean).join(" · "),
    sound: CONFIG.notify.hotSound,
  });
}

/** Alert for a failed auto-collect — always fires (a dead collector is news). */
export async function notifyCollectFailed(message: string): Promise<void> {
  if (!CONFIG.notify.onError) return;
  await notify({
    title: "Auto-collect failed",
    subtitle: "job-tools",
    body: message.slice(0, 200),
    sound: CONFIG.notify.errorSound,
  });
}

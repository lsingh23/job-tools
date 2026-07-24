// Feedback loop — blueprint Part 8, step 8. Every tailoring run is logged as one application
// record; when you later hear back you record the callback outcome. The payoff is the
// missing-keyword frequency table: after ~100 applications it ranks the skills the JDs keep
// asking for that your résumé honestly can't back — i.e. what to actually go learn next, sorted
// by how often it cost you (and how often it co-occurs with NO callback).
//
// Storage is a single JSON array (applications.json). Volume is low (hundreds), and a callback is
// recorded by read-modify-write on an existing record, which a plain array makes trivial.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = process.env.APPLICATIONS_FILE ?? path.join(HERE, "applications.json");

// Missing-keyword reasons split into two meanings. A "gap" reason means the résumé honestly
// couldn't back the keyword → a real learn candidate. A "no-room" reason means it WAS defensible
// but got dropped for one-page fit / cap — you already have it, so it's not something to learn.
const GAP_REASONS = new Set([
  "no-evidence", "evidence-not-verbatim", "verifier-rejected", "verifier-rejected(cached)",
  "t1-evidence-too-broad", "t1-compound-keyword",
]);
const NO_ROOM_REASONS = new Set(["over-cap", "page-fit", "skills-budget", "no-skills-line"]);

/** Stable 12-hex fingerprint of a JD's text — groups re-tailors of the same posting. */
export const jdHash = (jd) => createHash("sha256").update(String(jd).trim()).digest("hex").slice(0, 12);

function load(file = DEFAULT_FILE) {
  if (!existsSync(file)) return [];
  try { const d = JSON.parse(readFileSync(file, "utf8")); return Array.isArray(d) ? d : []; }
  catch { return []; } // corrupt log → start fresh rather than throw (never blocks a tailor run)
}
const persist = (rows, file = DEFAULT_FILE) => writeFileSync(file, JSON.stringify(rows, null, 2) + "\n");

/**
 * Append one application record from a tailorResume() result. Never throws — logging must not
 * break the tailor response. Returns the new record's id (echo it to the badge so the outcome can
 * be recorded later).
 */
export function logApplication({ jd, company = "", title = "", result }, file = DEFAULT_FILE) {
  const hash = jdHash(jd);
  const id = `${hash}-${Date.now().toString(36)}`;
  const record = {
    id,
    jd_hash: hash,
    at: new Date().toISOString(),
    company, title,
    exact_title: result?.analysis?.exact_title ?? "",
    served: result?.served ?? "master",
    score_master: result?.score_master ?? null,
    score_tailored: result?.score_tailored ?? null,
    additions: (result?.additions ?? []).map((a) => ({ keyword: a.keyword, evidence: a.evidence })),
    keywords_missing: (result?.keywords_missing ?? []).map((m) => ({ keyword: m.keyword, reason: m.reason })),
    callback: null, // null = unknown, true/false once you hear back
  };
  try { const rows = load(file); rows.push(record); persist(rows, file); }
  catch { /* logging is best-effort */ }
  return id;
}

/**
 * Record a callback outcome for a logged application. `callback` is coerced to boolean.
 * Returns { ok, id } or { ok:false, error }.
 */
export function recordOutcome(id, callback, file = DEFAULT_FILE) {
  const rows = load(file);
  const rec = rows.find((r) => r.id === id);
  if (!rec) return { ok: false, error: `no application with id ${id}` };
  rec.callback = !!callback;
  rec.outcome_at = new Date().toISOString();
  persist(rows, file);
  return { ok: true, id, callback: rec.callback };
}

/**
 * Aggregate the log into the "what to learn next" view.
 *   learn   — gap keywords ranked by how many applications they cost you (missed), with how many
 *             of those applications got NO callback (no_callback) — the sharpest signal.
 *   no_room — defensible keywords dropped only for one-page fit / cap (you have these already).
 * Plus headline callback stats.
 */
export function insights(file = DEFAULT_FILE) {
  const rows = load(file);
  const withOutcome = rows.filter((r) => r.callback !== null);
  const callbacks = withOutcome.filter((r) => r.callback === true).length;

  const learn = new Map();   // keyword → { keyword, missed, no_callback }
  const noRoom = new Map();  // keyword → { keyword, count }
  for (const r of rows) {
    const noCb = r.callback === false;
    for (const m of r.keywords_missing ?? []) {
      const kw = m.keyword;
      if (GAP_REASONS.has(m.reason)) {
        const e = learn.get(kw) ?? { keyword: kw, missed: 0, no_callback: 0 };
        e.missed++; if (noCb) e.no_callback++;
        learn.set(kw, e);
      } else if (NO_ROOM_REASONS.has(m.reason)) {
        const e = noRoom.get(kw) ?? { keyword: kw, count: 0 };
        e.count++; noRoom.set(kw, e);
      }
    }
  }
  const byMissed = (a, b) => b.no_callback - a.no_callback || b.missed - a.missed || a.keyword.localeCompare(b.keyword);
  return {
    total_applications: rows.length,
    with_outcome: withOutcome.length,
    callbacks,
    callback_rate: withOutcome.length ? +(callbacks / withOutcome.length).toFixed(3) : null,
    learn: [...learn.values()].sort(byMissed),
    no_room: [...noRoom.values()].sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword)),
  };
}

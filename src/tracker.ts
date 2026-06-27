import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG } from "../config.js";
import type { ScoredJob } from "./types.js";

/**
 * Local SQLite tracker of every job we've ever surfaced, so each run shows only
 * genuinely NEW postings. Also stores an `applied` flag you can flip by hand
 * (or via a future `npm run applied <id>`), and a `dupKey` so a job already
 * seen under one source/URL isn't re-shown when it reappears from another.
 */

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(dirname(CONFIG.data.dbFile), { recursive: true });
  db = new Database(CONFIG.data.dbFile);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      external_id TEXT PRIMARY KEY,
      dup_key     TEXT,
      title       TEXT,
      company     TEXT,
      url         TEXT,
      source      TEXT,
      score       INTEGER,
      first_seen  TEXT,
      last_seen   TEXT,
      applied     INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_dupkey ON jobs(dup_key);
  `);
  return db;
}

/** A job is "seen" if its externalId OR its dupKey already exists. */
export function splitNewVsSeen(jobs: ScoredJob[], dupKeyOf: (j: ScoredJob) => string) {
  const d = getDb();
  const byId = d.prepare("SELECT 1 FROM jobs WHERE external_id = ?");
  const byDup = d.prepare("SELECT 1 FROM jobs WHERE dup_key = ?");
  const fresh: ScoredJob[] = [];
  const seen: ScoredJob[] = [];
  for (const j of jobs) {
    const isSeen = byId.get(j.externalId) || byDup.get(dupKeyOf(j));
    (isSeen ? seen : fresh).push(j);
  }
  return { fresh, seen };
}

/** Record every job from this run (insert new, bump last_seen for existing). */
export function record(jobs: ScoredJob[], dupKeyOf: (j: ScoredJob) => string, nowIso: string): void {
  const d = getDb();
  const up = d.prepare(`
    INSERT INTO jobs (external_id, dup_key, title, company, url, source, score, first_seen, last_seen)
    VALUES (@external_id, @dup_key, @title, @company, @url, @source, @score, @now, @now)
    ON CONFLICT(external_id) DO UPDATE SET last_seen = @now, score = @score
  `);
  const tx = d.transaction((rows: ScoredJob[]) => {
    for (const j of rows) {
      up.run({
        external_id: j.externalId,
        dup_key: dupKeyOf(j),
        title: j.title,
        company: j.company,
        url: j.url,
        source: j.source,
        score: j.score,
        now: nowIso,
      });
    }
  });
  tx(jobs);
}

export function markApplied(externalId: string): boolean {
  const info = getDb().prepare("UPDATE jobs SET applied = 1 WHERE external_id = ?").run(externalId);
  return info.changes > 0;
}

export function stats(): { total: number; applied: number } {
  const d = getDb();
  const total = (d.prepare("SELECT COUNT(*) c FROM jobs").get() as { c: number }).c;
  const applied = (d.prepare("SELECT COUNT(*) c FROM jobs WHERE applied = 1").get() as { c: number }).c;
  return { total, applied };
}

/**
 * Neon Postgres persistence for the multi-city collector.
 *
 * Everything is keyed off DATABASE_URL (.env). The `jobs` table accumulates the
 * day's postings deduped by external_id — each hourly run UPSERTS, so a repeat
 * sighting refreshes last_seen_at + unions its search cities instead of creating
 * a duplicate row. The `runs` table logs each collection (auto or manual) so the
 * dashboard can show per-run counts and the scheduler's activity.
 *
 * No ORM: pg + hand-written SQL. The row count is small (a day's shortlist), so a
 * row-by-row upsert is perfectly fine and keeps the mapping obvious.
 */

import pg from "pg";
import type { ScoredJob } from "./types.js";

let pool: pg.Pool | null = null;

/** Lazily create the shared connection pool. Throws clearly if DATABASE_URL is unset. */
export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Run via `npm run collect` / `npm run dashboard` " +
        "(they pass --env-file=.env), or export DATABASE_URL yourself.",
    );
  }
  // Neon requires TLS; its pooled URL carries `sslmode=require`. node-postgres
  // needs the ssl option set explicitly (it doesn't honour sslmode from the URL).
  const needsSsl = /neon\.tech|sslmode=require/.test(connectionString);
  pool = new pg.Pool({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: 4,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}

/** Local-clock YYYY-MM-DD — the "run day" a collection belongs to. */
export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Create tables + indexes if absent. Safe to call on every startup. */
export async function initSchema(): Promise<void> {
  const sql = `
    CREATE TABLE IF NOT EXISTS jobs (
      external_id      text PRIMARY KEY,
      source           text NOT NULL,
      title            text NOT NULL,
      company          text,
      location         text,
      url              text,
      description      text,
      posted_at        timestamptz,
      salary           text,
      experience       text,
      remote           boolean,
      score            integer,
      tfidf_score      real,
      seniority        text,
      apply_type       text,
      applicants       text,
      hr_name          text,
      hr_profile_url   text,
      salary_band      jsonb,
      presence         jsonb,
      tags             jsonb,
      cities           text[] DEFAULT '{}',
      run_date         date NOT NULL,
      first_seen_at    timestamptz NOT NULL DEFAULT now(),
      last_seen_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS jobs_run_date_idx ON jobs (run_date);
    CREATE INDEX IF NOT EXISTS jobs_score_idx    ON jobs (score DESC);

    CREATE TABLE IF NOT EXISTS runs (
      id            serial PRIMARY KEY,
      started_at    timestamptz NOT NULL DEFAULT now(),
      finished_at   timestamptz,
      run_date      date NOT NULL,
      source        text NOT NULL DEFAULT 'linkedin',
      trigger       text NOT NULL DEFAULT 'manual',
      window_hours  integer,
      fetched       integer,
      prefiltered   integer,
      enriched      integer,
      final         integer,
      new_jobs      integer,
      status        text NOT NULL DEFAULT 'running',
      error         text
    );
    CREATE INDEX IF NOT EXISTS runs_run_date_idx ON runs (run_date);

    -- Every card we have actually READ (enriched + judged), kept whether it made
    -- the shortlist or not. \`jobs\` only ever holds winners, so without this the
    -- collector had no memory of the ~80% of each hourly run it had already
    -- rejected, and paid the enrich cost for them again every hour.
    CREATE TABLE IF NOT EXISTS seen_cards (
      external_id   text PRIMARY KEY,
      title         text,
      company       text,
      description   text,
      decision      text NOT NULL,          -- 'shortlisted' | 'dropped'
      reason        text,                   -- filter.ts drop reason, for auditing
      score         integer,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      decided_at    timestamptz NOT NULL DEFAULT now(),
      times_seen    integer NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS seen_cards_decided_idx ON seen_cards (decided_at);
  `;
  await getPool().query(sql);
}

/**
 * Upsert the day's shortlist. Dedup key is external_id: a repeat sighting keeps
 * first_seen_at, bumps last_seen_at, takes the HIGHER score, and unions the set
 * of search cities the posting surfaced under. Returns inserted vs updated counts
 * (via the xmax=0 "was this row just inserted?" trick).
 */
export async function upsertJobs(
  jobs: ScoredJob[],
  opts: { runDate: string; citiesByExternalId?: Map<string, string[]> },
): Promise<{ inserted: number; updated: number }> {
  if (!jobs.length) return { inserted: 0, updated: 0 };
  const p = getPool();
  const client = await p.connect();
  let inserted = 0, updated = 0;
  try {
    await client.query("BEGIN");
    for (const j of jobs) {
      const cities = opts.citiesByExternalId?.get(j.externalId) ?? [];
      const res = await client.query(
        `INSERT INTO jobs (
           external_id, source, title, company, location, url, description,
           posted_at, salary, experience, remote, score, tfidf_score, seniority,
           apply_type, applicants, hr_name, hr_profile_url, salary_band, presence,
           tags, cities, run_date
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
           $21,$22,$23
         )
         ON CONFLICT (external_id) DO UPDATE SET
           title          = EXCLUDED.title,
           company        = EXCLUDED.company,
           location       = EXCLUDED.location,
           url            = EXCLUDED.url,
           description    = COALESCE(NULLIF(EXCLUDED.description, ''), jobs.description),
           posted_at      = COALESCE(EXCLUDED.posted_at, jobs.posted_at),
           salary         = COALESCE(EXCLUDED.salary, jobs.salary),
           experience     = COALESCE(EXCLUDED.experience, jobs.experience),
           -- Take the NEW score whenever this sighting was scored on real JD
           -- text, else keep the stored one. (Was GREATEST(old, new), which made
           -- a score a permanent high-water mark: once a job scored 93 under an
           -- older scoring config it could never come down, so tuning the scorer
           -- had no visible effect on rows already in the table.)
           score          = CASE WHEN NULLIF(EXCLUDED.description, '') IS NOT NULL
                                 THEN EXCLUDED.score ELSE jobs.score END,
           tfidf_score    = CASE WHEN NULLIF(EXCLUDED.description, '') IS NOT NULL
                                 THEN EXCLUDED.tfidf_score ELSE jobs.tfidf_score END,
           seniority      = EXCLUDED.seniority,
           apply_type     = COALESCE(EXCLUDED.apply_type, jobs.apply_type),
           applicants     = COALESCE(EXCLUDED.applicants, jobs.applicants),
           hr_name        = COALESCE(EXCLUDED.hr_name, jobs.hr_name),
           hr_profile_url = COALESCE(EXCLUDED.hr_profile_url, jobs.hr_profile_url),
           salary_band    = COALESCE(EXCLUDED.salary_band, jobs.salary_band),
           presence       = COALESCE(EXCLUDED.presence, jobs.presence),
           cities         = ARRAY(SELECT DISTINCT unnest(COALESCE(jobs.cities,'{}') || EXCLUDED.cities)),
           run_date       = EXCLUDED.run_date,
           last_seen_at   = now()
         RETURNING (xmax = 0) AS inserted`,
        [
          j.externalId, j.source, j.title, j.company ?? null, j.location ?? null,
          j.url ?? null, j.description ?? null, j.postedAt ?? null, j.salary ?? null,
          j.experience ?? null, j.remote ?? null, j.score ?? null,
          j.tfidfScore ?? null, j.seniority ?? null, j.applyType ?? null,
          j.applicants ?? null, j.hrName ?? null, j.hrProfileUrl ?? null,
          j.salaryBand ? JSON.stringify(j.salaryBand) : null,
          j.presence ? JSON.stringify(j.presence) : null,
          JSON.stringify(j.tags ?? []), cities, opts.runDate,
        ],
      );
      if (res.rows[0]?.inserted) inserted++; else updated++;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { inserted, updated };
}

/** A card the collector has already read and ruled on. See `seen_cards` above. */
export interface SeenCard {
  externalId: string;
  description: string;
  decision: "shortlisted" | "dropped";
  decidedAt: Date;
}

/** Look up prior verdicts for a batch of card ids. Missing ids = never read. */
export async function getSeenCards(externalIds: string[]): Promise<Map<string, SeenCard>> {
  const out = new Map<string, SeenCard>();
  if (!externalIds.length) return out;
  const { rows } = await getPool().query(
    `SELECT external_id, description, decision, decided_at
       FROM seen_cards WHERE external_id = ANY($1)`,
    [externalIds],
  );
  for (const r of rows) {
    out.set(r.external_id, {
      externalId: r.external_id,
      description: r.description ?? "",
      decision: r.decision === "shortlisted" ? "shortlisted" : "dropped",
      decidedAt: new Date(r.decided_at),
    });
  }
  return out;
}

/**
 * Record verdicts for cards we actually read this run. Re-recording an existing
 * card refreshes the verdict + `decided_at` (so the skip window slides forward)
 * and bumps `times_seen`; `first_seen_at` is preserved.
 */
export async function recordSeenCards(
  entries: { externalId: string; title: string; company?: string; description: string; decision: "shortlisted" | "dropped"; reason?: string; score?: number }[],
): Promise<void> {
  if (!entries.length) return;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    for (const e of entries) {
      await client.query(
        `INSERT INTO seen_cards (external_id, title, company, description, decision, reason, score)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (external_id) DO UPDATE SET
           title       = EXCLUDED.title,
           company     = EXCLUDED.company,
           description = COALESCE(NULLIF(EXCLUDED.description, ''), seen_cards.description),
           decision    = EXCLUDED.decision,
           reason      = EXCLUDED.reason,
           score       = EXCLUDED.score,
           decided_at  = now(),
           times_seen  = seen_cards.times_seen + 1`,
        [e.externalId, e.title, e.company ?? null, e.description, e.decision, e.reason ?? null, e.score ?? null],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** All jobs for a run day, ranked by match %. Rows are camelCase-ish for the UI. */
export async function getJobsForDate(date: string): Promise<Record<string, unknown>[]> {
  const { rows } = await getPool().query(
    // `description` (the full JD, several KB per row) is deliberately NOT
    // selected: the table never renders it, and shipping it made this endpoint
    // ~175KB and tens of seconds over Neon. Fetch it per-job if ever needed.
    `SELECT external_id, source, title, company, location, url,
            posted_at, salary, experience, remote, score, tfidf_score, seniority,
            apply_type, applicants, hr_name, hr_profile_url, salary_band, presence,
            cities, first_seen_at, last_seen_at
       FROM jobs
      WHERE run_date = $1
      ORDER BY score DESC NULLS LAST, last_seen_at DESC`,
    [date],
  );
  return rows;
}

export async function startRun(meta: {
  runDate: string;
  trigger: "auto" | "manual";
  windowHours: number;
}): Promise<number> {
  const { rows } = await getPool().query(
    `INSERT INTO runs (run_date, trigger, window_hours, status)
     VALUES ($1, $2, $3, 'running') RETURNING id`,
    [meta.runDate, meta.trigger, meta.windowHours],
  );
  return rows[0].id as number;
}

export async function finishRun(
  id: number,
  meta: {
    status: "ok" | "error";
    fetched?: number;
    prefiltered?: number;
    enriched?: number;
    final?: number;
    newJobs?: number;
    error?: string;
  },
): Promise<void> {
  await getPool().query(
    `UPDATE runs SET
       finished_at = now(), status = $2, fetched = $3, prefiltered = $4,
       enriched = $5, final = $6, new_jobs = $7, error = $8
     WHERE id = $1`,
    [id, meta.status, meta.fetched ?? null, meta.prefiltered ?? null,
      meta.enriched ?? null, meta.final ?? null, meta.newJobs ?? null, meta.error ?? null],
  );
}

export async function getRunsForDate(date: string): Promise<Record<string, unknown>[]> {
  const { rows } = await getPool().query(
    `SELECT id, started_at, finished_at, trigger, window_hours, fetched,
            prefiltered, enriched, final, new_jobs, status, error
       FROM runs WHERE run_date = $1 ORDER BY started_at DESC`,
    [date],
  );
  return rows;
}

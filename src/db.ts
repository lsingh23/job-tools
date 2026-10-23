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

import net from "node:net";
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
  // Node's happy-eyeballs gives each resolved address only 250ms to finish the
  // TCP handshake before trying the next. A handshake to Neon us-east-1 from
  // here takes ~280-350ms, so EVERY address (3 v4 + 3 v6) times out and pg
  // surfaces an AggregateError with an empty message — the "[db] … failed ()"
  // retries, even though the host is perfectly reachable. Give each attempt 2s.
  net.setDefaultAutoSelectFamilyAttemptTimeout(2_000);
  const needsSsl = /neon\.tech|sslmode=require/.test(connectionString);
  pool = new pg.Pool({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: 4,
    // A collection run spends 10+ minutes scraping between its first DB write
    // (startRun) and its last (upsertJobs). Neon's proxy — and any NAT in
    // between — drops a connection that has been silent that long, so keep the
    // socket warm and reap idle clients quickly rather than handing a corpse
    // back out on the next checkout.
    keepAlive: true,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  });
  // MUST exist: node-postgres re-emits a dead idle client's socket error on the
  // pool, and an unhandled 'error' event takes the whole process down (that is
  // the `read ETIMEDOUT` crash that used to kill a run right after ranking).
  // The client has already been evicted by the time we get here; nothing to do
  // but note it and let the next checkout dial a fresh connection.
  pool.on("error", (err) => {
    process.stderr.write(`[db] idle client dropped: ${err instanceof Error ? err.message : String(err)}\n`);
  });
  return pool;
}

/** Connection-level failures that a retry on a fresh socket can plausibly fix. */
/** AggregateError (multi-address connect failure) has an empty message; show its parts. */
function errText(err: unknown): string {
  if (err instanceof AggregateError && !err.message) {
    return err.errors.map((e) => (e as { code?: string }).code ?? String(e)).join(", ") || "AggregateError";
  }
  return err instanceof Error ? err.message : String(err);
}

function isTransient(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code && ["ETIMEDOUT", "ECONNRESET", "EPIPE", "ENOTFOUND", "ECONNREFUSED", "EHOSTUNREACH",
    "57P01" /* admin_shutdown */, "57P03" /* cannot_connect_now */, "08006", "08003", "08001"].includes(code)) {
    return true;
  }
  const msg = err instanceof Error ? err.message : "";
  return /Connection terminated|connection closed|timeout exceeded|socket hang up/i.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a DB unit of work, retrying once or twice if the connection (not the SQL)
 * failed. Every write in a collection run is the tail of an expensive scrape —
 * losing it to a stale socket means the whole run's work is thrown away.
 */
async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === 2) throw err;
      const wait = 500 * 2 ** attempt;
      process.stderr.write(
        `[db] ${what} failed (${errText(err)}) — retrying in ${wait}ms\n`,
      );
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** pool.query with connection-level retry. */
async function query(what: string, text: string, values?: unknown[]): Promise<pg.QueryResult> {
  return withRetry(what, () => getPool().query(text, values as never));
}

/**
 * Check out a client, run `fn` inside a transaction, and always put the client
 * back. An error listener is attached for the duration: while a client is
 * checked out the pool is NOT listening on it, so a socket error would
 * otherwise be an unhandled 'error' event and crash the process. On failure the
 * client is destroyed rather than returned to the pool.
 */
async function inTransaction<T>(what: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withRetry(what, async () => {
    const client = await getPool().connect();
    const onError = () => {}; // presence is the point; the query promise carries the error
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      client.removeListener("error", onError);
      client.release();
      return out;
    } catch (err) {
      // ROLLBACK only over a connection that can still answer. When the failure
      // IS the connection (backend terminated, socket dropped), the ROLLBACK is
      // queued against a socket that will never reply and the promise never
      // settles — that hangs the retry forever. Destroying the client rolls the
      // transaction back server-side anyway. The race is a belt-and-braces
      // bound for the in-between case (SQL error on a connection that then dies).
      if (!isTransient(err)) {
        await Promise.race([client.query("ROLLBACK").catch(() => {}), sleep(2_000)]);
      }
      client.removeListener("error", onError);
      client.release(true); // destroy: this connection is not trustworthy
      throw err;
    }
  });
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
      -- Surfaced without its JD ever being fetched: score is meaningless, the
      -- UI shows a "JD not fetched" badge instead of a misleading 0% score.
      jd_missing       boolean NOT NULL DEFAULT false,
      -- Match % BEFORE penalties, and the reasons points were taken off.
      -- Nothing is filtered out any more (src/filter.ts) — a weak job is a
      -- low-scoring row with visible reasons, not a deletion.
      base_score       integer,
      penalties        jsonb,
      first_seen_at    timestamptz NOT NULL DEFAULT now(),
      last_seen_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS jobs_run_date_idx ON jobs (run_date);
    CREATE INDEX IF NOT EXISTS jobs_score_idx    ON jobs (score DESC);
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS jd_missing boolean NOT NULL DEFAULT false;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS base_score integer;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS penalties  jsonb;
    -- Which items of YOUR stack the JD names, and the points that overlap added
    -- (CONFIG.stackProfile). Stored so the row can SHOW why it ranks where it
    -- does — a bare score can't distinguish "React+TS and nothing else" from
    -- "React+TS+Next+Tailwind+TanStack+Playwright+Vercel".
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS stack      jsonb;
    -- "Send your CV to hr@…" / "Immediate joiner" / a raw address in the JD
    -- (src/direct-apply.ts). NOT a quality signal and NOT tied to score: it
    -- marks the postings you can answer by writing to a person. Indexed
    -- partially because the interesting query is always "show me the hits".
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS direct_apply jsonb;
    CREATE INDEX IF NOT EXISTS jobs_direct_apply_idx ON jobs (run_date)
      WHERE direct_apply IS NOT NULL;

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
      times_seen    integer NOT NULL DEFAULT 1,
      -- Fingerprint of the scoring/filter config this verdict was made under
      -- (src/fingerprint.ts). A rejection is only reusable while it matches.
      config_hash   text
    );
    CREATE INDEX IF NOT EXISTS seen_cards_decided_idx ON seen_cards (decided_at);
    ALTER TABLE seen_cards ADD COLUMN IF NOT EXISTS config_hash text;
  `;
  await query("initSchema", sql);
}

/**
 * Chunk a list so one statement never exceeds Postgres' 65535-parameter limit
 * (and stays a sane size to re-send on a retry).
 */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `($1,$2,…),($3,$4,…)` — one placeholder group per row of a multi-row INSERT. */
function placeholders(rows: number, cols: number): string {
  let n = 0;
  return Array.from({ length: rows }, () =>
    "(" + Array.from({ length: cols }, () => `$${++n}`).join(",") + ")").join(",");
}

/**
 * Upsert the day's shortlist. Dedup key is external_id: a repeat sighting keeps
 * first_seen_at, bumps last_seen_at, takes the HIGHER score, and unions the set
 * of search cities the posting surfaced under. Returns inserted vs updated counts
 * (via the xmax=0 "was this row just inserted?" trick).
 *
 * Rows go in a FEW multi-row statements, not one statement per job. Neon round
 * trips cost ~300ms from here, so the old row-by-row loop held a transaction
 * open for ~40s per 120 rows — which is both slow and the main reason a run
 * ever met a dropped connection at all.
 */
export async function upsertJobs(
  jobs: ScoredJob[],
  opts: { runDate: string; citiesByExternalId?: Map<string, string[]> },
  /**
   * `insertedIds` = external_ids that were genuinely NEW rows (Postgres
   * `xmax = 0`), not refreshed sightings. The alerting path needs this: a good
   * job is re-seen by every run inside its 2h window, so alerting on "score >=
   * 70 in this batch" would re-fire the same banner for hours.
   */
): Promise<{ inserted: number; updated: number; insertedIds: string[] }> {
  const insertedIds: string[] = [];
  if (!jobs.length) return { inserted: 0, updated: 0, insertedIds };
  // ON CONFLICT DO UPDATE cannot touch the same row twice in one statement, so
  // collapse any duplicate externalId first (last sighting wins).
  const byId = new Map<string, ScoredJob>();
  for (const j of jobs) byId.set(j.externalId, j);
  const unique = [...byId.values()];

  // The whole transaction is the retry unit — it's a pure UPSERT, so replaying
  // it is safe (the counters are re-derived from scratch on each attempt).
  return inTransaction("upsertJobs", async (client) => {
    let inserted = 0, updated = 0;
    for (const batch of chunk(unique, 100)) {
      const values: unknown[] = [];
      for (const j of batch) {
        values.push(
          j.externalId, j.source, j.title, j.company ?? null, j.location ?? null,
          j.url ?? null, j.description ?? null, j.postedAt ?? null, j.salary ?? null,
          j.experience ?? null, j.remote ?? null, j.score ?? null,
          j.tfidfScore ?? null, j.seniority ?? null, j.applyType ?? null,
          j.applicants ?? null, j.hrName ?? null, j.hrProfileUrl ?? null,
          j.salaryBand ? JSON.stringify(j.salaryBand) : null,
          j.presence ? JSON.stringify(j.presence) : null,
          JSON.stringify(j.tags ?? []), opts.citiesByExternalId?.get(j.externalId) ?? [],
          opts.runDate, j.jdMissing ?? false,
          j.baseScore ?? j.score ?? null, JSON.stringify(j.penalties ?? []),
          JSON.stringify({ hits: j.stackHits ?? [], bonus: j.stackBonus ?? 0, anchored: j.stackAnchored ?? false, pure: j.stackPure ?? false }),
          j.directApply ? JSON.stringify(j.directApply) : null,
        );
      }
      const res = await client.query(
        `INSERT INTO jobs (
           external_id, source, title, company, location, url, description,
           posted_at, salary, experience, remote, score, tfidf_score, seniority,
           apply_type, applicants, hr_name, hr_profile_url, salary_band, presence,
           tags, cities, run_date, jd_missing, base_score, penalties, stack,
           direct_apply
         ) VALUES ${placeholders(batch.length, 28)}
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
           -- Once ANY sighting has read the JD, the row is no longer "unread".
           jd_missing     = CASE WHEN NULLIF(EXCLUDED.description, '') IS NOT NULL
                                 THEN false ELSE jobs.jd_missing END,
           -- Penalties travel with the score: refresh both only when this
           -- sighting actually read the JD.
           base_score     = CASE WHEN NULLIF(EXCLUDED.description, '') IS NOT NULL
                                 THEN EXCLUDED.base_score ELSE jobs.base_score END,
           penalties      = CASE WHEN NULLIF(EXCLUDED.description, '') IS NOT NULL
                                 THEN EXCLUDED.penalties ELSE jobs.penalties END,
           stack          = CASE WHEN NULLIF(EXCLUDED.description, '') IS NOT NULL
                                 THEN EXCLUDED.stack ELSE jobs.stack END,
           -- Same rule as penalties/stack: only a sighting that actually READ
           -- the JD may rewrite this. A card re-seen without its description
           -- must not erase the contact details an earlier read found.
           direct_apply   = CASE WHEN NULLIF(EXCLUDED.description, '') IS NOT NULL
                                 THEN EXCLUDED.direct_apply ELSE jobs.direct_apply END,
           last_seen_at   = now()
         RETURNING external_id, (xmax = 0) AS inserted`,
        values,
      );
      for (const r of res.rows) {
        if (r.inserted) { inserted++; insertedIds.push(r.external_id as string); }
        else updated++;
      }
    }
    return { inserted, updated, insertedIds };
  });
}

/** A card the collector has already read and ruled on. See `seen_cards` above. */
export interface SeenCard {
  externalId: string;
  description: string;
  decision: "shortlisted" | "dropped";
  decidedAt: Date;
  /** Config fingerprint the verdict was made under; null for pre-upgrade rows. */
  configHash: string | null;
}

/** Look up prior verdicts for a batch of card ids. Missing ids = never read. */
export async function getSeenCards(externalIds: string[]): Promise<Map<string, SeenCard>> {
  const out = new Map<string, SeenCard>();
  if (!externalIds.length) return out;
  const { rows } = await query(
    "getSeenCards",
    `SELECT external_id, description, decision, decided_at, config_hash
       FROM seen_cards WHERE external_id = ANY($1)`,
    [externalIds],
  );
  for (const r of rows) {
    out.set(r.external_id, {
      externalId: r.external_id,
      description: r.description ?? "",
      decision: r.decision === "shortlisted" ? "shortlisted" : "dropped",
      decidedAt: new Date(r.decided_at),
      configHash: r.config_hash ?? null,
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
  entries: { externalId: string; title: string; company?: string; description: string; decision: "shortlisted" | "dropped"; reason?: string; score?: number; configHash?: string }[],
): Promise<void> {
  if (!entries.length) return;
  // Same story as upsertJobs: batch the rows, and collapse duplicate ids first
  // (ON CONFLICT DO UPDATE may not hit the same row twice in one statement).
  const byId = new Map<string, (typeof entries)[number]>();
  for (const e of entries) byId.set(e.externalId, e);

  await inTransaction("recordSeenCards", async (client) => {
    for (const batch of chunk([...byId.values()], 400)) {
      const values: unknown[] = [];
      for (const e of batch) {
        values.push(e.externalId, e.title, e.company ?? null, e.description, e.decision,
          e.reason ?? null, e.score ?? null, e.configHash ?? null);
      }
      await client.query(
        `INSERT INTO seen_cards (external_id, title, company, description, decision, reason, score, config_hash)
         VALUES ${placeholders(batch.length, 8)}
         ON CONFLICT (external_id) DO UPDATE SET
           title       = EXCLUDED.title,
           company     = EXCLUDED.company,
           description = COALESCE(NULLIF(EXCLUDED.description, ''), seen_cards.description),
           decision    = EXCLUDED.decision,
           reason      = EXCLUDED.reason,
           score       = EXCLUDED.score,
           config_hash = EXCLUDED.config_hash,
           decided_at  = now(),
           times_seen  = seen_cards.times_seen + 1`,
        values,
      );
    }
  });
}

/** All jobs for a run day, ranked by match %. Rows are camelCase-ish for the UI. */
export async function getJobsForDate(date: string): Promise<Record<string, unknown>[]> {
  const { rows } = await query(
    "getJobsForDate",
    // `description` (the full JD, several KB per row) is deliberately NOT
    // selected: the table never renders it, and shipping it made this endpoint
    // ~175KB and tens of seconds over Neon. Fetch it per-job if ever needed.
    `SELECT external_id, source, title, company, location, url,
            posted_at, salary, experience, remote, score, tfidf_score, seniority,
            apply_type, applicants, hr_name, hr_profile_url, salary_band, presence,
            cities, jd_missing, base_score, penalties, stack, direct_apply,
            first_seen_at, last_seen_at
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
  /**
   * Which collector this run belongs to. Defaults to 'linkedin' to match the
   * column default and every run recorded before the ATS collector existed —
   * without it the two schedulers' runs are indistinguishable in the status
   * strip, and an ATS tick every 15 min would drown the half-hourly city runs.
   */
  source?: string;
}): Promise<number> {
  const { rows } = await query(
    "startRun",
    `INSERT INTO runs (run_date, trigger, window_hours, status, source)
     VALUES ($1, $2, $3, 'running', $4) RETURNING id`,
    [meta.runDate, meta.trigger, meta.windowHours, meta.source ?? "linkedin"],
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
  await query(
    "finishRun",
    `UPDATE runs SET
       finished_at = now(), status = $2, fetched = $3, prefiltered = $4,
       enriched = $5, final = $6, new_jobs = $7, error = $8
     WHERE id = $1`,
    [id, meta.status, meta.fetched ?? null, meta.prefiltered ?? null,
      meta.enriched ?? null, meta.final ?? null, meta.newJobs ?? null, meta.error ?? null],
  );
}

export async function getRunsForDate(date: string): Promise<Record<string, unknown>[]> {
  const { rows } = await query(
    "getRunsForDate",
    `SELECT id, started_at, finished_at, trigger, window_hours, fetched,
            prefiltered, enriched, final, new_jobs, status, error
       FROM runs WHERE run_date = $1 ORDER BY started_at DESC`,
    [date],
  );
  return rows;
}

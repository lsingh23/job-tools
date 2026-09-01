/**
 * Re-score every stored job against the CURRENT scoring config, in place.
 *
 * Scores are computed at collection time and frozen in the row, so a scoring
 * change (weights, title classes, backend penalty) only reaches jobs the
 * collector happens to see again. This applies it to everything already stored,
 * using each row's saved JD text — no network calls.
 *
 *   node --env-file=.env --import tsx scripts/rescore.ts          # preview only
 *   node --env-file=.env --import tsx scripts/rescore.ts --apply  # write back
 */
import { getPool, closePool } from "../src/db.js";
import { scoreJob } from "../src/scoring.js";
import { loadKeywords } from "../src/resume.js";
import { CONFIG } from "../config.js";
import type { Job } from "../src/types.js";

const apply = process.argv.includes("--apply");
const keywords = loadKeywords();
const p = getPool();

const { rows } = await p.query(
  `SELECT external_id, title, company, description, experience, tags, score, base_score, penalties
     FROM jobs ORDER BY score DESC NULLS LAST`,
);

const changes: {
  id: string; title: string; old: number; neu: number; base: number; cls: string;
  stack: { hits: string[]; bonus: number; anchored: boolean };
}[] = [];
for (const r of rows) {
  if (!r.description) continue; // never re-score a row we have no JD for
  const job: Job = {
    source: "linkedin", externalId: r.external_id, title: r.title, company: r.company ?? "",
    location: "", url: "", description: r.description, postedAt: null, salary: null,
    experience: r.experience, remote: false, tags: Array.isArray(r.tags) ? r.tags : [],
  };
  const s = scoreJob(job, keywords);
  // scoreJob returns the PRE-penalty match %, but `jobs.score` is post-penalty —
  // comparing the two directly (as this script used to) reads every penalty as a
  // scoring change, and writing it back would have silently erased them. The
  // row's own recorded penalties are re-applied instead: they were judged from
  // fields (years, company, age) that a re-score doesn't touch. The one penalty
  // that can't be recomputed here is bulk-posting, which is per-RUN — another
  // reason to reuse the stored list rather than recompute it over the table.
  const pens: { points: number }[] = Array.isArray(r.penalties) ? r.penalties : [];
  const taken = pens.reduce((n, x) => n + (x.points ?? 0), 0);
  changes.push({
    id: r.external_id, title: r.title, old: r.score ?? 0, base: s.score,
    neu: Math.max(0, s.score - taken), cls: s.titleClass ?? "?",
    stack: { hits: s.stackHits ?? [], bonus: s.stackBonus ?? 0, anchored: s.stackAnchored ?? false },
  });
}

changes.sort((a, b) => (b.neu - b.old) - (a.neu - a.old));
// The stack column is written for EVERY row, not just the ones whose score
// moved: a row can keep its score and still have new stack evidence to show.
const moved = changes.filter((c) => c.neu !== c.old);
process.stderr.write(`${changes.length} rows with a JD, ${moved.length} would change\n\n`);
for (const c of [...moved.slice(0, 8), ...moved.slice(-8)]) {
  process.stderr.write(`  ${String(c.old).padStart(3)} → ${String(c.neu).padStart(3)}  ${c.cls.padEnd(9)} ${c.title.slice(0, 60)}\n`);
}
const belowFloor = changes.filter((c) => c.neu < CONFIG.filter.minScore).length;
process.stderr.write(`\n${belowFloor} rows would fall below minScore ${CONFIG.filter.minScore} (they stay in the table, just rank last)\n`);

if (!apply) {
  process.stderr.write("\npreview only — re-run with --apply to write\n");
} else {
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    for (const c of changes)
      await client.query(
        "UPDATE jobs SET score = $2, base_score = $3, stack = $4 WHERE external_id = $1",
        [c.id, c.neu, c.base, JSON.stringify(c.stack)],
      );
    await client.query("COMMIT");
    process.stderr.write(`\nupdated ${moved.length} scores, wrote stack on ${changes.length} rows\n`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
await closePool();

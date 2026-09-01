import { getPool, closePool, recordSeenCards, getSeenCards } from "./db.js";
const p = getPool();
const ids = Array.from({ length: 800 }, (_, i) => `__test_${i}`);
let killed = 0;
const kill = async () => {
  const { Client } = (await import("pg")).default;
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const { rows } = await c.query("select pid from pg_stat_activity where query like 'INSERT INTO seen_cards%'");
  for (const r of rows) { await c.query(`select pg_terminate_backend(${r.pid})`).catch(() => {}); killed++; }
  await c.end();
};
setTimeout(() => { void kill(); }, 200);
const t0 = Date.now();
await recordSeenCards(ids.map((id) => ({
  externalId: id, title: "t", description: "d", decision: "dropped" as const, reason: "test",
})));
console.log(`killed ${killed} backend(s); recorded ${(await getSeenCards(ids)).size} rows in ${Date.now() - t0}ms`);
await p.query("delete from seen_cards where external_id like '\\_\\_test\\_%'");
await closePool();
console.log("OK — work survived the kill");

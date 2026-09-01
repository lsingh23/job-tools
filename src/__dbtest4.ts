import { getPool, closePool, recordSeenCards, getSeenCards } from "./db.js";
const p = getPool();
const ids = Array.from({ length: 800 }, (_, i) => `__test_${i}`);
let killed = 0;
const t = setInterval(async () => {
  if (killed) return; // kill only the FIRST attempt — the retry must then succeed
  const { rows } = await p.query(
    "select pid from pg_stat_activity where query like 'INSERT INTO seen_cards%' and pid <> pg_backend_pid()");
  for (const r of rows) { await p.query(`select pg_terminate_backend(${r.pid})`).catch(() => {}); killed++; }
}, 150);
await recordSeenCards(ids.map((id) => ({
  externalId: id, title: "t", description: "d", decision: "dropped" as const, reason: "test",
})));
clearInterval(t);
console.log(`killed ${killed} backend(s) on attempt 1; rows recorded after retry:`, (await getSeenCards(ids)).size);
await p.query("delete from seen_cards where external_id like '\\_\\_test\\_%'");
await closePool();
console.log("OK — work survived");

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CONFIG } from "../config.js";
import { initSchema, getJobsForDate, getRunsForDate, today } from "./db.js";
import { runCollection } from "./collect.js";
import { runAtsCollection, dueCompanies } from "./ats-collect.js";
import { FOREIGN_TOKENS } from "./sources/ats.js";
import { loadRegistry } from "./discover.js";
import { notify, notifyCollectDone, notifyCollectFailed } from "./notify.js";
import { runHotCheck, hotHistory } from "./hot.js";
import { runNaukriHotCheck, naukriHotHistory } from "./naukri-hot.js";
import { gateStats } from "./http.js";

const PORT = Number(process.env.PORT ?? 5173);
const OUTPUT_DIR = resolve(CONFIG.output.dir);

/** Minimal RFC-4180-ish CSV parser (handles quotes, embedded commas/newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

function json(res: import("node:http").ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  // These endpoints are live state (today's jobs, run log). With no validators
  // and no Cache-Control, a 200 is heuristically cacheable — the browser will
  // happily replay an early, empty /api/today forever and never ask again.
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(s),
    "cache-control": "no-store, must-revalidate",
  });
  res.end(s);
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => ok(s));
    req.on("error", fail);
  });
}

/** List CSV runs in ./output, newest first. */
async function listRuns(): Promise<{ name: string; mtime: number; rows: number }[]> {
  let files: string[];
  try { files = await readdir(OUTPUT_DIR); }
  catch { return []; }
  const csvs = files.filter((f) => f.endsWith(".csv"));
  const out = await Promise.all(
    csvs.map(async (name) => {
      const st = await stat(join(OUTPUT_DIR, name));
      const text = await readFile(join(OUTPUT_DIR, name), "utf8");
      const rows = Math.max(0, parseCsv(text).length - 1);
      return { name, mtime: st.mtimeMs, rows };
    }),
  );
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Shared in-flight guard: only ONE of {single search, manual collect, auto
// collect} runs at a time, so they never fight over the polite-fetch budget.
let running = false;

/**
 * SEPARATE in-flight guard for the ATS collector — deliberately not `running`.
 *
 * The scraped sources share one lock because they share one scarce resource:
 * the polite-fetch budget against LinkedIn/Naukri, who are actively watching.
 * The ATS poller talks to entirely different first-party JSON APIs at 6-wide
 * concurrency with no delay, so it competes for nothing. Folding it into
 * `running` would mean a 15-minute ATS tick could be holding the lock at :00 or
 * :30 and silently make the city collector skip that slot.
 */
let atsRunning = false;

/**
 * SEPARATE in-flight guard for the hot checker, for a different reason again.
 *
 * The hot tick DOES compete for the LinkedIn budget — but the gate in
 * src/http.ts is what arbitrates that now, request by request, rather than a
 * lock that would make one loop wait out the other entirely. Sharing `running`
 * would be doubly wrong: a tick would be blocked for the sweep's 16 minutes
 * (killing the latency it exists to provide), and would itself grey out the
 * manual search buttons every 5 minutes.
 */
let hotRunning = false;
let naukriHotRunning = false;

/** "HH:MM" → minutes since local midnight. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True when the local wall clock is inside the configured collect window. */
function inActiveWindow(at: Date = new Date()): boolean {
  const { start, end } = CONFIG.collect.activeWindow;
  const mins = at.getHours() * 60 + at.getMinutes();
  return mins >= toMinutes(start) && mins <= toMinutes(end);
}

/**
 * Hand-rolled scheduler (no cron dependency): fire on each `intervalMinutes`
 * slot of the hour (:00 and :30 at the default 30), and only actually collect
 * when inside CONFIG.collect.activeWindow and nothing else is running.
 */
function startScheduler(): void {
  const tick = async () => {
    if (inActiveWindow() && !running) {
      running = true;
      try {
        console.log(`\n[scheduler] auto-collect @ ${new Date().toLocaleTimeString()}`);
        const r = await runCollection({ trigger: "auto", log: (...a) => console.log(...a) });
        console.log(`[scheduler] done → ${r.final} shortlisted, ${r.inserted} new / ${r.updated} refreshed`);
        await notifyCollectDone(r);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[scheduler] auto-collect failed:", msg);
        await notifyCollectFailed(msg);
      } finally {
        running = false;
      }
    }
    scheduleNextSlot();
  };
  /**
   * Arm the next slot on the wall-clock grid (…:00:05, :30:05 for step=30), not
   * `now + step`: a fixed interval would drift off the grid after a slow run or a
   * laptop sleep, so slots are always recomputed from the current clock.
   */
  const scheduleNextSlot = () => {
    const step = CONFIG.collect.intervalMinutes;
    const now = new Date();
    const next = new Date(now);
    const slot = (Math.floor(now.getMinutes() / step) + 1) * step; // next grid minute
    next.setMinutes(slot, 5, 0); // +5s guard against firing a hair early on clock skew
    setTimeout(tick, Math.max(1000, next.getTime() - now.getTime()));
  };
  const { start, end } = CONFIG.collect.activeWindow;
  const perDay = Math.floor((toMinutes(end) - toMinutes(start)) / CONFIG.collect.intervalMinutes) + 1;
  console.log(
    `[scheduler] auto-collect armed every ${CONFIG.collect.intervalMinutes} min, ` +
      `${start}–${end} local time (${perDay} runs/day).`,
  );
  scheduleNextSlot();
}

/**
 * The ATS scheduler — an independent timer on its own lock.
 *
 * Each tick polls only the boards due for refresh (rotating slice, see
 * CONFIG.ats.poll), never the whole registry: 930 boards every 15 minutes would
 * be ~89,000 requests/day against free APIs, and buys nothing when the postings
 * themselves stay open for weeks.
 */
function startAtsScheduler(): void {
  const step = CONFIG.ats.poll.intervalMinutes;
  const win = CONFIG.ats.poll.activeWindow;

  const tick = async () => {
    const inWindow = !win || inWindowRange(win.start, win.end);
    if (inWindow && !atsRunning) {
      atsRunning = true;
      try {
        const r = await runAtsCollection({ log: (...a) => console.log(...a) });
        console.log(
          `[ats] done → ${r.final} shortlisted, ${r.inserted} new / ${r.updated} refreshed ` +
            `(${r.boards}/${r.registrySize} boards, ${r.failed} failed)`,
        );
      } catch (err) {
        console.error("[ats] auto-poll failed:", err instanceof Error ? err.message : String(err));
      } finally {
        atsRunning = false;
      }
    }
    armNext();
  };
  // Same wall-clock grid logic as the city scheduler: recompute from the clock
  // each time so a slow run or a laptop sleep can't leave the timer drifting.
  const armNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes((Math.floor(now.getMinutes() / step) + 1) * step, 10, 0);
    setTimeout(tick, Math.max(1000, next.getTime() - now.getTime()));
  };
  console.log(
    `[ats] auto-poll armed every ${step} min ` +
      `(${win ? `${win.start}–${win.end}` : "24/7"}, ` +
      `≤${CONFIG.ats.poll.maxBoardsPerTick} boards/tick, each board every ${CONFIG.ats.poll.refreshMinutes}m).`,
  );
  armNext();
}

/**
 * The HOT scheduler — a third timer, on its own lock (src/hot.ts).
 *
 * Its own lock matters twice over: a tick must not be blocked by the 16-minute
 * sweep (that would defeat the entire point), and — unlike the sweep — it must
 * not block YOU. The manual "Run all cities now" and "Quick search" buttons gate
 * on `running`, which the hot tick deliberately never sets, so a 40-second tick
 * every 5 minutes stays invisible to the UI.
 *
 * Concurrency with the sweep is safe because both share the LinkedIn gate in
 * src/http.ts: overlapping loops interleave inside one request budget instead of
 * doubling the rate.
 */
function startHotScheduler(): void {
  const step = CONFIG.hot.intervalMinutes;
  const win = CONFIG.hot.activeWindow;

  const tick = async () => {
    const inWindow = !win || inWindowRange(win.start, win.end);
    if (inWindow && !hotRunning) {
      hotRunning = true;
      try {
        await runHotCheck({ log: (...a) => console.log(...a) });
      } catch (err) {
        // runHotCheck already swallows its own failures; this is belt-and-braces
        // so a bug in the tick can never kill the timer chain.
        console.error("[hot] tick threw:", err instanceof Error ? err.message : String(err));
      } finally {
        hotRunning = false;
      }
    }
    armNext();
  };
  const armNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes((Math.floor(now.getMinutes() / step) + 1) * step, 20, 0);
    setTimeout(tick, Math.max(1000, next.getTime() - now.getTime()));
  };
  console.log(
    `[hot] fast checker armed every ${step} min (${win ? `${win.start}–${win.end}` : "24/7"}, ` +
      `${CONFIG.hot.windowMinutes}m window, ≤${CONFIG.hot.maxEnrichPerTick} JDs/tick, ` +
      `alerting at >=${CONFIG.notify.hotScore}%).`,
  );
  armNext();
}

/**
 * The NAUKRI HOT scheduler — same shape as startHotScheduler, its own lock so
 * a slow Naukri tick can never block (or be blocked by) the LinkedIn hot
 * checker or the wide sweep.
 */
function startNaukriHotScheduler(): void {
  const step = CONFIG.naukriHot.intervalMinutes;
  const win = CONFIG.naukriHot.activeWindow;

  const tick = async () => {
    const inWindow = !win || inWindowRange(win.start, win.end);
    if (inWindow && !naukriHotRunning) {
      naukriHotRunning = true;
      try {
        await runNaukriHotCheck({ log: (...a) => console.log(...a) });
      } catch (err) {
        console.error("[naukri-hot] tick threw:", err instanceof Error ? err.message : String(err));
      } finally {
        naukriHotRunning = false;
      }
    }
    armNext();
  };
  const armNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes((Math.floor(now.getMinutes() / step) + 1) * step, 40, 0);
    setTimeout(tick, Math.max(1000, next.getTime() - now.getTime()));
  };
  console.log(
    `[naukri-hot] fast checker armed every ${step} min (${win ? `${win.start}–${win.end}` : "24/7"}, ` +
      `${CONFIG.naukriHot.windowMinutes}m window, alerting at >=${CONFIG.notify.hotScore}%).`,
  );
  armNext();
}

/** Window check shared by both schedulers. */
function inWindowRange(start: string, end: string, at: Date = new Date()): boolean {
  const mins = at.getHours() * 60 + at.getMinutes();
  return mins >= toMinutes(start) && mins <= toMinutes(end);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  try {
    // ── Static page ──────────────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/") {
      // The page (markup + inline script) is baked into this process, so a
      // cached copy silently keeps running last restart's JS. Never cache it.
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, must-revalidate",
      });
      res.end(PAGE);
      return;
    }

    // ── CSV list ─────────────────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/runs") {
      json(res, 200, { runs: await listRuns() });
      return;
    }

    // ── Alert smoke test: `curl localhost:5173/api/notify-test` ──────────────
    // Banner + sound depend on macOS notification permissions that are granted
    // per-app and can be silently off, so there has to be a way to check the
    // wiring without waiting for a real 09:30–21:00 slot to land a new job.
    if (req.method === "GET" && url.pathname === "/api/notify-test") {
      await notify({
        title: "3 new jobs",
        subtitle: "job-tools · auto-collect",
        body: "20 shortlisted today · 3 new / 17 refreshed (test)",
      });
      json(res, 200, { ok: true, config: CONFIG.notify });
      return;
    }

    // ── CSV reader ───────────────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/csv") {
      const name = url.searchParams.get("name") ?? "";
      if (!/^[\w.-]+\.csv$/.test(name)) { json(res, 400, { error: "bad name" }); return; }
      let text: string;
      try { text = await readFile(join(OUTPUT_DIR, name), "utf8"); }
      catch { json(res, 404, { error: "not found" }); return; }
      const rows = parseCsv(text);
      json(res, 200, { header: rows[0] ?? [], rows: rows.slice(1) });
      return;
    }

    // ── Today's accumulated jobs (from Neon) ──────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/today") {
      const date = url.searchParams.get("date") || today();
      try {
        const [jobs, runs] = await Promise.all([getJobsForDate(date), getRunsForDate(date)]);
        json(res, 200, { date, jobs, runs, running });
      } catch (err) {
        json(res, 500, { error: `DB error: ${err instanceof Error ? err.message : String(err)}` });
      }
      return;
    }

    // ── Hot checker: recent ticks + live request-gate counters ────────────────
    // The gate counters are the safety instrument: `blocked` climbing (or a
    // non-zero cooldown) is LinkedIn pushing back, which is the only honest way
    // to learn the rate ceiling — probing for it is how you get blocked.
    if (req.method === "GET" && url.pathname === "/api/hot") {
      json(res, 200, {
        enabled: CONFIG.hot.enabled,
        running: hotRunning,
        intervalMinutes: CONFIG.hot.intervalMinutes,
        windowMinutes: CONFIG.hot.windowMinutes,
        hotScore: CONFIG.notify.hotScore,
        activeWindow: CONFIG.hot.activeWindow,
        ticks: hotHistory(),
        gates: gateStats(),
      });
      return;
    }

    // ── Manual single hot tick (for testing the fast path on demand) ──────────
    if (req.method === "POST" && url.pathname === "/api/hot/run") {
      if (hotRunning) { json(res, 409, { error: "A hot tick is already in progress." }); return; }
      hotRunning = true;
      try {
        json(res, 200, await runHotCheck({ log: (...a) => console.log(...a) }));
      } finally {
        hotRunning = false;
      }
      return;
    }

    // ── Naukri hot checker: recent ticks + live request-gate counters ─────────
    if (req.method === "GET" && url.pathname === "/api/naukri-hot") {
      json(res, 200, {
        enabled: CONFIG.naukriHot.enabled,
        running: naukriHotRunning,
        intervalMinutes: CONFIG.naukriHot.intervalMinutes,
        windowMinutes: CONFIG.naukriHot.windowMinutes,
        hotScore: CONFIG.notify.hotScore,
        activeWindow: CONFIG.naukriHot.activeWindow,
        ticks: naukriHotHistory(),
        gates: gateStats(),
      });
      return;
    }

    // ── Manual single Naukri hot tick (for testing the fast path on demand) ───
    if (req.method === "POST" && url.pathname === "/api/naukri-hot/run") {
      if (naukriHotRunning) { json(res, 409, { error: "A Naukri hot tick is already in progress." }); return; }
      naukriHotRunning = true;
      try {
        json(res, 200, await runNaukriHotCheck({ log: (...a) => console.log(...a) }));
      } finally {
        naukriHotRunning = false;
      }
      return;
    }

    // ── Company ATS boards: registry status + this tick's rotation ────────────
    if (req.method === "GET" && url.pathname === "/api/ats") {
      try {
        const reg = loadRegistry();
        const byAts: Record<string, number> = {};
        let neverPolled = 0;
        let dead = 0;
        for (const c of reg.companies) {
          byAts[c.ats] = (byAts[c.ats] ?? 0) + 1;
          if (!c.lastPolledAt) neverPolled++;
          if ((c.failures ?? 0) >= 3) dead++;
        }
        const due = dueCompanies(reg).length;
        json(res, 200, {
          total: reg.companies.length,
          byAts, neverPolled, dead, due,
          running: atsRunning,
          updatedAt: reg.updatedAt,
          autoPoll: CONFIG.ats.poll.enabled,
          intervalMinutes: CONFIG.ats.poll.intervalMinutes,
          refreshMinutes: CONFIG.ats.poll.refreshMinutes,
          maxBoardsPerTick: CONFIG.ats.poll.maxBoardsPerTick,
        });
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // ── Manual "poll all boards now" (SSE streamed) ───────────────────────────
    if (req.method === "POST" && url.pathname === "/api/ats/poll") {
      if (atsRunning) { json(res, 409, { error: "An ATS poll is already in progress." }); return; }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const sse = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

      atsRunning = true;
      // `all: true` ignores the rotation clock — the button means "everything, now".
      runAtsCollection({ all: true, log: (...a) => sse({ type: "log", text: a.join(" ") }) })
        .then((r) => sse({ type: "result", ...r }))
        .catch((err) => sse({ type: "error", text: err instanceof Error ? err.message : String(err) }))
        .finally(() => { atsRunning = false; res.end(); });
      return;
    }

    // ── Manual "run all cities now" (SSE streamed) ────────────────────────────
    if (req.method === "POST" && url.pathname === "/api/collect") {
      if (running) { json(res, 409, { error: "A run is already in progress." }); return; }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const sse = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

      running = true;
      runCollection({ trigger: "manual", log: (...a) => sse({ type: "log", text: a.join(" ") }) })
        .then((r) => sse({ type: "result", ...r }))
        .catch((err) => sse({ type: "error", text: err instanceof Error ? err.message : String(err) }))
        .finally(() => { running = false; res.end(); });
      return;
    }

    // ── Quick search (SSE streamed) ───────────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/api/search") {
      if (running) { json(res, 409, { error: "A run is already in progress." }); return; }

      let params: { source?: string; city?: string; hours?: number; pages?: number; maxApplicants?: number; terms?: string } = {};
      try { params = JSON.parse(await readBody(req)); } catch { /* use defaults */ }

      const source        = params.source === "naukri" ? "naukri" : "linkedin";
      const city          = String(params.city  ?? "Bengaluru");
      const hours         = Math.max(1, Number(params.hours ?? 15));
      const pages         = Math.max(1, Math.min(10, Number(params.pages ?? 3)));
      const maxApplicants = params.maxApplicants ? Math.max(1, Number(params.maxApplicants)) : null;
      // Blank → src/search.ts falls back to its hardcoded per-source term lists.
      const terms         = String(params.terms ?? "").trim();

      // SSE response — client reads this as a stream via fetch().body
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const sse = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

      running = true;
      const spawnArgs = ["tsx", "src/search.ts", "--source", source, "--city", city, "--hours", String(hours), "--pages", String(pages)];
      // Naukri never exposes an applicant count, so the filter has no meaning there.
      if (maxApplicants && source === "linkedin") spawnArgs.push("--maxApplicants", String(maxApplicants));
      if (terms) spawnArgs.push("--terms", terms);
      const child = spawn("npx", spawnArgs, { cwd: resolve("."), env: process.env });

      let stdout = "";
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on("data", (d: Buffer) => {
        for (const line of d.toString().split("\n").filter(Boolean))
          sse({ type: "log", text: line });
      });
      child.on("close", (code) => {
        running = false;
        try {
          const result = JSON.parse(stdout.trim());
          sse({ type: "result", ...result });
        } catch {
          sse({ type: "error", text: `Search exited ${code} with no parseable output.` });
        }
        res.end();
      });
      child.on("error", (err) => {
        running = false;
        sse({ type: "error", text: String(err) });
        res.end();
      });
      return;
    }

    res.writeHead(404); res.end("Not found");
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
});

server.listen(PORT, async () => {
  console.log(`\njob-tools dashboard → http://localhost:${PORT}\n(Ctrl-C to stop)`);
  try {
    await initSchema();
    console.log("[db] schema ready.");
    startScheduler();
    // Gated on poll.enabled, not discovery.enabled: discovery is the SERP
    // harvest that finds boards, polling is the timer that reads them.
    if (CONFIG.ats.poll.enabled) startAtsScheduler();
    else console.log("[ats] auto-poll DISABLED (config.ats.poll.enabled = false). Run `npm run ats` to poll manually.");
    if (CONFIG.hot.enabled) startHotScheduler();
    else console.log("[hot] fast checker DISABLED (config.hot.enabled = false).");
    if (CONFIG.naukriHot.enabled) startNaukriHotScheduler();
    else console.log("[naukri-hot] fast checker DISABLED (config.naukriHot.enabled = false).");
  } catch (err) {
    console.error(
      "[db] could NOT connect to Neon — 'Today' view and the hourly collector are disabled.\n" +
        "     Check DATABASE_URL in .env (dashboard must run with --env-file=.env).\n" +
        `     ${err instanceof Error ? err.message : err}`,
    );
  }
});

// ── HTML page ─────────────────────────────────────────────────────────────────
const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>job-tools dashboard</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  pre { font-family: 'Menlo','Monaco','Consolas',monospace; }
</style>
</head>
<body class="bg-slate-50 text-slate-800 text-sm">
<div class="max-w-[1800px] mx-auto p-6">

  <!-- The scheduler/run status describes the whole page, so it belongs in the
       header — it used to sit between the facet bar and the table, splitting
       the one thing you actually read (filters → rows) down the middle. -->
  <header class="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
    <h1 class="text-2xl font-semibold">job-tools</h1>
    <span class="text-slate-400">dashboard</span>
    <div id="todayRuns" class="ml-auto flex flex-wrap items-center gap-2 text-xs text-slate-500"></div>
  </header>

  <!-- ══════════════════════════════════════════════════════════════════════
       TODAY — accumulated from Neon, and the reason this page exists, so it is
       first and it is the only thing open by default. Every auto-collect and
       every manual "Run all cities now" upserts into the same day's set, so it
       persists across refreshes and grows through the day.
       ══════════════════════════════════════════════════════════════════════ -->
  <section class="bg-white rounded-xl border border-slate-200 p-5 mb-6">
    <div class="flex flex-wrap items-center gap-3 mb-4">
      <h2 class="font-semibold">Today's jobs</h2>
      <span id="todayCount" class="text-slate-400 text-xs"></span>
      <input id="todayFilter" placeholder="Filter title / company…" oninput="renderToday()"
        class="ml-auto text-sm border border-slate-200 rounded-lg px-3 py-1.5 w-56 focus:outline-none focus:border-slate-400" />
      <button id="collectBtn" onclick="runCollect()"
        class="px-4 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-500 disabled:opacity-40 transition-all text-sm">
        Run all cities now
      </button>
    </div>

    <!-- ── Facet bar. A day accumulates ~1,300 jobs across every city + remote
         in one list, which is unreadable; these four axes (posted / found /
         where / source) cut it to something you can actually scan. All are
         view-only — nothing is refetched, and nothing leaves the accumulated
         day.

         POSTED vs FOUND are different questions and the difference is the whole
         point of the top row. "Found" is when OUR poller first saw the row, so
         a company-board req that has been open since 2022 reads as brand new
         the first time a tick reaches its board — which is exactly why the day
         looked fresh and wasn't. "Posted" is the posting's own date. ──────── -->
    <div class="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 mb-4 space-y-2.5">
      <div class="flex flex-wrap items-center gap-2">
        <span class="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Posted</span>
        <div id="postedChips" class="flex flex-wrap gap-1.5"></div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <span class="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Found</span>
        <div id="timeChips" class="flex flex-wrap gap-1.5"></div>
      </div>
      <div class="flex flex-wrap items-start gap-2">
        <span class="w-16 shrink-0 mt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Where</span>
        <div id="cityChips" class="flex flex-wrap gap-1.5"></div>
      </div>
      <!-- Non-India locations, folded away behind the "+N abroad" chip above.
           They are a long tail of one-offs from global ATS boards; inline they
           were 30 of the 40 chips in this row. -->
      <div id="abroadChips" class="hidden flex-wrap gap-1.5 pl-[4.5rem]"></div>
      <div class="flex flex-wrap items-center gap-2">
        <span class="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Source</span>
        <div id="sourceChips" class="flex flex-wrap gap-1.5"></div>
        <label class="ml-auto flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
          <input id="groupByCity" type="checkbox" onchange="renderToday()" class="accent-slate-700" />
          Group by city
        </label>
      </div>
    </div>

    <!-- Manual-collect progress log -->
    <pre id="collectLog"
      class="hidden mb-3 max-h-40 overflow-auto bg-slate-900 text-slate-100 text-xs rounded-xl p-3 whitespace-pre-wrap leading-relaxed"></pre>

    <p id="todayEmpty" class="text-slate-400 py-6 text-center text-sm">
      No jobs collected yet today — click “Run all cities now”, or wait for the next scheduled run.
    </p>
    <div class="max-h-[70vh] overflow-auto rounded-lg border border-slate-100">
      <table id="todayTable" class="hidden w-full text-sm">
        <thead><tr id="todayThead" class="text-left text-slate-500 bg-white sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0]"></tr></thead>
        <tbody id="todayTbody"></tbody>
      </table>
    </div>
    <div>
      <!-- Nothing is filtered out of the collection any more; weak jobs are
           ranked to the bottom and folded away behind this. -->
      <button id="todayShowLow" onclick="toggleLowRanked()"
              class="hidden mt-3 text-xs text-slate-500 hover:text-slate-800 underline"></button>
    </div>
  </section>

  <!-- ══════════════════════════════════════════════════════════════════════
       COMPANY BOARDS — the ATS half. A separate section (and a separate
       scheduler) because it answers a different question: not "what reached a
       job board in the last 2 hours" but "which of the companies we know about
       have something open right now". Its jobs land in the same Neon table
       tagged source=greenhouse|lever|ashby|workday, so they are already in the
       list above — this panel is only the registry's health + controls, which
       is why it is collapsed rather than sitting on top of the day's jobs.
       ══════════════════════════════════════════════════════════════════════ -->
  <details class="group bg-white rounded-xl border border-slate-200 mb-3">
    <summary class="flex flex-wrap items-center gap-3 p-4 cursor-pointer select-none list-none">
      <span class="text-slate-400 transition-transform group-open:rotate-90">&#9654;</span>
      <h2 class="font-semibold">Company boards</h2>
      <span id="atsCount" class="text-slate-400 text-xs"></span>
      <span class="ml-auto text-xs text-slate-400">Greenhouse · Lever · Ashby · Workday</span>
    </summary>
    <div class="px-5 pb-5">
      <div class="flex flex-wrap items-center gap-3 mb-3">
        <div id="atsStats" class="flex flex-wrap gap-2 text-xs text-slate-500"></div>
        <button id="atsBtn" onclick="runAtsPoll()"
          class="ml-auto px-4 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-500 disabled:opacity-40 transition-all text-sm">
          Poll all boards now
        </button>
      </div>
      <pre id="atsLog"
        class="hidden mb-3 max-h-40 overflow-auto bg-slate-900 text-slate-100 text-xs rounded-xl p-3 whitespace-pre-wrap leading-relaxed"></pre>
      <p class="text-xs text-slate-400 leading-relaxed">
        Boards discovered by <code>npm run discover</code>. A closed job disappears from these
        APIs, so everything here is live by construction — which is why there is no freshness
        window on this source.
      </p>
    </div>
  </details>

  <!-- ══════════════════════════════════════════════════════════════════════
       QUICK SEARCH — an on-demand, one-city query that does NOT write to the
       day's set. Collapsed: the scheduled collector is what fills this page,
       and this is the thing you reach for a few times a week.
       ══════════════════════════════════════════════════════════════════════ -->
  <details id="pane-search" class="group bg-white rounded-xl border border-slate-200 mb-3">
    <summary class="flex flex-wrap items-center gap-3 p-4 cursor-pointer select-none list-none">
      <span class="text-slate-400 transition-transform group-open:rotate-90">&#9654;</span>
      <h2 class="font-semibold">Quick search</h2>
      <span class="text-slate-400 text-xs">one city, on demand — not saved to today's set</span>
    </summary>
    <div class="px-5 pb-5">

    <!-- Search controls -->
    <section class="mb-4">

      <!-- Search terms — blank falls back to the hardcoded term lists -->
      <div class="mb-4">
        <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
          Search terms
          <span class="normal-case font-normal text-slate-400">— comma-separated; blank = default term list</span>
        </label>
        <input id="termsInput" placeholder="e.g. react, next.js — leave blank for Frontend Engineer / Developer / …"
          onkeydown="if (event.key === 'Enter') runSearch('linkedin')"
          class="w-full text-sm border border-slate-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-slate-400" />
      </div>

      <!-- City -->
      <div class="mb-4">
        <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">City</label>
        <div class="flex flex-wrap gap-2 mb-2">
          ${["Bengaluru","Hyderabad","Pune","Mumbai","Delhi","Chennai","Remote"].map(c =>
            `<button data-city="${c}" onclick="setCity('${c}')"
              class="city-btn px-3 py-1 rounded-lg border border-slate-200 bg-white hover:border-slate-400 text-sm transition-all">${c}</button>`
          ).join("")}
        </div>
        <input id="cityInput" value="Bengaluru" placeholder="or type any city…"
          oninput="qCity=this.value"
          class="w-full text-sm border border-slate-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-slate-400" />
      </div>

      <!-- Time window -->
      <div class="mb-4">
        <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Time window</label>
        <div class="flex gap-2">
          ${[1,2,6,15,24].map(h =>
            `<button data-hours="${h}" onclick="setHours(${h})"
              class="hour-btn px-3 py-1 rounded-lg border border-slate-200 bg-white hover:border-slate-400 text-sm transition-all">${h}h</button>`
          ).join("")}
        </div>
      </div>

      <!-- Pages + applicants + search button -->
      <div class="flex items-center gap-4 flex-wrap">
        <div>
          <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Pages / keyword</label>
          <select id="pagesSelect" class="text-sm border border-slate-200 rounded-lg px-2 py-1.5">
            <option value="2">2  (~60 cards)</option>
            <option value="3" selected>3  (~90 cards)</option>
            <option value="5">5  (~150 cards)</option>
          </select>
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
            Under X applicants <span class="normal-case font-normal text-slate-400">(LinkedIn only)</span>
          </label>
          <input id="maxApplicantsInput" type="number" min="1" placeholder="any"
            class="w-24 text-sm border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:border-slate-400" />
        </div>
        <button id="searchBtn" onclick="runSearch('linkedin')"
          class="mt-5 px-5 py-2 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-500 disabled:opacity-40 transition-all">
          Search LinkedIn
        </button>
        <button id="searchNaukriBtn" onclick="runSearch('naukri')"
          class="mt-5 px-5 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-500 disabled:opacity-40 transition-all">
          Search Naukri
        </button>
        <span id="searchStatus" class="mt-5 text-slate-400 text-xs"></span>
      </div>
    </section>

    <!-- Progress log -->
    <pre id="searchLog"
      class="hidden mb-4 max-h-52 overflow-auto bg-slate-900 text-slate-100 text-xs rounded-xl p-4 whitespace-pre-wrap leading-relaxed"></pre>

    <!-- Stats bar -->
    <div id="searchStats" class="hidden mb-3 flex flex-wrap gap-4 text-xs text-slate-500 px-1"></div>

    <!-- Results -->
    <section id="searchResultsWrap" class="hidden rounded-xl border border-slate-200 p-5">
      <div class="flex items-center gap-3 mb-3">
        <h2 class="font-semibold">Results</h2>
        <input id="searchFilter" placeholder="Filter title / company…" oninput="renderSearchResults()"
          class="ml-auto text-sm border border-slate-200 rounded-lg px-2 py-1 w-56" />
      </div>
      <p id="searchEmpty" class="hidden text-slate-400 py-4 text-center">No matching jobs after filters.</p>
      <div>
        <table id="searchTable" class="hidden w-full text-sm">
          <thead><tr id="searchThead" class="text-left text-slate-500 border-b border-slate-200"></tr></thead>
          <tbody id="searchTbody"></tbody>
        </table>
      </div>
    </section>

    </div>
  </details><!-- /pane-search -->

  <!-- ══════════════════════════════════════════════════════════════════════
       PAST SEARCHES — every search writes a CSV to output/; this browses them.
       ══════════════════════════════════════════════════════════════════════ 
  <section class="mt-6 bg-white rounded-xl border border-slate-200 p-5">
    <div class="flex flex-wrap items-center gap-3 mb-3">
      <h2 class="font-semibold text-sm">Past searches</h2>
      <select id="runSelect" class="text-sm border border-slate-300 rounded-lg px-2 py-1"></select>
      <input id="filter" placeholder="Filter title / company…" class="text-sm border border-slate-300 rounded-lg px-2 py-1 ml-auto w-56" />
    </div>
    <div id="empty" class="text-sm text-slate-400 py-8 text-center">No saved searches yet — run one above.</div>
    <div>
      <table id="table" class="hidden w-full text-sm">
        <thead><tr id="thead" class="text-left text-slate-500 border-b border-slate-200"></tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
  </section> -->

</div><!-- /container -->

<script>
// Injected from config so the schedule badge can never drift from what the
// scheduler actually does (it did: the badge said "10am–7pm hourly" for months
// after the config moved to 09:30–21:00 every 30 min).
const SCHEDULE = ${JSON.stringify({
  start: CONFIG.collect.activeWindow.start,
  end: CONFIG.collect.activeWindow.end,
  every: CONFIG.collect.intervalMinutes,
  hot: CONFIG.hot.enabled ? { every: CONFIG.hot.intervalMinutes, at: CONFIG.notify.hotScore } : null,
})};
// The SAME table the ATS collector gates on (src/sources/ats.ts), injected
// rather than retyped so the "abroad" chip can never disagree with what the
// collector actually keeps. Only legacy rows reach it now — the collector stopped
// admitting foreign-only remote roles — but the day already in Neon still has them.
const FOREIGN_TOKENS = ${JSON.stringify(FOREIGN_TOKENS)};
const $ = (id) => document.getElementById(id);

// ── Quick search state ────────────────────────────────────────────────────────
let qCity = "Bengaluru", qHours = 15;
let searchJobs = [];

function setCity(c) {
  qCity = c;
  $("cityInput").value = c;
  document.querySelectorAll(".city-btn").forEach(b => {
    const active = b.dataset.city === c;
    b.classList.toggle("bg-blue-600",  active);
    b.classList.toggle("text-white",   active);
    b.classList.toggle("border-blue-600", active);
    b.classList.toggle("bg-white",    !active);
  });
}

function setHours(h) {
  qHours = h;
  document.querySelectorAll(".hour-btn").forEach(b => {
    const active = Number(b.dataset.hours) === h;
    b.classList.toggle("bg-slate-900", active);
    b.classList.toggle("text-white",   active);
    b.classList.toggle("border-slate-900", active);
    b.classList.toggle("bg-white",    !active);
  });
}

// Initialise defaults
setCity("Bengaluru");
setHours(15);

// ── Run search ────────────────────────────────────────────────────────────────
async function runSearch(source) {
  const btns = [$("searchBtn"), $("searchNaukriBtn")];
  if (btns.some(b => b.disabled)) return;
  const city  = $("cityInput").value.trim() || qCity;
  const hours = qHours;
  const pages = parseInt($("pagesSelect").value);
  const maxApplicantsRaw = parseInt($("maxApplicantsInput").value);
  const maxApplicants = isNaN(maxApplicantsRaw) ? null : maxApplicantsRaw;
  const terms = $("termsInput").value.trim();

  btns.forEach(b => b.disabled = true);
  $("searchStatus").textContent = "Searching " + (source === "naukri" ? "Naukri" : "LinkedIn") + "…";
  $("searchLog").classList.remove("hidden");
  $("searchLog").textContent = "Starting…";
  $("searchStats").classList.add("hidden");
  $("searchStats").textContent = "";
  $("searchResultsWrap").classList.add("hidden");
  $("searchTable").classList.add("hidden");
  $("searchEmpty").classList.add("hidden");
  searchJobs = [];

  try {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, city, hours, pages, ...(maxApplicants ? { maxApplicants } : {}), ...(terms ? { terms } : {}) }),
    });

    if (res.status === 409) {
      $("searchStatus").textContent = "Another run in progress — try again shortly.";
      return;
    }

    const reader = res.body.getReader();
    const dec    = new TextDecoder();
    let buf = "", resultData = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const chunks = buf.split("\\n\\n");
      buf = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const line = chunk.replace(/^data: /, "").trim();
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "log") {
            $("searchLog").textContent += "\\n" + msg.text;
            $("searchLog").scrollTop = $("searchLog").scrollHeight;
          } else if (msg.type === "result") {
            resultData = msg;
          } else if (msg.type === "error") {
            $("searchLog").textContent += "\\nERROR: " + msg.text;
          }
        } catch {}
      }
    }

    if (resultData) {
      searchJobs = resultData.jobs ?? [];
      const s = resultData.stats ?? {};
      $("searchStats").classList.remove("hidden");
      $("searchStats").innerHTML =
        stat("bg-slate-100", s.final + " results") +
        stat("bg-blue-50 text-blue-700", s.fetched + " fetched") +
        stat("bg-emerald-50 text-emerald-700", s.prefiltered + " prefiltered") +
        stat("bg-rose-50 text-rose-700",  s.prefilterDropped + " dropped") +
        stat("bg-purple-50 text-purple-700", s.enriched + " enriched");
      $("searchResultsWrap").classList.remove("hidden");
      renderSearchResults();
      $("searchStatus").textContent = "Done.";
      await loadRuns(); // the search just wrote a CSV — surface it below
    }
  } catch (e) {
    $("searchLog").textContent += "\\nFailed: " + e;
    $("searchStatus").textContent = "Error.";
  } finally {
    btns.forEach(b => b.disabled = false);
  }
}

function stat(cls, text) {
  return '<span class="px-2 py-0.5 rounded-full text-xs font-medium ' + cls + '">' + text + '</span>';
}

// ── Render search results table ───────────────────────────────────────────────
function renderSearchResults() {
  const q = ($("searchFilter").value || "").toLowerCase();
  const jobs = searchJobs.filter(j =>
    !q || j.title.toLowerCase().includes(q) || j.company.toLowerCase().includes(q)
  );

  if (!jobs.length) {
    $("searchTable").classList.add("hidden");
    $("searchEmpty").classList.remove("hidden");
    return;
  }
  $("searchEmpty").classList.add("hidden");
  $("searchTable").classList.remove("hidden");

  $("searchThead").innerHTML = [
    "KW score", "TF-IDF", "Title", "Company", "Location", "Exp", "Market salary", "Applicants", "Seniority", "Apply", "HR contact"
  ].map(h => '<th class="py-2 pr-5 font-medium whitespace-nowrap">' + h + '</th>').join("");

  const tbody = $("searchTbody");
  tbody.innerHTML = "";
  for (const j of jobs) {
    const tfidf = j.tfidfScore !== undefined
      ? '<span class="tabular-nums text-slate-500">' + (j.tfidfScore * 100).toFixed(1) + '%</span>'
      : '<span class="text-slate-300">—</span>';
    const sen = j.seniority === "stretch"
      ? '<span class="text-amber-600">stretch</span>'
      : j.seniority === "favored"
        ? '<span class="text-emerald-600">favored</span>'
        : '<span class="text-slate-400">—</span>';
    const apply = j.applyType === "easy_apply"
      ? '<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">Easy Apply</span>'
      : j.applyType === "external"
        ? '<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600">Company Site</span>'
        : '<span class="text-slate-300">—</span>';
    const hr = j.hrName
      ? (j.hrProfileUrl
          ? '<a class="text-blue-600 hover:underline" target="_blank" href="' + escHtml(j.hrProfileUrl) + '">' + escHtml(j.hrName) + '</a>'
          : escHtml(j.hrName))
      : '<span class="text-slate-300">—</span>';
    // Market band = what people REPORT earning at (company, role) — not this
    // posting's pay. Prefer the bucket for this posting's own experience: the
    // headline blends every level together and reads high for a mid role.
    const b = j.salaryBand;
    // A ladder band answers "what does this LEVEL earn here", not "what does
    // this job pay" — it must look different at a glance, never like a title hit.
    // (No backticks in this block: it lives inside a template literal.)
    const mkt = b
      ? '<span class="tabular-nums ' + (b.matchType === "ladder" ? "text-slate-400 italic" : "") + '" title="' + escHtml(
          b.matchType + " match (" + b.matchQuality + ") → " + b.profile +
          (b.atExp ? " @ " + b.atExp.label + " yrs (n=" + b.atExp.n + ")" : " @ " + b.expRange + " yrs (n=" + b.dataPoints + ")") +
          (b.matchType === "ladder" ? " — generic rung for this level, not this role" : "")
        ) + '">' + (b.atExp ? b.atExp.minLpa + "–" + b.atExp.maxLpa : b.minLpa + "–" + b.maxLpa) +
        (b.matchType === "title" ? "" : '<span class="text-slate-400 text-xs"> ' + escHtml(b.matchType === "ladder" ? "≈lvl" : "≈") + '</span>') + '</span>'
      : '<span class="text-slate-300" title="No AmbitionBox band for this title">—</span>';
    const tr = document.createElement("tr");
    tr.className = "border-b border-slate-100 hover:bg-slate-50";
    tr.innerHTML =
      '<td class="py-2 pr-5"><span class="font-semibold tabular-nums">' + j.score + '%</span></td>' +
      '<td class="py-2 pr-5">' + tfidf + '</td>' +
      '<td class="py-2 pr-5 max-w-xs"><a class="text-blue-600 hover:underline line-clamp-1" target="_blank" href="' + escHtml(j.url) + '" data-jd="' + encodeURIComponent(j.description || "") + '">' + escHtml(j.title) + '</a></td>' +
      '<td class="py-2 pr-5 text-slate-600 whitespace-nowrap">' + escHtml(j.company) + '</td>' +
      '<td class="py-2 pr-5 text-slate-400 text-xs whitespace-nowrap">' + escHtml(j.location || "") + '</td>' +
      '<td class="py-2 pr-5 text-slate-400 text-xs whitespace-nowrap">' + escHtml(j.experience || "") + '</td>' +
      '<td class="py-2 pr-5 text-xs whitespace-nowrap">' + mkt + '</td>' +
      '<td class="py-2 pr-5 text-xs whitespace-nowrap">' + escHtml(j.applicants || "—") + '</td>' +
      '<td class="py-2 pr-5 text-xs">' + sen + '</td>' +
      '<td class="py-2 pr-5 text-xs whitespace-nowrap">' + apply + '</td>' +
      '<td class="py-2 pr-5 text-xs whitespace-nowrap">' + hr + '</td>';
    tbody.appendChild(tr);
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Past searches (CSV browser) ───────────────────────────────────────────────
let current = { header: [], rows: [] };
// Column allowlist for the CSV table. Anything writeCsv emits but this omits is
// invisible in the UI even though it IS in the file — check here first when a
// column you know you computed doesn't show up.
// NOTE: salary_lpa is the POSTING's own disclosed pay; market_salary_* is the
// AmbitionBox band for (company, role). Different things — don't conflate them.
const SHOW  = ["score","tfidf_sim","title","company","experience","salary_lpa","market_salary_lpa","market_salary_match","market_salary_at_exp","apply_type","hr_name","seniority","remote","location","source","posted_at"];

async function loadRuns() {
  const sel = $("runSelect");
  if (!sel) return;   // "Past searches" section is commented out — nothing to fill.
  const r   = await fetch("/api/runs").then((x) => x.json());
  sel.innerHTML = "";
  if (!r.runs.length) { $("empty").classList.remove("hidden"); $("table").classList.add("hidden"); return; }
  for (const run of r.runs) {
    const o = document.createElement("option");
    o.value = run.name;
    o.textContent = run.name + "  (" + run.rows + " jobs)";
    sel.appendChild(o);
  }
  await loadCsv(r.runs[0].name);
}

async function loadCsv(name) {
  current = await fetch("/api/csv?name=" + encodeURIComponent(name)).then((x) => x.json());
  renderCsv();
}

function cell(header, row, key) {
  const i = header.indexOf(key);
  return i === -1 ? "" : (row[i] ?? "");
}

function renderCsv() {
  const { header, rows } = current;
  $("empty").classList.add("hidden");
  $("table").classList.remove("hidden");
  const cols = SHOW.filter((c) => header.includes(c));
  $("thead").innerHTML = cols.map((c) => '<th class="py-2 pr-4 font-medium">' + c + "</th>").join("");
  const q = $("filter").value.trim().toLowerCase();
  const tbody = $("tbody");
  tbody.innerHTML = "";
  for (const row of rows) {
    const title   = cell(header, row, "title").toLowerCase();
    const company = cell(header, row, "company").toLowerCase();
    if (q && !title.includes(q) && !company.includes(q)) continue;
    const tr = document.createElement("tr");
    tr.className = "border-b border-slate-100 hover:bg-slate-50";
    const url = cell(header, row, "url");
    tr.innerHTML = cols.map((c) => {
      let v = cell(header, row, c);
      if (c === "score")     return '<td class="py-2 pr-4 font-semibold tabular-nums">' + v + "%</td>";
      if (c === "tfidf_sim") return '<td class="py-2 pr-4 tabular-nums text-slate-500">' + (v ? v + "%" : "—") + "</td>";
      if (c === "title" && url) return '<td class="py-2 pr-4"><a class="text-blue-600 hover:underline" target="_blank" href="' + url + '">' + v + "</a></td>";
      if (c === "apply_type" && v) {
        const cls = v === "Easy Apply" ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600";
        return '<td class="py-2 pr-4"><span class="px-2 py-0.5 rounded-full text-xs font-medium ' + cls + '">' + v + "</span></td>";
      }
      if (c === "hr_name" && v) {
        const hrUrl = cell(header, row, "hr_profile_url");
        return '<td class="py-2 pr-4">' + (hrUrl ? '<a class="text-blue-600 hover:underline" target="_blank" href="' + hrUrl + '">' + v + "</a>" : v) + "</td>";
      }
      return '<td class="py-2 pr-4 text-slate-600">' + v + "</td>";
    }).join("");
    tbody.appendChild(tr);
  }
}

// The "Past searches" section is currently commented out of the markup, so
// none of its elements exist. Binding to them threw a TypeError here, which
// aborted the rest of this script — including loadToday() below, leaving the
// Today section frozen on its static "No jobs collected yet" placeholder.
// Guard every lookup so a disabled section can never take the page down.
if ($("runSelect")) {
  $("runSelect").onchange = (e) => loadCsv(e.target.value);
  $("filter").oninput = renderCsv;
  loadRuns();
}
$("searchFilter").oninput = renderSearchResults;

// ── Today (DB-backed, persists across refresh) ─────────────────────────────────
let todayJobs = [];
let todayRuns = [];       // this day's runs, newest first (from /api/today)
// null = never loaded successfully; a string = why the last load failed. Kept
// separate from "0 jobs" so a dead fetch never renders as "nothing collected".
let todayLoadError = "loading…";

function fmtTime(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch (e) { return ""; }
}

// Compact posting age: "3h", "2d", "5w", "14mo". Weeks rather than days past a
// fortnight because "posted 47d ago" is a number you have to do arithmetic on.
function fmtAge(hours) {
  if (hours < 1) return "now";
  if (hours < 48) return Math.round(hours) + "h";
  const d = hours / 24;
  if (d < 14) return Math.round(d) + "d";
  if (d < 60) return Math.round(d / 7) + "w";
  if (d < 730) return Math.round(d / 30) + "mo";
  return (d / 365).toFixed(1) + "y";
}

async function loadToday() {
  let data;
  // cache:"no-store" + a cache-buster: this polls every 60s and must never be
  // served a stale copy of an earlier, emptier point in the day.
  try { data = await fetch("/api/today?_=" + Date.now(), { cache: "no-store" }).then((x) => x.json()); }
  catch (e) {
    // Server restarted / offline. Say so instead of leaving the stale view —
    // otherwise a failed refresh is indistinguishable from an empty day.
    todayLoadError = "Can't reach the dashboard server — is it still running? (retrying every 60s)";
    renderToday();
    return;
  }
  if (data.error) {
    todayLoadError = data.error;
    $("todayRuns").innerHTML = '<span class="text-rose-500">' + escHtml(data.error) + '</span>';
    renderToday();
    return;
  }
  todayLoadError = null;
  todayJobs = data.jobs || [];
  todayRuns = data.runs || [];
  renderRunsStrip(todayRuns, data.running);
  renderToday();
}

// Fold line for Today's jobs — a display threshold, NOT a filter. Injected from
// CONFIG.filter.lowRankBelow so the server and the UI agree on one number.
const LOW_RANK = ${CONFIG.filter.lowRankBelow};
let showLowRanked = false;

function toggleLowRanked() { showLowRanked = !showLowRanked; renderToday(); }

// ── Facets ────────────────────────────────────────────────────────────────────
// The old single "All runs today" dropdown was the only way to narrow the day,
// and one run is ~100 jobs across every city + remote at once — too coarse to be
// a view. Four independent axes replace it. All of them are PURE VIEW state:
// todayJobs is never mutated, so clearing the facets always brings the day back.
let fPosted  = 24;           // "all" | max age in HOURS of the posting itself
let fTime    = "all";        // "all" | "run" (latest run) | hours as a number
let fCities  = new Set();    // empty = every city; "__remote__" is a pseudo-city
let fSources = new Set();    // empty = every source

// ── Where a job actually is ───────────────────────────────────────────────────
//
// LinkedIn rows carry a 'cities' array — the search cities they surfaced under, already
// canonical. ATS rows (greenhouse/lever/ashby/workday) carry only the board's
// own free text, and every board spells the same place differently:
// "Bangalore", "Bengaluru, Karnataka, India (Hybrid)", "IND - Chennai",
// "India | Pune", "India - Bengaluru; India - Gurugram". Chopping that at the
// first comma — which is what this used to do — turned ONE facet row into forty
// chips, most of them singletons naming the same nine cities.
//
// So: map free text onto one canonical label. City rules run before regional
// ones ("Gurugram, Haryana" is Gurugram, not "North India").
const CITY_RULES = [
  [/bengaluru|bangalore|bangaluru|\bblr\b|karnataka|mangaluru|bidar/i, "Bengaluru"],
  [/hyderabad|secunderabad|telangana|tirumalgiri/i,                   "Hyderabad"],
  [/pune|pimpri|hinjewadi|chinchwad/i,                                "Pune"],
  [/mumbai|bombay|navi mumbai|thane|worli/i,                          "Mumbai"],
  [/gurugram|gurgaon/i,                                               "Gurugram"],
  [/noida/i,                                                          "Noida"],
  [/delhi|\bncr\b/i,                                                  "Delhi"],
  [/chennai|perambur|tambaram|chengalpattu/i,                         "Chennai"],
  [/kolkata|calcutta|west bengal/i,                                   "Kolkata"],
  [/ahmedabad|gandhinagar|vadodara|surat|rajkot|vapi|palanpur|gujarat/i, "Gujarat"],
  [/kochi|kerala|trivandrum|thiruvananthapuram/i,                     "Kerala"],
  [/jaipur|udaipur|rajasthan|hindoli/i,                               "Rajasthan"],
  [/indore|bhopal|madhya pradesh/i,                                   "Madhya Pradesh"],
  [/chandigarh|mohali|ludhiana|punjab/i,                              "Punjab"],
  [/coimbatore|tiruchirappalli|trichy|madurai|paramathivelur|tamil nadu/i, "Tamil Nadu"],
  [/dehradun|lucknow|ghaziabad|faridabad|safipur|uttar pradesh|uttarakhand|haryana/i, "North India"],
];
const INDIA_RE = /\bind\b|india|bengaluru|bangalore|hyderabad|pune|mumbai|chennai|gurgaon|gurugram|noida|delhi|kolkata|ahmedabad|jaipur|indore|chandigarh|kochi|kerala|coimbatore|trivandrum|karnataka|telangana|maharashtra|tamil nadu|haryana|gujarat|punjab|rajasthan/i;

// Name a foreign location by the country/region it matched rather than by
// whatever preceded its first comma — otherwise "Remote - US", "US Remote",
// "Remote-US", "USA - Remote" and "United States, Remote" are five chips for
// one place. Only the leftovers fall back to the raw first segment.
const FOREIGN_ALIASES = [
  [/\\b(u\\.?s\\.?a?|united states|nyc)\\b/i, "United States"],
  [/\\b(u\\.?k\\.?|united kingdom|britain)\\b/i, "United Kingdom"],
  [/\\b(e\\.?u\\.?|europe|european|emea)\\b/i, "Europe"],
  [/\\b(latam|latin america)\\b/i, "Latin America"],
  [/\\b(north america|americas)\\b/i, "North America"],
  [/\\b(south america)\\b/i, "South America"],
];
function abroadLabel(raw) {
  const s = String(raw);
  for (const [re, label] of FOREIGN_ALIASES) if (re.test(s)) return label;
  const hit = FOREIGN_TOKENS.find((t) => s.toLowerCase().includes(t));
  if (hit) return hit.replace(/\\b\\w/g, (c) => c.toUpperCase());
  const first = s.split(/[,;|]/)[0]
    .replace(/\\(.*?\\)/g, "").replace(/\\s*[-–]\\s*remote.*$/i, "").trim();
  return (first || "Abroad").slice(0, 24);
}

const FOREIGN_CODE_RE = /\\b(u\\.?s\\.?a?|u\\.?k\\.?|e\\.?u\\.?|nyc|latam|emea|apac)\\b/i;
function isForeign(s) {
  const l = s.toLowerCase();
  return FOREIGN_TOKENS.some((t) => l.includes(t)) || FOREIGN_CODE_RE.test(s);
}

// → { label, abroad }, or null when the string resolves to plain "remote" —
// those belong to the Remote chip and nowhere else. Order matters: a named city
// beats everything, then "Remote (India)" / "India - Remote" must read as
// Remote (they were landing in an "India (other)" bucket bigger than Bengaluru),
// then a foreign place beats a bare remote token, and only an unqualified
// "Remote" / "Anywhere" / "Remote - Global" survives as reachable-from-India.
function canonPlace(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  for (const [re, label] of CITY_RULES) if (re.test(s)) return { label, abroad: false };
  if (INDIA_RE.test(s)) return REMOTE_RE.test(s) ? null : { label: "India (other)", abroad: false };
  if (isForeign(s)) return { label: abroadLabel(s), abroad: true };
  if (REMOTE_RE.test(s)) return null;
  return { label: abroadLabel(s), abroad: true };
}

// Search labels that name no place in particular. The cities array records the
// SEARCH a card surfaced under, and the national "India" sweep (see config)
// matches everything from Kolkata to Bengaluru — so keeping it would do two kinds
// of damage: a Bengaluru job found under both searches picks up a spurious
// second chip, and a job found ONLY nationally is labelled "India (other)" even
// though its own location text says Kolkata. Dropping it lets the fallback below
// use the posting's own text, which is the more specific answer anyway.
const VAGUE_SEARCH_LABELS = new Set(["India"]);

/** Canonical place labels for a job (a posting can legitimately have several). */
function jobCities(j) {
  // The posting's OWN location text is always in the mix, not just a fallback
  // when the search labels resolve to nothing: a job the "Remote (India)" sweep
  // surfaced used to end up with NO place chip at all (that label folds to
  // pure-remote), which is how a batch of Türkiye/Brazil/Munich rows escaped the
  // abroad row entirely. Duplicates collapse into the Set below.
  const raw = [...(j.cities || []), j.location]
    .filter(Boolean).filter((c) => !VAGUE_SEARCH_LABELS.has(String(c)));
  const seen = new Set();
  for (const r of raw) {
    const p = canonPlace(r);
    if (p) seen.add(p.label);
  }
  return [...seen];
}
// Judged on the posting's OWN location text, NEVER on the 'cities' array.
//
// 'cities' records which SEARCH found the job, and one of those searches is
// literally named "Remote (India)" — canonPlace folds that to pure-remote, so
// the old every() test could not return true for ANYTHING the remote sweep
// surfaced, whatever the posting itself said. That is how İzmir, Brazil, Munich
// and Blacksburg VA sat at the top of the list at 92% instead of behind the
// "+N abroad" chip (2026-08-20). src/geo.ts now stops those at collection time;
// this is the backstop that also fixes the rows already in the DB, and catches
// the next leak LinkedIn invents.
function jobIsAbroad(j) {
  const p = canonPlace(String(j.location || ""));
  return p ? p.abroad : false;     // pure-remote counts as reachable, not abroad
}
// "Remote" arrives three ways — the row's own flag, a location string, and the
// search city it was found under (CONFIG names that one "Remote (India)"). All
// three mean the same thing to a reader, so they fold into one chip; without
// this the day splits into a "Remote" chip and a near-duplicate "Remote (India)"
// city chip that overlap.
const REMOTE_RE = /remote|work from home|wfh|anywhere|distributed/i;
function isRemote(j) {
  return j.remote === true || REMOTE_RE.test(String(j.location || "")) ||
    (j.cities || []).some((c) => REMOTE_RE.test(String(c)));
}

// Cutoff for the "When" axis. "run" = the newest run's start, i.e. "what the last
// collection surfaced" — the question the run dropdown actually existed to answer.
function timeCutoff() {
  if (fTime === "all") return null;
  if (fTime === "run") {
    const last = todayRuns[0];
    return last && last.started_at ? new Date(last.started_at).getTime() : null;
  }
  return Date.now() - Number(fTime) * 3600000;
}

function passTime(j) {
  const cut = timeCutoff();
  if (cut == null) return true;
  if (!j.first_seen_at) return false;
  return new Date(j.first_seen_at).getTime() >= cut;
}

// How old the POSTING is, in hours — not how long we have known about it.
// Falls back to first_seen_at when the source never dated the row, which is the
// honest reading for LinkedIn: its guest search is already fenced server-side to
// CONFIG.freshness.windowHours, so a card we saw an hour ago was posted within
// that window even when the <time> tag is missing. Returns null only when we
// have neither date, and a null is always KEPT (unknown ≠ old).
function postedAgeHours(j) {
  const raw = j.posted_at || j.first_seen_at;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  if (!isFinite(t)) return null;
  return (Date.now() - t) / 3600000;
}
function passPosted(j) {
  if (fPosted === "all") return true;
  const age = postedAgeHours(j);
  return age == null || age <= Number(fPosted);
}
function passPlace(j) {
  if (!fCities.size) return true;
  if (fCities.has("__remote__") && isRemote(j)) return true;
  return jobCities(j).some((c) => fCities.has(c));
}
function passSource(j) {
  return !fSources.size || fSources.has(j.source);
}

// Expanded state of the "+N abroad" chip row. Collapsing it also clears any
// abroad filter that was active, so the row can never be hidden AND filtering.
let showAbroad = false;
function toggleAbroad() {
  showAbroad = !showAbroad;
  if (!showAbroad) {
    for (const c of [...fCities]) {
      const p = canonPlace(c);
      if (p && p.abroad) fCities.delete(c);
    }
  }
  renderToday();
}

function setPosted(v) { fPosted = v; renderToday(); }
function setTime(v)   { fTime = v; renderToday(); }
function toggleCity(c)   { fCities.has(c)  ? fCities.delete(c)  : fCities.add(c);  renderToday(); }
function toggleSource(s) { fSources.has(s) ? fSources.delete(s) : fSources.add(s); renderToday(); }
function clearPlace()  { fCities.clear();  renderToday(); }
function clearSource() { fSources.clear(); renderToday(); }

function chip(label, count, active, onclick, extraCls) {
  return '<button onclick="' + onclick + '" class="px-2.5 py-1 rounded-full border text-xs transition-all ' +
    (active ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-200 text-slate-600 hover:border-slate-400") +
    ' ' + (extraCls || "") + '">' + escHtml(label) +
    (count != null ? '<span class="ml-1.5 tabular-nums ' + (active ? "text-slate-300" : "text-slate-400") + '">' + count + '</span>' : "") +
    '</button>';
}

// Counts on each chip are computed with that chip's OWN axis left out, so a
// number never reads as 0 just because you already narrowed the same axis.
function renderChips() {
  const bySource = todayJobs.filter((j) => passPosted(j) && passTime(j) && passPlace(j));
  const byPlace  = todayJobs.filter((j) => passPosted(j) && passTime(j) && passSource(j));
  const byTime   = todayJobs.filter((j) => passPosted(j) && passPlace(j) && passSource(j));
  const byPosted = todayJobs.filter((j) => passTime(j) && passPlace(j) && passSource(j));

  const postedIn = (h) => byPosted.filter((j) => {
    const age = postedAgeHours(j);
    return age == null || age <= h;
  }).length;
  $("postedChips").innerHTML = [
    chip("24h", postedIn(24), fPosted === 24, "setPosted(24)"),
    chip("3 days", postedIn(72), fPosted === 72, "setPosted(72)"),
    chip("7 days", postedIn(168), fPosted === 168, "setPosted(168)"),
    chip("30 days", postedIn(720), fPosted === 720, "setPosted(720)"),
    chip("Any age", byPosted.length, fPosted === "all", "setPosted('all')"),
  ].join("");

  const inWindow = (h) => byTime.filter((j) => j.first_seen_at &&
    new Date(j.first_seen_at).getTime() >= Date.now() - h * 3600000).length;
  const lastRun = todayRuns[0];
  const runCut = lastRun && lastRun.started_at ? new Date(lastRun.started_at).getTime() : null;
  const runCount = runCut == null ? 0
    : byTime.filter((j) => j.first_seen_at && new Date(j.first_seen_at).getTime() >= runCut).length;

  const timeParts = [
    chip("All day", byTime.length, fTime === "all", "setTime('all')"),
    chip("Last hour", inWindow(1), fTime === 1, "setTime(1)"),
    chip("Last 3h", inWindow(3), fTime === 3, "setTime(3)"),
    chip("Last 6h", inWindow(6), fTime === 6, "setTime(6)"),
  ];
  if (lastRun) timeParts.push(chip("Latest run · " + fmtTime(lastRun.started_at), runCount, fTime === "run", "setTime('run')"));
  $("timeChips").innerHTML = timeParts.join("");

  // Place chips are built from the data, not a hard-coded list, so a city added
  // to CONFIG shows up here on its first run with no UI change. Labels are
  // canonical (see canonPlace), so the dozen ATS spellings of Bengaluru land on
  // one chip instead of six.
  const counts = new Map();   // label -> { n, abroad }
  for (const j of byPlace) {
    const raw = (j.cities || []).filter(Boolean);
    const seen = new Set();
    for (const r of (raw.length ? raw : [j.location])) {
      const p = canonPlace(r);
      if (!p || seen.has(p.label)) continue;
      seen.add(p.label);
      const cur = counts.get(p.label) || { n: 0, abroad: p.abroad };
      cur.n++;
      counts.set(p.label, cur);
    }
  }
  const byCount = (a, b) => b[1].n - a[1].n;
  const home   = [...counts.entries()].filter(([, v]) => !v.abroad).sort(byCount);
  const abroad = [...counts.entries()].filter(([,  v]) =>  v.abroad).sort(byCount);
  const cityChip = ([c, v]) =>
    chip(c, v.n, fCities.has(c), "toggleCity(" + JSON.stringify(c).replace(/"/g, "&quot;") + ")");

  const remoteCount = byPlace.filter(isRemote).length;
  const placeParts = [chip("All", byPlace.length, !fCities.size, "clearPlace()")];
  if (remoteCount) placeParts.push(chip("Remote", remoteCount, fCities.has("__remote__"), "toggleCity('__remote__')",
    fCities.has("__remote__") ? "" : "border-emerald-200 text-emerald-700 bg-emerald-50"));
  placeParts.push(...home.map(cityChip));
  // The long tail of one-off foreign locations goes behind one chip.
  if (abroad.length) {
    const total = abroad.reduce((a, [, v]) => a + v.n, 0);
    placeParts.push(chip((showAbroad ? "− " : "+ ") + total + " abroad", null, showAbroad,
      "toggleAbroad()", "border-dashed text-slate-500"));
  }
  $("cityChips").innerHTML = placeParts.join("");
  const abroadBox = $("abroadChips");
  abroadBox.innerHTML = abroad.map(cityChip).join("");
  abroadBox.classList.toggle("hidden", !showAbroad || !abroad.length);
  abroadBox.classList.toggle("flex",    showAbroad && !!abroad.length);

  const srcCounts = new Map();
  for (const j of bySource) srcCounts.set(j.source, (srcCounts.get(j.source) || 0) + 1);
  const srcParts = [chip("All", bySource.length, !fSources.size, "clearSource()")];
  for (const [s, n] of [...srcCounts.entries()].sort((a, b) => b[1] - a[1]))
    srcParts.push(chip(s === "linkedin" ? "LinkedIn" : s === "naukri" ? "Naukri" : (s || "?"), n,
      fSources.has(s), "toggleSource(" + JSON.stringify(s).replace(/"/g, "&quot;") + ")"));
  $("sourceChips").innerHTML = srcParts.join("");
}

function renderRunsStrip(runs, isRunning) {
  const parts = [];
  // Rendered from CONFIG, not hardcoded — the old literal said "10am–7pm hourly"
  // long after the config moved to 09:30–21:00 every 30 min, so the badge was
  // quietly lying about the schedule.
  parts.push('<span class="px-2 py-0.5 rounded-full bg-slate-100">Auto ' + SCHEDULE.start + '–' + SCHEDULE.end + ' every ' + SCHEDULE.every + 'm</span>');
  // The fast checker runs between sweeps and alerts on the spot; say so here so
  // the strip describes everything that can put a job on this page.
  if (SCHEDULE.hot)
    parts.push('<span class="px-2 py-0.5 rounded-full bg-violet-50 text-violet-700">⚡ fast check every ' +
      SCHEDULE.hot.every + 'm · alerts at ' + SCHEDULE.hot.at + '%</span>');
  if (isRunning) parts.push('<span class="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">a run is in progress…</span>');
  const done = runs.filter((r) => r.status === "ok").length;
  const failed = runs.filter((r) => r.status === "error").length;
  parts.push('<span class="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">' + done + ' runs today</span>');
  if (failed) parts.push('<span class="px-2 py-0.5 rounded-full bg-rose-50 text-rose-700">' + failed + ' failed</span>');
  const last = runs[0];
  if (last) {
    parts.push('<span class="px-2 py-0.5 rounded-full bg-slate-100">last ' + fmtTime(last.started_at) +
      ' · ' + (last.trigger || "") + ' · ' + (last.final != null ? last.final + " kept" : last.status) +
      (last.new_jobs != null ? ", " + last.new_jobs + " new" : "") + '</span>');
  }
  $("todayRuns").innerHTML = parts.join(" ");
}

// Columns shown in Today. Market salary and TF-IDF are gone: TF-IDF needs a
// ./my-resume.md that doesn't exist, so tfidf_score is null on every row and the
// column was a wall of "—"; market salary is the AmbitionBox band for
// (company, role), which is background research, not a reason to open a posting.
// (Both are still computed/stored — the search-results table keeps them.)
// Seniority used to be its own column and was a wall of "—" (it is only set
// when the scorer has an opinion), so it now rides along in the Exp cell, which
// is the same question asked twice.
const TODAY_COLS = ["Score", "Title", "Company", "Location", "Posted", "Exp", "Applicants", "Apply", "Contact"];

// Everything fetched is kept and ranked (no drops). Only the top of the list is
// shown by default; the tail is one click away, with its penalties visible.
// Above the fold: scored well, OR unread but with a title that itself matched
// core skills ("React Developer" with no JD yet) — those are worth a click.
const aboveFold = (j) => (j.score || 0) >= LOW_RANK || (j.jd_missing && (j.score || 0) > 0);

function scoreClass(s) {
  if (s >= 70) return "bg-emerald-50 text-emerald-700";
  if (s >= LOW_RANK) return "bg-blue-50 text-blue-700";
  return "bg-slate-100 text-slate-500";
}

function todayRow(j) {
  const apply = j.apply_type === "easy_apply"
    ? '<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">Easy Apply</span>'
    : j.apply_type === "external"
      ? '<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600">Company Site</span>'
      : '<span class="text-slate-300">—</span>';
  const hr = j.hr_name
    ? (j.hr_profile_url
        ? '<a class="text-blue-600 hover:underline" target="_blank" href="' + escHtml(j.hr_profile_url) + '">' + escHtml(j.hr_name) + '</a>'
        : escHtml(j.hr_name))
    : '<span class="text-slate-300">—</span>';
  // Applicants since posted — the LinkedIn detail page's "N applicants" text,
  // captured at enrich time (see enrichLinkedInJobs) and stored on the row.
  const applicants = j.applicants
    ? '<span class="tabular-nums text-slate-600">' + escHtml(j.applicants) + '</span>'
    : '<span class="text-slate-300">—</span>';
  const sen = j.seniority === "stretch"
    ? '<span class="ml-1.5 text-amber-600">stretch</span>'
    : j.seniority === "favored"
      ? '<span class="ml-1.5 text-emerald-600">favored</span>'
      : "";
  // A job we never fetched the JD for has a meaningless score (0) — say so
  // instead of showing a number that reads as "bad match". The title link
  // still opens the real posting, which is how you judge these.
  const pens = j.penalties || [];
  const penTip = pens.map((x) => "-" + x.points + "  " + x.label).join("\\n");
  // Stack overlap (CONFIG.stackProfile): how much of YOUR stack the JD names.
  // Shown as "+N" next to the score, with the matched items in the tooltip, so
  // a job that ranks high because it IS your stack says so. A grey mark means
  // items matched but React/TypeScript were absent, so the bonus was 0 by rule —
  // that "why is this still not boosted?" case has to be visible, not silent.
  const st = j.stack || {};
  const stHits = st.hits || [];
  const stackMark = !stHits.length ? ""
    : st.bonus
      ? '<span class="ml-1 text-xs text-emerald-600 cursor-help" title="' +
        escHtml("+" + st.bonus + " stack overlap — " + stHits.length + " of your stack in this JD:\\n" + stHits.join(", ")) +
        '">+' + st.bonus + '</span>'
      : '<span class="ml-1 text-xs text-slate-400 cursor-help" title="' +
        escHtml(stHits.length + " of your stack matched (" + stHits.join(", ") +
                ") but the JD names neither React nor TypeScript, so no stack bonus was given.") +
        '">+0</span>';
  const scoreCell = j.jd_missing
    ? '<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700" title="The JD was never fetched (enrich cap or a failed request), so this job is unscored. Open the link to read it — a later run will score it.">JD?</span>'
    : '<span class="px-2 py-0.5 rounded-full text-xs font-semibold tabular-nums ' + scoreClass(j.score || 0) + '">' +
        (j.score != null ? j.score + '%' : '—') + '</span>' +
      (pens.length
        ? '<span class="ml-1 text-xs text-rose-500 cursor-help" title="' + escHtml(penTip) + '">&#9660;' +
          (j.base_score != null ? (j.base_score - j.score) : "") + '</span>'
        : "") +
      stackMark;
  // Source + remote live as small marks on the title/location cells rather than
  // as their own columns — they're facets now, so the table only has to confirm
  // what you already filtered to.
  const src = j.source
    ? '<span class="ml-2 align-middle text-[10px] uppercase tracking-wide text-slate-400">' + escHtml(j.source) + '</span>'
    : "";
  const loc = String(j.location || "");
  // Keep the posting's own location next to the Remote badge when it adds
  // something — a "remote" job listed in Bengaluru is often really hybrid.
  const place = isRemote(j)
    ? '<span class="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[11px]">Remote</span>' +
      (loc && !REMOTE_RE.test(loc) ? '<span class="ml-1.5 text-slate-400 text-xs">' + escHtml(loc) + '</span>' : "")
    : '<span class="text-slate-400 text-xs">' + escHtml(loc || "—") + '</span>';

  // Age of the POSTING. Its own column because it was invisible before, and
  // invisible staleness is how a 1,488-day-old req sat at 92% near the top of
  // the list. Greys out past a week, goes amber past a month.
  const ageH = postedAgeHours(j);
  const exact = !!j.posted_at;          // false = inferred from first_seen_at
  const ageCell = ageH == null
    ? '<span class="text-slate-300">—</span>'
    : '<span class="text-xs tabular-nums ' +
        (ageH <= 48 ? "text-emerald-600 font-medium" : ageH <= 168 ? "text-slate-500"
         : ageH <= 720 ? "text-slate-400" : "text-amber-600") + '"' +
        (exact ? "" : ' title="This source does not date its cards; shown as when we first saw it, which is within the search freshness window."') +
        '>' + fmtAge(ageH) + (exact ? "" : "*") + '</span>';

  const tr = document.createElement("tr");
  tr.className = "border-b border-slate-100 hover:bg-blue-50/40 transition-colors";
  tr.innerHTML =
    '<td class="py-2.5 pr-5 pl-3 whitespace-nowrap">' + scoreCell + '</td>' +
    '<td class="py-2.5 pr-5 min-w-[16rem] max-w-md"><a class="text-blue-600 hover:underline font-medium line-clamp-1" target="_blank" href="' + escHtml(j.url || "#") + '">' + escHtml(j.title || "") + '</a>' + src + '</td>' +
    '<td class="py-2.5 pr-5 text-slate-700 whitespace-nowrap">' + escHtml(j.company || "") + '</td>' +
    '<td class="py-2.5 pr-5 whitespace-nowrap">' + place + '</td>' +
    '<td class="py-2.5 pr-5 whitespace-nowrap">' + ageCell + '</td>' +
    '<td class="py-2.5 pr-5 text-xs whitespace-nowrap"><span class="text-slate-400">' +
      escHtml(j.experience || "—") + '</span>' + sen + '</td>' +
    '<td class="py-2.5 pr-5 text-xs whitespace-nowrap">' + applicants + '</td>' +
    '<td class="py-2.5 pr-5 text-xs whitespace-nowrap">' + apply + '</td>' +
    '<td class="py-2.5 pr-5 text-xs whitespace-nowrap">' + hr + '</td>';
  return tr;
}

function groupHeaderRow(label, n) {
  const tr = document.createElement("tr");
  tr.className = "bg-slate-50";
  tr.innerHTML = '<td colspan="' + TODAY_COLS.length + '" class="py-1.5 pl-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500 border-y border-slate-200">' +
    escHtml(label) + '<span class="ml-2 font-normal normal-case tabular-nums text-slate-400">' + n + '</span></td>';
  return tr;
}

function renderToday() {
  renderChips();
  const q = ($("todayFilter").value || "").toLowerCase();
  const scoped = todayJobs.filter((j) => passPosted(j) && passTime(j) && passPlace(j) && passSource(j));
  const jobs = scoped.filter((j) =>
    !q || (j.title || "").toLowerCase().includes(q) || (j.company || "").toLowerCase().includes(q));
  const narrowed = jobs.length !== todayJobs.length;
  $("todayCount").textContent = todayJobs.length
    ? (narrowed ? "(" + jobs.length + " shown · " + todayJobs.length + " today)"
                : "(" + todayJobs.length + " today)")
    : "";

  if (!jobs.length) {
    $("todayTable").classList.add("hidden");
    $("todayEmpty").classList.remove("hidden");
    // Never claim the day is empty when we simply have no data to show.
    if (todayLoadError) { $("todayEmpty").textContent = todayLoadError; return; }
    $("todayEmpty").textContent = todayJobs.length
      ? "Nothing matches these filters — widen the Posted / Found / Where / Source chips above."
      : "No jobs collected yet today — click “Run all cities now”, or wait for the next scheduled run.";
    return;
  }
  $("todayEmpty").classList.add("hidden");
  $("todayTable").classList.remove("hidden");

  $("todayThead").innerHTML = TODAY_COLS
    .map((h, i) => '<th class="py-2 pr-5 ' + (i === 0 ? "pl-3 " : "") + 'font-medium whitespace-nowrap">' + h + '</th>')
    .join("");

  const strong = jobs.filter(aboveFold);
  const weak   = jobs.filter((j) => !aboveFold(j));
  const btn = $("todayShowLow");
  if (weak.length) {
    btn.classList.remove("hidden");
    btn.textContent = (showLowRanked ? "Hide" : "Show") + " " + weak.length +
      " low-ranked job" + (weak.length === 1 ? "" : "s") + " (under " + LOW_RANK + "%)";
  } else {
    btn.classList.add("hidden");
  }
  const visible = showLowRanked ? strong.concat(weak) : strong;

  const tbody = $("todayTbody");
  tbody.innerHTML = "";
  if (!$("groupByCity").checked) {
    for (const j of visible) tbody.appendChild(todayRow(j));
    return;
  }
  // Grouped view. A posting found under two cities genuinely belongs to both, so
  // it appears under each — this is a reading order, not a partition, and the
  // header counts are per-group rather than a breakdown of the total.
  const groups = new Map();
  const remoteGroup = [];
  for (const j of visible) {
    if (isRemote(j)) { remoteGroup.push(j); continue; }
    const cs = jobCities(j).length ? jobCities(j) : ["Unknown"];
    for (const c of cs) {
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(j);
    }
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  if (remoteGroup.length) ordered.unshift(["Remote", remoteGroup]);
  for (const [label, list] of ordered) {
    tbody.appendChild(groupHeaderRow(label, list.length));
    for (const j of list) tbody.appendChild(todayRow(j));
  }
}

// ── Company boards (ATS) ─────────────────────────────────────────────────────
const ATS_COLORS = {
  greenhouse: "bg-emerald-50 text-emerald-700",
  lever:      "bg-sky-50 text-sky-700",
  ashby:      "bg-violet-50 text-violet-700",
  workday:    "bg-amber-50 text-amber-700",
};

async function loadAts() {
  try {
    const r = await fetch("/api/ats").then((x) => x.json());
    if (r.error) { $("atsStats").innerHTML = '<span class="text-rose-500">' + r.error + "</span>"; return; }

    $("atsCount").textContent = r.total + " companies";
    const chip = (txt, cls) =>
      '<span class="px-2 py-0.5 rounded-full ' + (cls || "bg-slate-100") + '">' + txt + "</span>";

    const parts = Object.entries(r.byAts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => chip(k + " " + v, ATS_COLORS[k]));

    // The rotation, stated plainly: a tick polls only what's due, so "due now"
    // is the number that explains why a poll took 12s instead of 3 minutes.
    parts.push(chip("due now " + r.due));
    // Read from the same flag the timer is armed off, so the badge can't claim a
    // cadence that isn't running (the exact drift the collect badge once had).
    parts.push(
      r.autoPoll
        ? chip("every " + r.intervalMinutes + "m, each board every " + r.refreshMinutes + "m")
        : chip("auto-poll off — manual only", "bg-amber-50 text-amber-700"),
    );
    if (r.neverPolled) parts.push(chip("never polled " + r.neverPolled, "bg-blue-50 text-blue-700"));
    if (r.dead) parts.push(chip(r.dead + " failing (backed off)", "bg-rose-50 text-rose-600"));
    if (r.running) parts.push(chip("polling…", "bg-indigo-50 text-indigo-700"));

    $("atsStats").innerHTML = parts.join(" ");
  } catch (e) {
    $("atsStats").innerHTML = '<span class="text-slate-400">registry unavailable</span>';
  }
}

async function runAtsPoll() {
  const btn = $("atsBtn");
  if (btn.disabled) return;
  btn.disabled = true;
  $("atsLog").classList.remove("hidden");
  $("atsLog").textContent = "Polling every known board (ignoring the refresh rotation)…";

  try {
    const res = await fetch("/api/ats/poll", { method: "POST" });
    if (res.status === 409) { $("atsLog").textContent += "\\nA poll is already in progress."; return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const chunks = buf.split("\\n\\n");
      buf = chunks.pop() || "";
      for (const chunk of chunks) {
        const line = chunk.replace(/^data: /, "").trim();
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "log") {
            $("atsLog").textContent += "\\n" + msg.text;
            $("atsLog").scrollTop = $("atsLog").scrollHeight;
          } else if (msg.type === "result") {
            $("atsLog").textContent +=
              "\\nDone → " + msg.final + " shortlisted, " + msg.inserted + " new / " + msg.updated +
              " refreshed (" + msg.boards + " boards, " + msg.rawPostings + " postings scanned).";
            await loadToday();
          } else if (msg.type === "error") {
            $("atsLog").textContent += "\\nERROR: " + msg.text;
          }
        } catch (e) {}
      }
    }
  } catch (e) {
    $("atsLog").textContent += "\\nFailed: " + e;
  } finally {
    btn.disabled = false;
    await loadAts();
    await loadToday();
  }
}

async function runCollect() {
  const btn = $("collectBtn");
  if (btn.disabled) return;
  btn.disabled = true;
  $("collectLog").classList.remove("hidden");
  $("collectLog").textContent = "Starting collection across all cities…";

  try {
    const res = await fetch("/api/collect", { method: "POST" });
    if (res.status === 409) { $("collectLog").textContent += "\\nAnother run is in progress — try again shortly."; return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const chunks = buf.split("\\n\\n");
      buf = chunks.pop() || "";
      for (const chunk of chunks) {
        const line = chunk.replace(/^data: /, "").trim();
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "log") {
            $("collectLog").textContent += "\\n" + msg.text;
            $("collectLog").scrollTop = $("collectLog").scrollHeight;
          } else if (msg.type === "result") {
            $("collectLog").textContent += "\\nDone → " + msg.final + " shortlisted, " + msg.inserted + " new / " + msg.updated + " refreshed.";
            await loadToday();
          } else if (msg.type === "error") {
            $("collectLog").textContent += "\\nERROR: " + msg.text;
          }
        } catch (e) {}
      }
    }
  } catch (e) {
    $("collectLog").textContent += "\\nFailed: " + e;
  } finally {
    btn.disabled = false;
    await loadToday();
  }
}

$("todayFilter").oninput = renderToday;
renderToday();   // paint "loading…" immediately, before the first fetch returns
loadToday();
loadAts();
// Light auto-refresh so a scheduled run surfaces without a manual reload.
setInterval(loadToday, 60000);
// The ATS panel ticks faster than the collector does, so refresh it more often
// — otherwise "due now" is stale for most of the window between polls.
setInterval(loadAts, 30000);
</script>
</body>
</html>`;

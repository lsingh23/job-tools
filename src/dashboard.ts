import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CONFIG } from "../config.js";
import { initSchema, getJobsForDate, getRunsForDate, today } from "./db.js";
import { runCollection } from "./collect.js";

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

/** True when local wall-clock hour is inside the configured collect window. */
function inActiveWindow(): boolean {
  const [start, end] = CONFIG.collect.activeHours;
  const h = new Date().getHours();
  return h >= start && h <= end;
}

/**
 * Hand-rolled hourly scheduler (no cron dependency): fire on each top-of-hour,
 * and only actually collect when inside [10,19] and nothing else is running.
 */
function startScheduler(): void {
  const tick = async () => {
    if (inActiveWindow() && !running) {
      running = true;
      try {
        console.log(`\n[scheduler] auto-collect @ ${new Date().toLocaleTimeString()}`);
        const r = await runCollection({ trigger: "auto", log: (...a) => console.log(...a) });
        console.log(`[scheduler] done → ${r.final} shortlisted, ${r.inserted} new / ${r.updated} refreshed`);
      } catch (err) {
        console.error("[scheduler] auto-collect failed:", err instanceof Error ? err.message : err);
      } finally {
        running = false;
      }
    }
    scheduleNextHour();
  };
  const scheduleNextHour = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(now.getHours() + 1, 0, 5, 0); // :00:05 of the next hour
    setTimeout(tick, next.getTime() - now.getTime());
  };
  const [s, e] = CONFIG.collect.activeHours;
  console.log(`[scheduler] hourly auto-collect armed for ${s}:00–${e}:59 local time.`);
  scheduleNextHour();
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

      let params: { source?: string; city?: string; hours?: number; pages?: number; maxApplicants?: number } = {};
      try { params = JSON.parse(await readBody(req)); } catch { /* use defaults */ }

      const source        = params.source === "naukri" ? "naukri" : "linkedin";
      const city          = String(params.city  ?? "Bengaluru");
      const hours         = Math.max(1, Number(params.hours ?? 15));
      const pages         = Math.max(1, Math.min(10, Number(params.pages ?? 3)));
      const maxApplicants = params.maxApplicants ? Math.max(1, Number(params.maxApplicants)) : null;

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

  <header class="mb-6 flex items-baseline gap-3">
    <h1 class="text-2xl font-semibold">job-tools</h1>
    <span class="text-slate-400 font-normal">dashboard</span>
  </header>

  <!-- ══════════════════════════════════════════════════════════════════════
       TODAY — accumulated from Neon. Every hourly auto-collect (10am–7pm) and
       every manual "Run all cities now" upserts into the same day's set, so this
       persists across refreshes and grows through the day.
       ══════════════════════════════════════════════════════════════════════ -->
  <section class="bg-white rounded-xl border border-slate-200 p-5 mb-6">
    <div class="flex flex-wrap items-center gap-3 mb-3">
      <h2 class="font-semibold">Today's jobs</h2>
      <span id="todayCount" class="text-slate-400 text-xs"></span>
      <button id="collectBtn" onclick="runCollect()"
        class="ml-auto px-4 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-500 disabled:opacity-40 transition-all text-sm">
        Run all cities now
      </button>
      <select id="todayRunFilter" onchange="renderToday()" title="Show jobs from a specific run"
        class="text-sm border border-slate-200 rounded-lg px-2 py-1">
        <option value="all">All runs today</option>
      </select>
      <input id="todayFilter" placeholder="Filter title / company…" oninput="renderToday()"
        class="text-sm border border-slate-200 rounded-lg px-2 py-1 w-56" />
    </div>

    <!-- Scheduler + per-run status strip -->
    <div id="todayRuns" class="mb-3 flex flex-wrap gap-2 text-xs text-slate-500"></div>

    <!-- Manual-collect progress log -->
    <pre id="collectLog"
      class="hidden mb-3 max-h-40 overflow-auto bg-slate-900 text-slate-100 text-xs rounded-xl p-3 whitespace-pre-wrap leading-relaxed"></pre>

    <p id="todayEmpty" class="text-slate-400 py-6 text-center text-sm">
      No jobs collected yet today — click “Run all cities now”, or wait for the next hourly run (10am–7pm).
    </p>
    <div>
      <table id="todayTable" class="hidden w-full text-sm">
        <thead><tr id="todayThead" class="text-left text-slate-500 border-b border-slate-200"></tr></thead>
        <tbody id="todayTbody"></tbody>
      </table>
    </div>
  </section>

  <!-- ══════════════════════════════════════════════════════════════════════
       QUICK SEARCH — the only mode. (The old "Daily Run" tab is gone: it ran
       the whole multi-source batch on a schedule; searching a source directly
       does the same work on demand, with the same pipeline behind it.)
       ══════════════════════════════════════════════════════════════════════ -->
  <div id="pane-search">

    <!-- Search controls -->
    <section class="bg-white rounded-xl border border-slate-200 p-5 mb-4">

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
    <section id="searchResultsWrap" class="hidden bg-white rounded-xl border border-slate-200 p-5">
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

  </div><!-- /pane-search -->

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
      body: JSON.stringify({ source, city, hours, pages, ...(maxApplicants ? { maxApplicants } : {}) }),
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
    "KW score", "TF-IDF", "Title", "Company", "Presence", "Location", "Exp", "Market salary", "Applicants", "Seniority", "Apply", "HR contact"
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
    // Only populated where AmbitionBox had NO page — so a dash here means
    // AmbitionBox covers them, which is itself a mild signal they're established.
    const p = j.presence;
    const presTone = p && p.verdict === "operating" ? "bg-emerald-50 text-emerald-700"
      : p && p.verdict === "thin" ? "bg-amber-50 text-amber-700"
      : "bg-slate-100 text-slate-500";
    const pres = p
      ? '<span class="px-2 py-0.5 rounded-full text-xs font-medium ' + presTone + '" title="' + escHtml(p.reasons.join(" • ")) + '">' + escHtml(p.verdict) + '</span>'
      : '<span class="text-slate-300" title="On AmbitionBox — no footprint check needed">—</span>';
    const tr = document.createElement("tr");
    tr.className = "border-b border-slate-100 hover:bg-slate-50";
    tr.innerHTML =
      '<td class="py-2 pr-5"><span class="font-semibold tabular-nums">' + j.score + '%</span></td>' +
      '<td class="py-2 pr-5">' + tfidf + '</td>' +
      '<td class="py-2 pr-5 max-w-xs"><a class="text-blue-600 hover:underline line-clamp-1" target="_blank" href="' + escHtml(j.url) + '" data-jd="' + encodeURIComponent(j.description || "") + '">' + escHtml(j.title) + '</a></td>' +
      '<td class="py-2 pr-5 text-slate-600 whitespace-nowrap">' + escHtml(j.company) + '</td>' +
      '<td class="py-2 pr-5 text-xs whitespace-nowrap">' + pres + '</td>' +
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
// presence_* is only ever populated for companies AmbitionBox had no page for.
const SHOW  = ["score","tfidf_sim","title","company","presence_verdict","experience","salary_lpa","market_salary_lpa","market_salary_match","market_salary_at_exp","apply_type","hr_name","seniority","remote","location","source","posted_at"];

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
  populateRunFilter(todayRuns);
  renderToday();
}

// Fill the run dropdown with one option per run (newest first), preserving the
// current selection across the 60s auto-refresh. Runs never overlap (only one
// collects at a time), so each has a clean [started_at, finished_at] window we
// use to attribute jobs. Runs with no discoveries are still listed.
function populateRunFilter(runs) {
  const sel = $("todayRunFilter");
  const prev = sel.value;
  const opts = ['<option value="all">All runs today</option>'];
  for (const r of runs) {
    const n = r.new_jobs != null ? r.new_jobs : (r.final != null ? r.final : "—");
    const label = fmtTime(r.started_at) + " · " + (r.trigger || "?") +
      " · " + n + " new" + (r.status === "running" ? " · running…" : r.status === "error" ? " · failed" : "");
    opts.push('<option value="' + r.id + '">' + escHtml(label) + '</option>');
  }
  sel.innerHTML = opts.join("");
  // Keep the prior choice if that run still exists; otherwise fall back to "all".
  sel.value = runs.some((r) => String(r.id) === prev) ? prev : "all";
}

// Jobs first surfaced within the selected run's window — i.e. what that run
// newly discovered. "all" returns the accumulated day. A still-running run has
// no finished_at yet, so treat its window as open-ended.
function jobsForSelectedRun() {
  const id = $("todayRunFilter").value;
  if (id === "all") return todayJobs;
  const run = todayRuns.find((r) => String(r.id) === id);
  if (!run) return todayJobs;
  const start = new Date(run.started_at).getTime();
  const end = run.finished_at ? new Date(run.finished_at).getTime() : Infinity;
  return todayJobs.filter((j) => {
    if (!j.first_seen_at) return false;
    const t = new Date(j.first_seen_at).getTime();
    return t >= start && t <= end;
  });
}

function renderRunsStrip(runs, isRunning) {
  const parts = [];
  parts.push('<span class="px-2 py-0.5 rounded-full bg-slate-100">Auto 10am–7pm hourly</span>');
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

function renderToday() {
  const q = ($("todayFilter").value || "").toLowerCase();
  const scoped = jobsForSelectedRun();
  const jobs = scoped.filter((j) =>
    !q || (j.title || "").toLowerCase().includes(q) || (j.company || "").toLowerCase().includes(q));
  const isRun = $("todayRunFilter").value !== "all";
  $("todayCount").textContent = todayJobs.length
    ? (isRun ? "(" + scoped.length + " from this run · " + todayJobs.length + " total today)"
             : "(" + todayJobs.length + " total)")
    : "";

  if (!jobs.length) {
    $("todayTable").classList.add("hidden");
    $("todayEmpty").classList.remove("hidden");
    // Never claim the day is empty when we simply have no data to show.
    if (todayLoadError) { $("todayEmpty").textContent = todayLoadError; return; }
    $("todayEmpty").textContent = isRun
      ? "This run surfaced no new jobs" + (q ? " matching your filter." : ". Earlier runs may have already caught them — switch to “All runs today”.")
      : "No jobs collected yet today — click “Run all cities now”, or wait for the next hourly run (10am–7pm).";
    return;
  }
  $("todayEmpty").classList.add("hidden");
  $("todayTable").classList.remove("hidden");

  // Column set mirrors the "Search LinkedIn" results table (KW score → HR
  // contact) so the two views read identically, plus the two DB-only extras
  // this accumulated view can show: Cities (union across the day's runs) and
  // First seen (when the posting first surfaced today).
  $("todayThead").innerHTML = [
    "Score", "TF-IDF", "Title", "Company", "Presence", "Location", "Exp", "Market salary", "Applicants", "Seniority", "Apply", "HR contact", "Cities", "First seen"
  ].map((h) => '<th class="py-2 pr-5 font-medium whitespace-nowrap">' + h + '</th>').join("");

  const tbody = $("todayTbody");
  tbody.innerHTML = "";
  for (const j of jobs) {
    const tfidf = j.tfidf_score != null
      ? '<span class="tabular-nums text-slate-500">' + (j.tfidf_score * 100).toFixed(1) + '%</span>'
      : '<span class="text-slate-300">—</span>';
    const cities = (j.cities || []).length
      ? '<span class="text-slate-500 text-xs">' + escHtml((j.cities || []).join(", ")) + '</span>'
      : '<span class="text-slate-300">—</span>';
    const b = j.salary_band;
    const mkt = b
      ? '<span class="tabular-nums">' + (b.atExp ? b.atExp.minLpa + "–" + b.atExp.maxLpa : b.minLpa + "–" + b.maxLpa) + '</span>'
      : '<span class="text-slate-300">—</span>';
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
      ? '<span class="text-amber-600">stretch</span>'
      : j.seniority === "favored"
        ? '<span class="text-emerald-600">favored</span>'
        : '<span class="text-slate-400">—</span>';
    // presence is only populated for companies AmbitionBox had no page for — a
    // dash here means AmbitionBox covers them (itself a mild established signal).
    const p = j.presence;
    const presTone = p && p.verdict === "operating" ? "bg-emerald-50 text-emerald-700"
      : p && p.verdict === "thin" ? "bg-amber-50 text-amber-700"
      : "bg-slate-100 text-slate-500";
    const pres = p
      ? '<span class="px-2 py-0.5 rounded-full text-xs font-medium ' + presTone + '" title="' + escHtml((p.reasons || []).join(" • ")) + '">' + escHtml(p.verdict) + '</span>'
      : '<span class="text-slate-300" title="On AmbitionBox — no footprint check needed">—</span>';
    const tr = document.createElement("tr");
    tr.className = "border-b border-slate-100 hover:bg-slate-50";
    tr.innerHTML =
      '<td class="py-2 pr-5"><span class="font-semibold tabular-nums">' + (j.score != null ? j.score + '%' : '—') + '</span></td>' +
      '<td class="py-2 pr-5">' + tfidf + '</td>' +
      '<td class="py-2 pr-5 min-w-[15rem] max-w-md"><a class="text-blue-600 hover:underline line-clamp-1" target="_blank" href="' + escHtml(j.url || "#") + '">' + escHtml(j.title || "") + '</a></td>' +
      '<td class="py-2 pr-5 text-slate-600 whitespace-nowrap">' + escHtml(j.company || "") + '</td>' +
      '<td class="py-2 pr-5 text-xs whitespace-nowrap">' + pres + '</td>' +
      '<td class="py-2 pr-5 text-slate-400 text-xs whitespace-nowrap">' + escHtml(j.location || "") + '</td>' +
      '<td class="py-2 pr-5 text-slate-400 text-xs whitespace-nowrap">' + escHtml(j.experience || "") + '</td>' +
      '<td class="py-2 pr-5 text-xs whitespace-nowrap">' + mkt + '</td>' +
      '<td class="py-2 pr-5 text-xs whitespace-nowrap">' + applicants + '</td>' +
      '<td class="py-2 pr-5 text-xs">' + sen + '</td>' +
      '<td class="py-2 pr-5 text-xs whitespace-nowrap">' + apply + '</td>' +
      '<td class="py-2 pr-5 text-xs whitespace-nowrap">' + hr + '</td>' +
      '<td class="py-2 pr-5 whitespace-nowrap">' + cities + '</td>' +
      '<td class="py-2 pr-5 text-xs text-slate-400 whitespace-nowrap">' + fmtTime(j.first_seen_at) + '</td>';
    tbody.appendChild(tr);
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
// Light auto-refresh so an hourly auto-collect surfaces without a manual reload.
setInterval(loadToday, 60000);
</script>
</body>
</html>`;

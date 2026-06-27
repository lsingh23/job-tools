import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CONFIG } from "../config.js";

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
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
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
      const rows = Math.max(0, parseCsv(text).length - 1); // minus header
      return { name, mtime: st.mtimeMs, rows };
    }),
  );
  return out.sort((a, b) => b.mtime - a.mtime);
}

let running = false; // single-flight: never run two scrapes at once

function runScript(script: "daily" | "daily:dry"): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("npm", ["run", script], { cwd: resolve("."), env: process.env });
    let output = "";
    const onData = (d: Buffer) => { output += d.toString(); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, output }));
    child.on("error", (err) => resolvePromise({ code: -1, output: output + "\n" + String(err) }));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/runs") {
      json(res, 200, { runs: await listRuns() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/csv") {
      const name = url.searchParams.get("name") ?? "";
      // Guard against path traversal — only allow plain CSV filenames.
      if (!/^[\w.-]+\.csv$/.test(name)) { json(res, 400, { error: "bad name" }); return; }
      let text: string;
      try { text = await readFile(join(OUTPUT_DIR, name), "utf8"); }
      catch { json(res, 404, { error: "not found" }); return; }
      const rows = parseCsv(text);
      json(res, 200, { header: rows[0] ?? [], rows: rows.slice(1) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      if (running) { json(res, 409, { error: "A run is already in progress." }); return; }
      const mode = url.searchParams.get("mode") === "dry" ? "daily:dry" : "daily";
      running = true;
      try {
        const { code, output } = await runScript(mode);
        json(res, 200, { ok: code === 0, code, output });
      } finally { running = false; }
      return;
    }

    res.writeHead(404); res.end("Not found");
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`\njob-tools dashboard → http://localhost:${PORT}\n(Ctrl-C to stop)`);
});

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>job-tools dashboard</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 text-slate-800">
<div class="max-w-6xl mx-auto p-6">

  <header class="mb-6">
    <h1 class="text-2xl font-semibold">job-tools <span class="text-slate-400 font-normal">dashboard</span></h1>
    <p class="text-sm text-slate-500">Local-first daily job hunter — run it, then browse the ranked CSV below.</p>
  </header>

  <!-- Controls -->
  <section class="bg-white rounded-xl border border-slate-200 p-5 mb-5">
    <div class="flex flex-wrap items-center gap-3">
      <button id="runBtn" class="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50">
        Run daily
      </button>
      <button id="dryBtn" class="px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium hover:bg-slate-100 disabled:opacity-50">
        Dry run (preview only)
      </button>
      <span id="status" class="text-sm text-slate-500"></span>
    </div>
    <pre id="log" class="hidden mt-4 max-h-64 overflow-auto bg-slate-900 text-slate-100 text-xs rounded-lg p-3 whitespace-pre-wrap"></pre>
  </section>

  <!-- Instructions -->
  <section class="grid md:grid-cols-2 gap-4 mb-6">
    <div class="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
      <h2 class="font-semibold text-emerald-800 text-sm mb-2">When to run</h2>
      <ul class="text-sm text-emerald-900/80 list-disc pl-5 space-y-1">
        <li>Once each <b>morning</b> — sources are filtered to the last 24h.</li>
        <li><b>Run daily</b> writes a new ranked CSV of only the new jobs.</li>
        <li><b>Dry run</b> previews results without writing a CSV or updating the seen-tracker.</li>
        <li>A <b>daily</b> run can take a few minutes (polite, jittered scraping + enrichment).</li>
      </ul>
    </div>
    <div class="bg-rose-50 border border-rose-200 rounded-xl p-4">
      <h2 class="font-semibold text-rose-800 text-sm mb-2">What not to do</h2>
      <ul class="text-sm text-rose-900/80 list-disc pl-5 space-y-1">
        <li>Don't run it <b>repeatedly</b> — keep it to once a day to avoid blocks/CAPTCHA.</li>
        <li>Run only from your <b>home (residential) IP</b>, never a cloud VM.</li>
        <li>No LinkedIn/Naukri <b>login</b> — logged-out endpoints only.</li>
        <li>Don't start a run while one is already in progress.</li>
      </ul>
    </div>
  </section>

  <!-- Results -->
  <section class="bg-white rounded-xl border border-slate-200 p-5">
    <div class="flex flex-wrap items-center gap-3 mb-3">
      <h2 class="font-semibold text-sm">Results</h2>
      <select id="runSelect" class="text-sm border border-slate-300 rounded-lg px-2 py-1"></select>
      <input id="filter" placeholder="Filter title / company…" class="text-sm border border-slate-300 rounded-lg px-2 py-1 ml-auto w-56" />
    </div>
    <div id="empty" class="text-sm text-slate-400 py-8 text-center">No runs yet. Click <b>Run daily</b> above.</div>
    <div class="overflow-auto">
      <table id="table" class="hidden w-full text-sm">
        <thead><tr id="thead" class="text-left text-slate-500 border-b border-slate-200"></tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
  </section>
</div>

<script>
const $ = (id) => document.getElementById(id);
let current = { header: [], rows: [] };
// Columns to show in the table (subset of the CSV) for readability.
const SHOW = ["score","title","company","experience","salary_lpa","seniority","remote","location","source","posted_at"];

async function loadRuns() {
  const r = await fetch("/api/runs").then((x) => x.json());
  const sel = $("runSelect");
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
  render();
}

function cell(header, row, key) {
  const i = header.indexOf(key);
  return i === -1 ? "" : (row[i] ?? "");
}

function render() {
  const { header, rows } = current;
  $("empty").classList.add("hidden");
  $("table").classList.remove("hidden");
  const cols = SHOW.filter((c) => header.includes(c));
  $("thead").innerHTML = cols.map((c) => '<th class="py-2 pr-4 font-medium">' + c + "</th>").join("");
  const q = $("filter").value.trim().toLowerCase();
  const tbody = $("tbody");
  tbody.innerHTML = "";
  for (const row of rows) {
    const title = cell(header, row, "title").toLowerCase();
    const company = cell(header, row, "company").toLowerCase();
    if (q && !title.includes(q) && !company.includes(q)) continue;
    const tr = document.createElement("tr");
    tr.className = "border-b border-slate-100 hover:bg-slate-50";
    const url = cell(header, row, "url");
    tr.innerHTML = cols.map((c) => {
      let v = cell(header, row, c);
      if (c === "score") return '<td class="py-2 pr-4 font-semibold tabular-nums">' + v + "%</td>";
      if (c === "title" && url) return '<td class="py-2 pr-4"><a class="text-blue-600 hover:underline" target="_blank" href="' + url + '">' + v + "</a></td>";
      return '<td class="py-2 pr-4 text-slate-600">' + v + "</td>";
    }).join("");
    tbody.appendChild(tr);
  }
}

async function run(mode) {
  const btns = [$("runBtn"), $("dryBtn")];
  btns.forEach((b) => (b.disabled = true));
  $("status").textContent = (mode === "dry" ? "Dry run" : "Run") + " in progress… this can take a few minutes.";
  $("log").classList.remove("hidden");
  $("log").textContent = "Starting…";
  try {
    const r = await fetch("/api/run?mode=" + mode, { method: "POST" }).then((x) => x.json());
    if (r.error) { $("status").textContent = r.error; $("log").textContent = r.error; }
    else {
      $("log").textContent = r.output || "(no output)";
      $("status").textContent = r.ok ? "Done." : "Finished with errors (exit " + r.code + ").";
      await loadRuns();
    }
  } catch (e) {
    $("status").textContent = "Request failed: " + e;
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

$("runBtn").onclick = () => run("daily");
$("dryBtn").onclick = () => run("dry");
$("runSelect").onchange = (e) => loadCsv(e.target.value);
$("filter").oninput = render;
loadRuns();
</script>
</body>
</html>`;

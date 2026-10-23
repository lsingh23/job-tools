// Local LLM proxy for the job-autofill userscript.
//   export DEEPSEEK_API_KEY=sk-... ; node applier/server.mjs
//
// Stateless. The userscript sends ONE knowledge base { contact, resume, qa }
// plus the form's questions; DeepSeek answers each AS the candidate, matching by
// MEANING and using the résumé for open-ended ones. No data is stored here.

import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, statSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deepseekChat, DEEPSEEK_MODEL, hasDeepSeekKey } from "./deepseek.mjs";
import { loadPrompt } from "./prompts.mjs";
import { recordOutcome, insights } from "./feedback.mjs";
import { tailor } from "./tailor.mjs";
import { saveEdited, MASTER } from "./editor.mjs";
import { docxToPdf, pdfPageCount, canRenderPdf, writePatchedDocx } from "./docx.mjs";
import { renderEditable, applyTextEdits } from "./wysiwyg.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TAILORED_DIR = path.join(HERE, "tailored");
const PROBES_DIR = path.join(HERE, "probes");

// Fallback résumé Autofill attaches when nothing tailored is cached. Override with DEFAULT_RESUME.
const DEFAULT_RESUME = process.env.DEFAULT_RESUME ?? "/Users/lakhveer/Lakhveer/Frontend Engineer/Lakhveer Singh Resume.pdf";

// Root of the pre-built per-title résumé folders (Lakhveer/<title>/*.pdf). The "attach existing"
// picker lists PDFs one level under this; fetching one is confined to this tree.
const RESUME_ROOT = process.env.RESUME_ROOT ?? path.dirname(path.dirname(DEFAULT_RESUME));

// Every selectable résumé PDF: {folder, name, rel, mtime}. Root-level PDFs plus one folder level
// deep; skips Word lock files (~$…) and .bak backups.
function listResumes() {
  const root = path.resolve(RESUME_ROOT);
  const out = [];
  const scan = (dir, folder) => {
    for (const f of readdirSync(dir)) {
      if (!f.toLowerCase().endsWith(".pdf") || f.startsWith("~$")) continue;
      const abs = path.join(dir, f);
      out.push({ folder, name: f, rel: path.relative(root, abs), mtime: statSync(abs).mtimeMs });
    }
  };
  scan(root, "");
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (d.isDirectory()) scan(path.join(root, d.name), d.name);
  }
  return out.sort((a, b) => (a.folder || "").localeCompare(b.folder || "") || a.name.localeCompare(b.name));
}

// Recruiter-style output filename: "Lakhveer Singh Resume - <Company> - <YYYY-MM-DD>.docx".
const safe = (s) => String(s || "").replace(/[^\w .()&-]+/g, " ").replace(/\s+/g, " ").trim();
const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time
const outputName = (company) => `Lakhveer Singh Resume - ${company ? safe(company) : "Tailored"} - ${today()}.docx`;

// Build a .docx from edits at destDocx, render it to PDF, return the PDF as base64 + page count.
// highlight:true shades changed paragraphs (review preview); false = clean final résumé.
// keepPdfAt (optional) copies the rendered PDF there before the temp render dir is cleaned up.
function buildAndRender(edits, destDocx, { highlight, keepPdfAt = null }) {
  saveEdited(edits, destDocx, MASTER, { highlight });
  const dir = mkdtempSync(path.join(tmpdir(), "tailor-pdf-"));
  try {
    const pdf = docxToPdf(destDocx, dir);
    if (keepPdfAt) copyFileSync(pdf, keepPdfAt);
    return { pdf_base64: readFileSync(pdf).toString("base64"), pages: pdfPageCount(pdf) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Normalize UI edits ({id, text} or {id, new_text}) to editor.mjs's {id, text} contract.
const toEdits = (arr) =>
  (Array.isArray(arr) ? arr : [])
    .map((e) => ({ id: String(e?.id || ""), text: typeof e?.text === "string" ? e.text : String(e?.new_text ?? "") }))
    .filter((e) => /^p\d+$/.test(e.id) || e.id === "loc");

// ── WYSIWYG résumé editor (applier/wysiwyg.html) ────────────────────────────────
// Editable sources: the master, plus anything already saved in tailored/. A source key is
// "master" or "tailored/<file>.docx"; nothing else resolves, so the editor can't reach outside.
function editorSources() {
  const out = [{ key: "master", label: `${path.basename(MASTER)} (master)` }];
  if (existsSync(TAILORED_DIR)) {
    const docx = readdirSync(TAILORED_DIR)
      .filter((f) => f.toLowerCase().endsWith(".docx") && !f.startsWith("~$"))
      .filter((f) => path.join(TAILORED_DIR, f) !== path.resolve(MASTER)) // already listed as "master"
      .map((f) => ({ f, mtime: statSync(path.join(TAILORED_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { f } of docx) out.push({ key: `tailored/${f}`, label: f.replace(/\.docx$/i, "") });
  }
  return out;
}

function resolveSource(key) {
  if (!key || key === "master") return MASTER;
  const m = /^tailored\/(.+\.docx)$/i.exec(String(key));
  if (!m) throw new Error(`unknown source: ${key}`);
  const abs = path.resolve(TAILORED_DIR, m[1]);
  if (path.dirname(abs) !== path.resolve(TAILORED_DIR)) throw new Error("path outside tailored/");
  if (!existsSync(abs)) throw new Error(`not found: ${key}`);
  return abs;
}

// Apply the editor's text edits to `srcPath` and render the result. Writes destDocx (the styled,
// lossless .docx) and returns the PDF bytes; keepPdfAt also drops the .pdf next to it.
function renderEdited(srcPath, edits, destDocx, keepPdfAt = null) {
  const { xml, changed } = applyTextEdits(srcPath, edits && typeof edits === "object" ? edits : {});
  writePatchedDocx(srcPath, xml, destDocx);
  const dir = mkdtempSync(path.join(tmpdir(), "wys-pdf-"));
  try {
    const pdf = docxToPdf(destDocx, dir);
    if (keepPdfAt) copyFileSync(pdf, keepPdfAt);
    return { pdf_base64: readFileSync(pdf).toString("base64"), pages: pdfPageCount(pdf), changed };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PORT = Number(process.env.APPLIER_PORT ?? 8787);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
const send = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", ...CORS }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, fail) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => ok(s)); req.on("error", fail); });

function resumeToText(resume) {
  if (typeof resume === "string") return resume;
  if (!resume || typeof resume !== "object") return "";
  const lines = [];
  if (resume.summary) lines.push("SUMMARY", resume.summary, "");
  if (resume.skills) {
    lines.push("SKILLS");
    for (const [group, items] of Object.entries(resume.skills)) {
      if (Array.isArray(items) && items.length) lines.push(`- ${group}: ${items.join(", ")}`);
    }
    lines.push("");
  }
  if (Array.isArray(resume.experience) && resume.experience.length) {
    lines.push("WORK EXPERIENCE", "");
    for (const job of resume.experience) {
      lines.push(`${job.company} | ${job.title} | ${job.location} | ${job.dates}`);
      for (const b of job.bullets || []) lines.push(`- ${b}`);
      if (job.stack?.length) lines.push(`- Stack: ${job.stack.join(", ")}`);
      lines.push("");
    }
  }
  if (Array.isArray(resume.education) && resume.education.length) {
    lines.push("EDUCATION");
    for (const ed of resume.education) {
      lines.push(`${ed.institution} | ${ed.location} | ${ed.dates}`);
      lines.push(`${ed.degree}${ed.gpa ? ` | GPA: ${ed.gpa}` : ""}`);
    }
    lines.push("");
  }
  if (Array.isArray(resume.projects) && resume.projects.length) {
    lines.push("PROJECTS");
    for (const p of resume.projects) {
      lines.push(p.name);
      if (p.description) lines.push(p.description);
      for (const b of p.bullets || []) lines.push(`- ${b}`);
      if (p.stack?.length) lines.push(`- Stack: ${p.stack.join(", ")}`);
      lines.push("");
    }
  }
  return lines.join("\n").trim();
}

// A question is either a bare label (free-text field) or {label, kind, options}.
// `options` is the field's actual choice texts, read out of the page — a dropdown or
// radio group is answerable on a first visit only if the model can see what it may pick.
const qLabel = (q) => (typeof q === "string" ? q : String(q?.label ?? ""));
const qOptions = (q) => (typeof q === "object" && Array.isArray(q?.options) ? q.options.filter((o) => typeof o === "string" && o.trim()) : []);

// Map a model answer back onto one of the field's real option texts. The model is asked
// for a verbatim option, but it paraphrases ("30 days" for "30 Days or less"), so accept
// a containment match either way before giving up.
const onorm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function pickOption(ans, options) {
  const a = onorm(ans);
  if (!a) return "";
  const exact = options.find((o) => onorm(o) === a);
  if (exact) return exact;
  return options.find((o) => onorm(o) && (onorm(o).includes(a) || a.includes(onorm(o)))) || "";
}

// The deduped cross-site memory: one line per canonical key. Labels are mapped to keys
// client-side by a pattern table — the model only reads these, it never names them.
const factsToText = (facts) => {
  const lines = Object.entries(facts || {})
    .map(([k, f]) => [k, f && typeof f === "object" ? f.v : f])
    .filter(([, v]) => typeof v === "string" && v.trim())
    .map(([k, v]) => `${k}: ${v}`);
  return lines.join("\n") || "(none yet)";
};

async function answer(profile, questions) {
  const contact = profile.contact || {};
  const qa = (profile.qa || []).map((x) => `Q: ${x.q}\nA: ${x.a}`).join("\n") || "(none yet)";
  const resume = resumeToText(profile.resume).slice(0, 8000);

  const system = loadPrompt("answer", {
    CONTACT: JSON.stringify(contact, null, 0),
    FACTS: factsToText(profile.facts),
    QA: qa,
    RESUME: resume || "(none provided)",
  });
  const user = "Questions:\n" + questions.map((q, i) => {
    const opts = qOptions(q);
    let line = `${i + 1}. ${qLabel(q)}`;
    if (opts.length) line += "\n   CHOICE — reply with EXACTLY one of these, copied character-for-character:\n" + opts.map((o) => `   - ${o}`).join("\n");
    return line;
  }).join("\n");

  const content = await deepseekChat({ system, user, temperature: 0.4, json: true });
  let parsed = {};
  try { parsed = JSON.parse(content); } catch { /* ignore */ }
  const toText = (a) => {
    if (typeof a === "string") return a.trim();
    if (a && typeof a === "object") return Object.values(a).filter((v) => typeof v === "string").join(", ");
    return "";
  };
  const byIndex = new Map();
  if (Array.isArray(parsed.answers)) {
    for (const entry of parsed.answers) {
      if (entry && typeof entry === "object" && Number.isInteger(entry.n)) {
        const text = toText(entry.a);
        if (text) byIndex.set(entry.n, text);
      }
    }
  }
  // Choice fields must resolve to a real option — a near-miss string would silently
  // fail to select anything in the page, so snap it or report it unanswered.
  return questions.map((q, i) => {
    const raw = byIndex.get(i + 1) || "UNKNOWN";
    const opts = qOptions(q);
    if (!opts.length || raw === "UNKNOWN") return raw;
    return pickOption(raw, opts) || "UNKNOWN";
  });
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
  if (req.method === "GET" && req.url === "/health") { send(res, 200, { ok: true, model: DEEPSEEK_MODEL, key: hasDeepSeekKey() }); return; }
  if (req.method === "POST" && req.url === "/answer") {
    try {
      const { profile = {}, questions = [] } = JSON.parse((await readBody(req)) || "{}");
      if (!questions.length) { send(res, 200, { answers: [] }); return; }
      const t0 = Date.now();
      const answers = await answer(profile, questions);
      console.log(`[answer] ${questions.length} q in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      send(res, 200, { answers });
    } catch (err) { console.error("[answer]", err.message); send(res, 500, { error: String(err.message || err) }); }
    return;
  }
  // Feedback loop — record a callback outcome for a previously logged application.
  if (req.method === "POST" && req.url === "/outcome") {
    try {
      const { id = "", callback } = JSON.parse((await readBody(req)) || "{}");
      if (!String(id).trim()) { send(res, 400, { error: "id is required" }); return; }
      if (typeof callback !== "boolean") { send(res, 400, { error: "callback must be true or false" }); return; }
      const r = recordOutcome(id, callback);
      if (!r.ok) { send(res, 404, r); return; }
      console.log(`[outcome] ${id} → callback=${r.callback}`);
      send(res, 200, r);
    } catch (err) { console.error("[outcome]", err.message); send(res, 500, { error: String(err.message || err) }); }
    return;
  }
  // Résumé tailoring — JD in → text-only paragraph edits + ranked keywords + a highlighted
  // review PDF (all accepted edits pre-applied). The .docx styling is never touched by the model.
  if (req.method === "POST" && req.url === "/tailor") {
    try {
      const { jd = "" } = JSON.parse((await readBody(req)) || "{}");
      if (!String(jd).trim()) { send(res, 400, { error: "jd is required" }); return; }
      if (!canRenderPdf()) { send(res, 500, { error: "LibreOffice (soffice) not found — needed for PDF preview" }); return; }
      const t0 = Date.now();
      const r = await tailor(jd);
      // Initial preview reflects every accepted edit, highlighted for review.
      const applied = r.edits.map((e) => ({ id: e.id, text: e.new_text }));
      let preview = { pdf_base64: "", pages: 0 };
      const dir = mkdtempSync(path.join(tmpdir(), "tailor-init-"));
      try { preview = buildAndRender(applied, path.join(dir, "preview.docx"), { highlight: true }); }
      finally { rmSync(dir, { recursive: true, force: true }); }
      console.log(`[tailor] ${r.edits.length} edits, ${r.keywords.length} kw in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      send(res, 200, { ...r, ...preview });
    } catch (err) { console.error("[tailor]", err.message); send(res, 500, { error: String(err.message || err) }); }
    return;
  }
  // Re-render the highlighted review PDF for the human's current edit state (live preview).
  if (req.method === "POST" && req.url === "/tailor/preview") {
    try {
      const { edits = [] } = JSON.parse((await readBody(req)) || "{}");
      if (!canRenderPdf()) { send(res, 500, { error: "LibreOffice (soffice) not found" }); return; }
      const dir = mkdtempSync(path.join(tmpdir(), "tailor-prev-"));
      try { send(res, 200, buildAndRender(toEdits(edits), path.join(dir, "preview.docx"), { highlight: true })); }
      finally { rmSync(dir, { recursive: true, force: true }); }
    } catch (err) { console.error("[tailor/preview]", err.message); send(res, 500, { error: String(err.message || err) }); }
    return;
  }
  // Save the final résumé: clean styled .docx to applier/tailored/, plus the clean PDF (base64)
  // for Autofill to attach to form résumé fields. `filename` (from the review modal's name box)
  // wins over the auto "Name - Company - date" template.
  if (req.method === "POST" && req.url === "/tailor/save") {
    try {
      const { edits = [], company = "", filename: nameOverride = "" } = JSON.parse((await readBody(req)) || "{}");
      if (!canRenderPdf()) { send(res, 500, { error: "LibreOffice (soffice) not found" }); return; }
      mkdirSync(TAILORED_DIR, { recursive: true });
      // The review modal names the file (it's what the recruiter sees); fall back to the
      // Company/date template when nothing was typed.
      const chosen = safe(String(nameOverride).replace(/\.(pdf|docx)$/i, ""));
      const filename = chosen ? `${chosen}.docx` : outputName(company);
      const destDocx = path.join(TAILORED_DIR, filename);
      const destPdf = destDocx.replace(/\.docx$/i, ".pdf");
      const rendered = buildAndRender(toEdits(edits), destDocx, { highlight: false, keepPdfAt: destPdf });
      if (rendered.pages > 1) console.warn(`[tailor/save] WARNING: ${filename} rendered ${rendered.pages} pages`);
      console.log(`[tailor/save] wrote ${destDocx} (${rendered.pages}p)`);
      send(res, 200, { ...rendered, filename, docx_path: destDocx, pdf_path: destPdf });
    } catch (err) { console.error("[tailor/save]", err.message); send(res, 500, { error: String(err.message || err) }); }
    return;
  }
  // Default résumé — the un-tailored PDF Autofill falls back to when no tailored one is cached.
  if (req.method === "GET" && req.url === "/default-resume") {
    try {
      if (!existsSync(DEFAULT_RESUME)) { send(res, 404, { error: `default résumé not found at ${DEFAULT_RESUME}` }); return; }
      send(res, 200, { name: path.basename(DEFAULT_RESUME), type: "application/pdf", b64: readFileSync(DEFAULT_RESUME).toString("base64") });
    } catch (err) { console.error("[default-resume]", err.message); send(res, 500, { error: String(err.message || err) }); }
    return;
  }
  // Pre-built résumé picker — list the per-title PDFs under RESUME_ROOT so the user can attach one
  // as-is (no tailoring). Returns folder/name/rel; the client fetches the chosen one via /resume.
  if (req.method === "GET" && req.url === "/resumes") {
    try {
      if (!existsSync(RESUME_ROOT)) { send(res, 404, { error: `résumé root not found: ${RESUME_ROOT}` }); return; }
      send(res, 200, { root: RESUME_ROOT, resumes: listResumes() });
    } catch (err) { console.error("[resumes]", err.message); send(res, 500, { error: String(err.message || err) }); }
    return;
  }
  // Fetch one picked résumé PDF as base64. `rel` is confined to RESUME_ROOT (no path traversal)
  // and must be a .pdf — the client caches the result exactly like a tailored résumé.
  if (req.method === "GET" && req.url.startsWith("/resume?")) {
    try {
      const rel = new URL(req.url, "http://x").searchParams.get("rel") || "";
      const root = path.resolve(RESUME_ROOT);
      const abs = path.resolve(root, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) { send(res, 400, { error: "path outside résumé root" }); return; }
      if (!abs.toLowerCase().endsWith(".pdf")) { send(res, 400, { error: "not a pdf" }); return; }
      if (!existsSync(abs)) { send(res, 404, { error: `not found: ${rel}` }); return; }
      send(res, 200, { name: path.basename(abs), type: "application/pdf", b64: readFileSync(abs).toString("base64") });
    } catch (err) { console.error("[resume]", err.message); send(res, 500, { error: String(err.message || err) }); }
    return;
  }
  // ── WYSIWYG editor ────────────────────────────────────────────────────────────
  // The page itself: open http://127.0.0.1:8787/wysiwyg
  if (req.method === "GET" && (req.url === "/wysiwyg" || req.url.startsWith("/wysiwyg?"))) {
    try {
      const html = readFileSync(path.join(HERE, "wysiwyg.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    } catch (err) { console.error("[wysiwyg]", err.message); send(res, 500, { error: String(err.message || err) }); }
    return;
  }
  // The résumé as editable HTML — real page geometry, one contenteditable span per <w:t>.
  if (req.method === "GET" && req.url.startsWith("/wysiwyg/doc")) {
    try {
      const key = new URL(req.url, "http://x").searchParams.get("src") || "master";
      const srcPath = resolveSource(key);
      const doc = renderEditable(srcPath);
      send(res, 200, {
        ...doc,
        src: key === "" ? "master" : key,
        sources: editorSources(),
        suggested_name: outputName("").replace(/\.docx$/i, ""),
      });
    } catch (err) { console.error("[wysiwyg/doc]", err.message); send(res, 400, { error: String(err.message || err) }); }
    return;
  }
  // Ground truth: render the current edit state through LibreOffice, exactly as saving would.
  if (req.method === "POST" && req.url === "/wysiwyg/preview") {
    try {
      const { src = "master", edits = {} } = JSON.parse((await readBody(req)) || "{}");
      if (!canRenderPdf()) { send(res, 500, { error: "LibreOffice (soffice) not found — needed for PDF rendering" }); return; }
      const dir = mkdtempSync(path.join(tmpdir(), "wys-prev-"));
      try { send(res, 200, renderEdited(resolveSource(src), edits, path.join(dir, "preview.docx"))); }
      finally { rmSync(dir, { recursive: true, force: true }); }
    } catch (err) { console.error("[wysiwyg/preview]", err.message); send(res, 500, { error: String(err.message || err) }); }
    return;
  }
  // Save under a new name: applier/tailored/<name>.pdf (+ the .docx it was rendered from, which
  // is what you re-open to edit again — a PDF alone can't be edited losslessly).
  if (req.method === "POST" && req.url === "/wysiwyg/save") {
    try {
      const { src = "master", edits = {}, name = "", overwrite = false } = JSON.parse((await readBody(req)) || "{}");
      if (!canRenderPdf()) { send(res, 500, { error: "LibreOffice (soffice) not found" }); return; }
      const base = safe(String(name).replace(/\.(pdf|docx)$/i, ""));
      if (!base) { send(res, 400, { error: "name is required" }); return; }
      const srcPath = resolveSource(src);
      mkdirSync(TAILORED_DIR, { recursive: true });
      const destDocx = path.join(TAILORED_DIR, `${base}.docx`);
      const destPdf = path.join(TAILORED_DIR, `${base}.pdf`);
      if (!overwrite && (existsSync(destPdf) || existsSync(destDocx))) {
        send(res, 409, { error: `"${base}" already exists in tailored/` });
        return;
      }
      const r = renderEdited(srcPath, edits, destDocx, destPdf);
      if (r.pages > 1) console.warn(`[wysiwyg/save] WARNING: ${base} rendered ${r.pages} pages`);
      console.log(`[wysiwyg/save] ${r.changed} edits → ${destPdf} (${r.pages}p)`);
      send(res, 200, { ...r, name: base, pdf_path: destPdf, docx_path: destDocx, src_key: `tailored/${base}.docx` });
    } catch (err) { console.error("[wysiwyg/save]", err.message); send(res, 500, { error: String(err.message || err) }); }
    return;
  }
  // 🔍 Probe — a structural DOM snapshot from the userscript (no field values, by design):
  // how the form in front of you is actually built. Written to applier/probes/ so an
  // unsupported flow (LinkedIn Easy Apply's multi-step modal, an odd ATS) can be implemented
  // against real markup. One file per probe, named <host>-<timestamp>.json.
  if (req.method === "POST" && req.url === "/probe") {
    try {
      const { snapshot } = JSON.parse((await readBody(req)) || "{}");
      if (!snapshot || typeof snapshot !== "object") { send(res, 400, { error: "snapshot is required" }); return; }
      mkdirSync(PROBES_DIR, { recursive: true });
      const host = safe(String(snapshot.host || "page")).replace(/\s+/g, "") || "page";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const file = `${host}-${stamp}.json`;
      writeFileSync(path.join(PROBES_DIR, file), JSON.stringify(snapshot, null, 2));
      console.log(`[probe] ${file} — ${(snapshot.fields || []).length} fields, ${(snapshot.files || []).length} uploads, dialog: ${snapshot.dialog ? snapshot.dialog.heading || "yes" : "none"}`);
      send(res, 200, { ok: true, file, dir: PROBES_DIR });
    } catch (err) { console.error("[probe]", err.message); send(res, 500, { error: String(err.message || err) }); }
    return;
  }
  // Feedback loop — the "what to learn next" table: gap keywords ranked by cost + callback stats.
  if (req.method === "GET" && req.url === "/insights") {
    try { send(res, 200, insights()); }
    catch (err) { console.error("[insights]", err.message); send(res, 500, { error: String(err.message || err) }); }
    return;
  }
  send(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`applier LLM proxy → http://127.0.0.1:${PORT}  (model: ${DEEPSEEK_MODEL}, key: ${hasDeepSeekKey() ? "set" : "MISSING"})`);
});

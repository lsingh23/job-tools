// Résumé tailoring for Path A: patch the master .docx in place (summary + skills +
// experience bullets), then render to PDF via LibreOffice headless so the master's exact
// design is preserved. AGGRESSIVE "swap, don't append" MODE (by request): the AI swaps the
// JD's keywords into skills / summary / bullets whether or not the master backs them — the
// old honesty intersection is gone. To stay one page, injection is by REPLACEMENT: each
// skills category is capped at the master's item count, and a bullet edit is applied only
// when the revised text is no longer than the original.
//
//   tailorResume({ jd, company, title })
//     jd === ""  → "master mode": no AI, just convert the master docx → PDF (cached).
//     jd  = text → tailor summary + skills to the JD, save a timestamped copy.
//
// Zero npm deps: a .docx is a zip, so we patch word/document.xml with the system
// unzip/zip. LibreOffice must be installed (see README / --version check).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deepseekChat } from "../applier/deepseek.mjs";
import { rankBullets, hasMetric, callbackScore } from "./recruiter.mjs";
import { buildIdf, vectorize, cosine, resumeJdCosine } from "./relevance.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Local prompt loader (this module is archived under legacy/; the tailor prompt lives
// beside it as legacy/tailor.txt). Reads fresh each call and substitutes {{KEY}} tokens.
function loadPrompt(name, vars = {}) {
  let text = readFileSync(path.join(HERE, `${name}.txt`), "utf8");
  for (const [k, v] of Object.entries(vars)) text = text.split(`{{${k}}}`).join(String(v));
  return text.trim();
}

const MASTER  = process.env.MASTER_RESUME ?? path.join(HERE, "..", "applier", "master-resume.docx");
const OUTDIR  = process.env.TAILORED_DIR  ?? path.join(HERE, "tailored");
const SOFFICE = process.env.SOFFICE       ?? "/Applications/LibreOffice.app/Contents/MacOS/soffice";

// ── docx zip I/O ──────────────────────────────────────────────────────────────
const DOC_ENTRY = "word/document.xml";

export function readDocumentXml(docxPath) {
  const dir = mkdtempSync(path.join(tmpdir(), "tailor-read-"));
  try {
    execFileSync("unzip", ["-o", docxPath, DOC_ENTRY, "-d", dir], { stdio: "ignore" });
    return readFileSync(path.join(dir, DOC_ENTRY), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write a copy of master with a patched document.xml. Returns the new .docx path. */
export function writePatchedDocx(masterPath, newXml, destDocx) {
  const dir = mkdtempSync(path.join(tmpdir(), "tailor-write-"));
  try {
    copyFileSync(masterPath, destDocx);              // preserve every other entry as-is
    mkdirSync(path.join(dir, "word"), { recursive: true });
    writeFileSync(path.join(dir, DOC_ENTRY), newXml, "utf8");
    execFileSync("zip", ["-q", destDocx, DOC_ENTRY], { cwd: dir }); // updates just that entry
    return destDocx;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function docxToPdf(docxPath, outDir) {
  execFileSync(SOFFICE, ["--headless", "--convert-to", "pdf", "--outdir", outDir, docxPath], { stdio: "ignore" });
  const pdf = path.join(outDir, path.basename(docxPath).replace(/\.docx$/i, ".pdf"));
  if (!existsSync(pdf)) throw new Error("LibreOffice did not produce a PDF (is it installed at " + SOFFICE + "?)");
  return pdf;
}

/** Page count of a PDF (reads the /Pages /Count, falls back to counting /Type /Page). */
export function pdfPageCount(pdfPath) {
  const buf = readFileSync(pdfPath, "latin1");
  const m = buf.match(/\/Type\s*\/Pages\b[\s\S]*?\/Count\s+(\d+)/);
  if (m) return Number(m[1]);
  return (buf.match(/\/Type\s*\/Page\b(?!s)/g) || []).length || 1;
}

// ── XML helpers ───────────────────────────────────────────────────────────────
const xmlEsc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xmlUnesc = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/** All <w:p>…</w:p> paragraphs (non-self-closing) with their plain text. */
function paragraphs(xml) {
  const out = [];
  const re = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(xml))) {
    const p = m[0];
    const text = xmlUnesc((p.match(/<w:t[^>]*>[\s\S]*?<\/w:t>/g) ?? [])
      .map((t) => t.replace(/<[^>]+>/g, "")).join(""));
    out.push({ xml: p, text });
  }
  return out;
}

const openTag = (p) => p.match(/^<w:p(?:\s[^>]*)?>/)[0];
const pPr     = (p) => (p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) ?? [""])[0];
const firstRun = (p) => (p.match(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/) ?? [""])[0];
/** rPr of the first run, or of the run at a given occurrence index (0-based). */
function runRpr(p, idx = 0) {
  const runs = p.match(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g) ?? [];
  const r = runs[idx] ?? runs[0] ?? "";
  return (r.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) ?? [""])[0];
}
const buildRun = (rPrXml, text) =>
  `<w:r>${rPrXml}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;

/** Split a comma list but keep commas inside (parentheses) together. */
function splitSkills(list) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const normSkill = (s) => s.toLowerCase().replace(/[\s.\-/]/g, "");

// ── whitelist gate (skills.md) ────────────────────────────────────────────────
// SKILLS lines claim "I know this", so every token the AI proposes must be named in the
// candidate's whitelist (skills.md) or somewhere in the master resume itself. Tokens that
// fail are dropped and reported in patch.blockedSkills — the structural guard against
// fabricated skills, like SCOPE_WORDS is for the summary.
const WHITELIST_FILE = process.env.SKILLS_WHITELIST ?? path.join(HERE, "skills.md");
export function loadWhitelist() {
  try { return readFileSync(WHITELIST_FILE, "utf8").trim(); } catch { return ""; }
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Word-ish boundary match that tolerates tokens ending in non-word chars ("C++", "CI/CD").
const namedIn = (needle, hay) => new RegExp(`(^|[^A-Za-z0-9])${escRe(needle)}($|[^A-Za-z0-9])`, "i").test(hay);

// Alias groups: alternate spellings / abbreviations that denote the SAME skill. These
// close the gap where a JD writes "Postgres" / "K8s" / "TS" for a skill the candidate has
// listed under its canonical name. An alias never bypasses the honesty gate — it only
// passes when SOME member of its group is genuinely in the whitelist/master, so an alias
// with no owned member (there is none for "Go", "Rust", …) still blocks. Only true
// synonyms belong in a group; never merge distinct skills (e.g. Java vs JavaScript).
const SKILL_ALIASES = [
  ["PostgreSQL", "Postgres", "Postgre SQL"],
  ["MongoDB", "Mongo"],
  ["MySQL", "My SQL"],
  ["Kubernetes", "K8s"],
  ["JavaScript", "JS"],
  ["TypeScript", "TS"],
  ["Node.js", "Node", "NodeJS"],
  ["Next.js", "NextJS", "Next"],
  ["React.js", "ReactJS", "React"],
  ["Vue.js", "VueJS", "Vue"],
  ["GitHub Actions", "GH Actions"],
  ["GitHub", "GH"],
  ["CI/CD", "CICD"],
  ["REST APIs", "REST API", "RESTful", "RESTful APIs"],
  ["AWS", "Amazon Web Services"],
  ["GCP", "Google Cloud", "Google Cloud Platform"],
  ["Azure", "Microsoft Azure"],
  ["Tailwind CSS", "Tailwind", "TailwindCSS"],
  ["Material UI", "MUI"],
  ["Internationalization", "i18n"],
  ["End-to-end testing", "E2E testing", "E2E"],
  ["Test-Driven Development", "TDD"],
  ["RBAC", "Role-based access control"],
  ["Server-Sent Events", "SSE"],
  ["Infrastructure as Code", "IaC"],
  ["Progressive Web Apps", "PWA"],
  ["WebSockets", "WebSocket"],
  ["Multi-tenant architecture", "Multi-tenant", "Multitenant", "Multi-tenancy", "Multitenancy"],
  ["GraphQL", "Graph QL"],
  ["Google Cloud (GCP)", "GCP", "Google Cloud", "Google Cloud Platform"],
];

// normalized spelling -> Set of every normalized spelling in its alias group.
const ALIAS_INDEX = (() => {
  const index = new Map();
  for (const group of SKILL_ALIASES) {
    const norm = group.map(normSkill).filter(Boolean);
    for (const n of norm) {
      const set = index.get(n) ?? new Set();
      for (const m of norm) set.add(m);
      index.set(n, set);
    }
  }
  return index;
})();

// Normalized forms a skill string contributes: its plain form, its pre-parenthetical part,
// and each parenthetical alias — so "Material UI (MUI)" yields both "materialui" and "mui",
// and "TanStack Query (React Query)" yields "tanstackquery" and "reactquery".
function normForms(entry) {
  const forms = new Set();
  const add = (s) => { const n = normSkill(s); if (n) forms.add(n); };
  add(entry.replace(/[()]/g, " "));            // whole string, parens neutralized
  add(entry.replace(/\([^)]*\)/g, " "));       // part outside any parentheses
  for (const m of entry.matchAll(/\(([^)]*)\)/g)) add(m[1]); // each parenthetical
  return forms;
}

/**
 * Returns allow(token) → boolean, or null when no whitelist file exists (gate disabled).
 * A token passes if it (A) appears verbatim (word-boundaried) in the whitelist/master, (B)
 * contains a whitelist entry ("CI/CD" inside "CI/CD pipelines"), (C) normalizes to a skill
 * the candidate lists (so "NextJS" matches "Next.js"), or (D) is a known alias/abbreviation
 * of one ("Postgres"→PostgreSQL, "K8s"→Kubernetes). Bare fabrications ("Go", "Scala") match
 * none of these and stay blocked.
 */
export function makeSkillGate(whitelist, masterText = "") {
  if (!whitelist.trim()) return null;
  const hay = `${whitelist}\n${masterText}`;
  const entries = splitSkills(whitelist);
  // Every normalized skill the candidate genuinely lists — whitelist entries plus master
  // skill tokens, each expanded via normForms (plain name + any parenthetical alias).
  const known = new Set();
  for (const e of [...entries, ...splitSkills(masterText.replace(/\n/g, ","))]) {
    for (const f of normForms(e)) known.add(f);
  }
  return (tok) => {
    const t = String(tok ?? "").trim();
    if (!t) return false;
    if (namedIn(t, hay)) return true;                    // (A) verbatim
    if (entries.some((w) => namedIn(w, t))) return true; // (B) whitelist entry inside token
    for (const f of normForms(t)) {
      if (known.has(f)) return true;                     // (C) normalized equality
      const group = ALIAS_INDEX.get(f);                  // (D) alias of a known skill
      if (group) for (const g of group) if (known.has(g)) return true;
    }
    return false;
  };
}

// Scope/ownership qualifiers that must survive a summary swap. A {find, replace} whose
// `find` contains one of these but whose `replace` drops it is rejected — this is what
// stops "…led a … module" from being inflated into "…built a … platform".
const SCOPE_WORDS = [
  "module", "modules", "part", "parts", "contributed", "helped", "assisted",
  "earlier", "supported", "prototype", "poc", "proof-of-concept", "intern",
];
// Distinctive, credibility-carrying terms that must survive a summary swap even though they
// aren't scope qualifiers. A recruiter remembers "dual-control on a FedWire-certified
// platform"; trading it for a generic "RBAC" is a downgrade, not a rename. A swap whose
// `find` contains one of these but whose `replace` drops it is rejected.
const PRESERVE_TERMS = [
  "dual-control", "FedWire", "FedWire-certified", "founding", "end-to-end",
  "WebContainers", "from zero",
];
const hasWord = (text, w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
const dropsScopeWord = (find, replace) =>
  [...SCOPE_WORDS, ...PRESERVE_TERMS].some((w) => hasWord(find, w) && !hasWord(replace, w));

/**
 * Anchored, validated summary: the tailored summary is the MASTER summary with a list of
 * {find, replace} keyword swaps applied — never free-form prose. Each `find` must appear
 * verbatim in the master, must not drop a scope qualifier (SCOPE_WORDS), and the result
 * must stay within `maxLen`. Anything else is skipped. Because every non-swapped span is
 * the master's own words, the AI cannot invent or enlarge a claim — overclaiming is
 * structurally impossible, not merely discouraged.
 */
export function applySummaryEdits(master, edits, maxLen = master.length) {
  let out = master;
  const applied = [];
  const skipped = [];
  for (const e of Array.isArray(edits) ? edits : []) {
    const find = String(e?.find ?? "").trim();
    const replace = String(e?.replace ?? "").trim();
    if (!find || !replace) { skipped.push({ find, replace, reason: "empty" }); continue; }
    if (find === replace)  { skipped.push({ find, replace, reason: "unchanged" }); continue; }
    if (!out.includes(find)) { skipped.push({ find, replace, reason: "no-match" }); continue; }
    if (dropsScopeWord(find, replace)) { skipped.push({ find, replace, reason: "drops-scope-word" }); continue; }
    const candidate = out.replace(find, replace);
    if (candidate.length > maxLen) { skipped.push({ find, replace, reason: "too-long" }); continue; }
    out = candidate;
    applied.push({ find, replace });
  }
  return { summary: out, applied, skipped };
}

/**
 * Keep the tailored summary no longer than the master's, so the rendered page
 * count can never grow (skills lines are already bounded — the honesty filter
 * only ever keeps a subset of master tokens). If the AI overshoots the budget,
 * trim whole sentences from the end; if even the first sentence is too long,
 * fall back to the master summary (guaranteed to fit, since the master is 1 page).
 */
export function fitSummary(tailored, master) {
  const budget = master.length;
  if (tailored.length <= budget) return tailored;
  // Non-greedy "any char" (so periods inside abbreviations like "Next.js" don't
  // count as sentence boundaries) up to a terminator actually followed by
  // whitespace or end of string.
  const sentences = tailored.match(/\S.*?[.!?](?=\s|$)/g) || [tailored];
  let out = "";
  for (const s of sentences) {
    const next = out ? out + " " + s : s;
    if (next.trim().length > budget) break;
    out = next;
  }
  out = out.trim();
  return out || master;
}

/**
 * Aggressive "swap, don't append" mode: take the AI's proposed list (it injects the JD's
 * keywords whether or not the master backs them), de-duplicated and in the AI's order
 * (JD must-haves first), keeping the AI's JD-exact spelling. Capped at the MASTER's item
 * count so the skill line never grows longer than the master's — this is the one-page
 * guard for skills. Falls back to the master list when the AI returns nothing.
 */
function mergeSkills(masterList, aiList, allow = null) {
  const master = splitSkills(masterList);
  const masterKeys = new Set(master.map(normSkill));
  const seen = new Set();
  const kept = [];
  const blocked = [];
  for (const tok of splitSkills(aiList)) {
    const key = normSkill(tok);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // Master tokens are ground truth; anything else must pass the whitelist gate.
    if (allow && !masterKeys.has(key) && !allow(tok)) { blocked.push(tok.trim()); continue; }
    kept.push(tok.trim());
  }
  const out = kept.length ? kept : master;
  // One-page guard, two ways: cap the ITEM COUNT at the master's, then cap the CHARACTER
  // WIDTH at the master line's — injecting the JD's (often longer) exact spellings can widen a
  // line past its row even at equal item count, which wraps and spills the page. The skills
  // lines are never touched by the render/repair rollback loop, so this is their only guard.
  // Items are already JD-priority-first, so trimming from the end drops the least relevant.
  let capped = out.slice(0, master.length);
  const budget = masterList.trim().length;
  while (capped.length > 1 && capped.join(", ").length > budget) capped.pop();
  return { merged: capped.join(", "), blocked };
}

// Normalize smart quotes / dashes / whitespace so an AI-echoed bullet still matches the
// master paragraph it was copied from (used to locate experience_edits).
const normText = (s) => s
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

// ── experience role/bullet classification (for reordering) ─────────────────────
// A role header line: "COMPANY | Title | Remote | LocationMon YYYY – …". Detected by pipe
// count (every header has 3 " | " separators; bullets have none) — robust to the master's
// location/date concatenation ("OntarioDec 2024") and open-ended "… – Present" ranges, both
// of which defeat a date regex.
const isHeaderLine = (t) => (t.match(/\|/g) || []).length >= 2;
const isStackLine  = (t) => /^\s*Stack\s*:/i.test(t);
// A context/lead line that sets the scene for a role (e.g. "WITS: a FedWire-certified…") —
// starts with a short capitalized label + colon and isn't the Stack line. Pinned first.
const isLeadLine   = (t) => /^[A-Z][\w.&+/-]*\s*:/.test(t.trim()) && !isStackLine(t);

// ── read the master's current summary + skills (source of truth for the AI) ────
export function extractSections(xml) {
  const paras = paragraphs(xml);
  const idx = (label) => paras.findIndex((p) => p.text.trim().toUpperCase() === label);
  const iSummary = idx("SUMMARY");
  const iSkills  = idx("SKILLS");
  const iExp     = paras.findIndex((p) => /^WORK EXPERIENCE\b/i.test(p.text.trim()));
  if (iSummary < 0 || iSkills < 0 || iExp < 0)
    throw new Error("master-resume.docx: could not find SUMMARY / SKILLS / WORK EXPERIENCE headings");

  const summaryPara = paras[iSummary + 1];
  const skillParas = paras.slice(iSkills + 1, iExp).filter((p) => p.text.includes(":"));
  const skills = skillParas.map((p) => {
    const i = p.text.indexOf(":");
    return { label: p.text.slice(0, i).trim(), list: p.text.slice(i + 1).trim(), para: p };
  });

  // Experience block (verbatim lines) — fed to the AI so it can copy bullet "original"
  // text exactly. Ends at EDUCATION if present, else runs to the end of the document.
  const iEdu = paras.findIndex((p) => /^EDUCATION\b/i.test(p.text.trim()));
  const expEnd = iEdu > iExp ? iEdu : paras.length;
  // Non-empty experience paragraphs, in order. Their 1-based index here is exactly the
  // "id" the AI sees ([N] prefix), so ids line up between prompt, edits, and reordering.
  const expParas = paras.slice(iExp + 1, expEnd).filter((p) => p.text.trim());
  const experience = expParas.map((p) => p.text);

  // Group into roles for reordering: header starts a role; the Stack line and an optional
  // lead/context line are pinned anchors; everything else is a reorderable achievement bullet.
  const roles = [];
  let cur = null;
  expParas.forEach((p, i) => {
    const id = i + 1;
    const t = p.text.trim();
    const entry = { ...p, id, text: p.text };
    if (isHeaderLine(t)) { cur = { headerPara: entry, leadPara: null, bulletParas: [], stackPara: null }; roles.push(cur); }
    else if (!cur) { /* stray pre-header line — ignore */ }
    else if (isStackLine(t)) { cur.stackPara = entry; }
    else if (isLeadLine(t) && cur.bulletParas.length === 0) { cur.leadPara = entry; }
    else { cur.bulletParas.push(entry); }
  });
  roles.forEach((r, i) => { r.mostRecent = i === 0; });

  return { paras, summaryPara, skills, experience, roles };
}

// ── DeepSeek: master sections + JD → tailored delta ────────────────────────────
// `onEvent`, if given, receives {type:"prompt", system, user} before the call, then
// {type:"delta", text} for each streamed token — lets a caller mirror the exact AI
// input/output live (see server.mjs /tailor and the userscript's AI debug modal).
async function askDeepSeek(masterSummary, masterSkills, masterExperience, jd, onEvent) {
  const system = loadPrompt("tailor", {
    SUMMARY_MAX: masterSummary.length,
    WHITELIST: loadWhitelist() ||
      "(no skills.md whitelist found — treat the master resume's own skills as the whitelist)",
  });

  const user =
    `MASTER SUMMARY:\n${masterSummary}\n\n` +
    `MASTER SKILLS (by category):\n${masterSkills.map((s) => `${s.label}: ${s.list}`).join("\n")}\n\n` +
    `MASTER EXPERIENCE (each line is numbered — reference the line you edit by its "id"):\n` +
    `${masterExperience.map((t, i) => `[${i + 1}] ${t}`).join("\n")}\n\n` +
    `JOB DESCRIPTION:\n${jd.slice(0, 6000)}`;

  onEvent?.({ type: "prompt", system, user });

  const content = await deepseekChat({
    system, user, temperature: 0.3, json: true,
    onDelta: onEvent ? (text) => onEvent({ type: "delta", text }) : null,
  });
  let parsed = {};
  try { parsed = JSON.parse(content || "{}"); } catch { /* keep {} */ }
  return parsed;
}

// ── filename ──────────────────────────────────────────────────────────────────
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
const slug = (s, fallback) => (String(s || "").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || fallback);

// ── pure patch: master document.xml + delta → patched xml (design untouched) ────
// Exported for offline testing. `summary` is the new paragraph text; `aiSkills`
// maps category label → the AI's proposed list (reconciled against the master).
export function patchDocumentXml(xml, { summary, aiSkills = {}, edits = [], growthBudget = 2, allowSkill = null }) {
  const { summaryPara, skills } = extractSections(xml);
  let patched = xml;
  const patch = { summary, skills: {}, blockedSkills: {}, edits: [], skipped: [] };

  // SUMMARY: collapse to one run, keep the paragraph + first-run formatting.
  {
    const p = summaryPara.xml;
    const rebuilt = openTag(p) + pPr(p) + buildRun(runRpr(p, 0), summary) + "</w:p>";
    patched = patched.replace(p, rebuilt);
  }

  // SKILLS: per line, keep the bold "Label:" run, replace the list after it.
  for (const s of skills) {
    const { merged, blocked } = mergeSkills(s.list, aiSkills[s.label] ?? "", allowSkill);
    patch.skills[s.label] = merged;
    if (blocked.length) patch.blockedSkills[s.label] = blocked;
    const p = s.para.xml;
    const label = firstRun(p);                    // bold "Frontend:" etc.
    const listRun = buildRun(runRpr(p, 1), " " + merged);
    const rebuilt = openTag(p) + pPr(p) + label + listRun + "</w:p>";
    patched = patched.replace(p, rebuilt);
  }

  // BULLETS: locate each edit's "original" among the current paragraphs (normalized
  // match) and swap in the revised text, preserving the paragraph's list/run formatting.
  for (const e of edits) {
    const original = String(e?.original ?? "").trim();
    const revised  = String(e?.revised  ?? "").trim();
    if (!original || !revised) { patch.skipped.push({ original, revised, reason: "empty" }); continue; }
    if (revised === original)  { patch.skipped.push({ original, revised, reason: "unchanged" }); continue; }
    const growth = revised.length - original.length;
    // Growth must stay within budget; the caller's render/repair loop enforces the true
    // one-page guarantee, so this is just a coarse pre-filter, not the final gate.
    if (growth > growthBudget) {
      patch.skipped.push({ original, revised, reason: `too-long(+${growth})`, growth });
      continue;
    }
    const target = paragraphs(patched).find((p) => normText(p.text) === normText(original));
    if (!target) { patch.skipped.push({ original, revised, reason: "no-match" }); continue; }
    const p = target.xml;
    const rebuilt = openTag(p) + pPr(p) + buildRun(runRpr(p, 0), revised) + "</w:p>";
    patched = patched.replace(p, rebuilt);
    patch.edits.push({ original, revised, growth });
  }
  return { patched, patch };
}

// ── recruiter-scan reordering (gate 2) ──────────────────────────────────────────
const byId = (bullets, id) => bullets.find((b) => b.id === id);
const sameSet = (a, b) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;

/**
 * Decide each role's final bullet order (does NOT touch text). Prefers the AI's
 * `experience_order` when it is a valid permutation of that role's reorderable bullet ids
 * (matched by id-set, so the AI's role label never has to line up); otherwise falls back to a
 * deterministic rank by JD relevance + quantified impact. For the most-recent role it also
 * guarantees the "lead punch": if the first bullet isn't quantified but a later one is, the
 * best quantified bullet is promoted to the front. Returns roles with `orderedBullets` added.
 */
export function planExperience(roles, orderPlan, jd) {
  const plans = (Array.isArray(orderPlan) ? orderPlan : [])
    .map((r) => (Array.isArray(r?.order) ? r.order.map(Number).filter(Number.isInteger) : null))
    .filter((p) => p && p.length);
  return roles.map((role) => {
    const bullets = role.bulletParas;
    if (bullets.length < 2) return { ...role, orderedBullets: bullets };
    const ids = bullets.map((b) => b.id);
    const plan = plans.find((pl) => sameSet(pl, ids));
    let orderIds = plan ? plan.slice() : rankBullets(bullets.map((b) => ({ id: b.id, text: b.text })), jd).map((r) => r.id);
    if (role.mostRecent && !hasMetric(byId(bullets, orderIds[0]).text)) {
      const firstMetric = orderIds.find((id) => hasMetric(byId(bullets, id).text));
      if (firstMetric != null) orderIds = [firstMetric, ...orderIds.filter((id) => id !== firstMetric)];
    }
    return { ...role, orderedBullets: orderIds.map((id) => byId(bullets, id)) };
  });
}

/** Reorder the <w:p> blocks of each role's bullets in `xml` to match orderedBullets,
 *  preserving inter-paragraph separators. Length-neutral, so page count is unaffected. */
export function applyReorder(xml, orderedRoles) {
  let out = xml;
  for (const role of orderedRoles) {
    const bullets = role.bulletParas;
    if (bullets.length < 2) continue;
    const blocks = bullets.map((b) => b.xml);                       // document order
    const order = role.orderedBullets.map((ob) => bullets.findIndex((b) => b.id === ob.id));
    if (order.some((i) => i < 0) || sameSet(order, order.map((_, i) => i)) === false) continue;
    if (order.every((v, i) => v === i)) continue;                   // already in order
    out = reorderBlocks(out, blocks, order);
  }
  return out;
}

/** Replace the run of paragraph blocks [blocks[0]..blocks[n-1]] with the same blocks in
 *  `order`, keeping whatever separators sat between them. Bails (returns xml unchanged) if
 *  any block can't be located, so a parsing surprise can never corrupt the document. */
function reorderBlocks(xml, blocks, order) {
  const start = xml.indexOf(blocks[0]);
  const last = blocks[blocks.length - 1];
  const end = xml.indexOf(last) + last.length;
  if (start < 0 || end <= start) return xml;
  const span = xml.slice(start, end);
  const seps = [];
  let cursor = 0;
  for (const b of blocks) {
    const idx = span.indexOf(b, cursor);
    if (idx < 0) return xml;
    seps.push(span.slice(cursor, idx));
    cursor = idx + b.length;
  }
  const trailing = span.slice(cursor);
  let rebuilt = "";
  for (let i = 0; i < order.length; i++) rebuilt += seps[i] + blocks[order[i]];
  return xml.slice(0, start) + rebuilt + trailing + xml.slice(end);
}

// ── gate-1 coverage: which JD keywords can we place, and did we? ─────────────────
/** The JD's own surface spelling of a skill (or a known alias), or null if the JD never
 *  names it. Tolerates simple plural/singular differences (WebSockets↔WebSocket). */
function jdSurfaceForm(entry, jd) {
  const tryMatch = (c) => {
    if (!c || c.length < 2) return null;
    for (const v of new Set([c, c.replace(/s$/i, ""), c + "s"])) {
      if (v.length < 2) continue;
      // Token-complete match: not glued to a letter/digit on either side, AND not the head of
      // a dotted compound (so "React" does NOT match inside "React.js", and ".js" is not a
      // token). "/" still counts as a boundary, so "WebSocket" matches in "WebSocket/Event".
      const m = jd.match(new RegExp(`(?<![A-Za-z0-9.])(${escRe(v)})(?![A-Za-z0-9])(?!\\.[A-Za-z])`, "i"));
      if (m) return m[1];
    }
    return null;
  };
  const candidates = new Set([entry.trim(), entry.replace(/\s*\([^)]*\)/g, "").trim()]);
  for (const m of entry.matchAll(/\(([^)]*)\)/g)) candidates.add(m[1].trim());
  for (const c of candidates) { const s = tryMatch(c); if (s) return s; }
  // known alias spellings (recover the JD's word, e.g. "Multi-tenant" for the whitelist's
  // "Multi-tenant architecture", or "K8s" for "Kubernetes")
  const forms = normForms(entry);
  for (const group of SKILL_ALIASES) {
    if (!group.some((g) => forms.has(normSkill(g)))) continue;
    for (const g of group) { const s = tryMatch(g); if (s) return s; }
  }
  return null;
}

/** Every whitelist/master skill the JD actually names → { canonical, surface, key }. This is
 *  the placeable-keyword universe: gate 1 must land each of these on a skills line, in a
 *  bullet, or the summary — or report it as honestly unplaceable. */
export function extractJdTargets(jd, whitelist, masterSkillText) {
  const seen = new Set();        // by canonical key
  const seenSurface = new Set(); // by JD surface form — collapses "Next.js" (whitelist) and
  const targets = [];            // "Next.js (App Router, RSC)" (master) into one target
  for (const e of [...splitSkills(whitelist), ...splitSkills(masterSkillText.replace(/\n/g, ","))]) {
    const canonical = e.trim();
    const key = normSkill(canonical);
    if (!canonical || seen.has(key)) continue;
    seen.add(key);
    const surface = jdSurfaceForm(canonical, jd);
    if (!surface) continue;
    const sk = normSkill(surface);
    if (seenSurface.has(sk)) continue;
    seenSurface.add(sk);
    targets.push({ canonical, surface, key });
  }
  return targets;
}

/** Babysit the AI's skills: force-inject any placeable JD keyword the AI left off every
 *  skills line, prepended (JD-priority) into its best-fit category so mergeSkills keeps it and
 *  trims the least-relevant master item. Category = best token overlap, else the most
 *  JD-relevant category. Guarantees no genuine JD match is silently dropped from skills. */
// Route a novel JD keyword to a sensible category by matching it to that category's own
// anchor skills — so WebSocket lands with Node/REST, Kubernetes with Docker/CI, Vue with
// React/CSS, instead of the tf-idf fallback scattering them (and evicting a category's own
// tools). Each rule: if the keyword contains any `any` token, prefer the master category
// whose items contain any `anchor` token.
// anchors must be DISTINCTIVE to one category (substring-matched against its items) — avoid
// tokens that appear inside another category's skills, e.g. "api" (Context API) or "java"
// (JavaScript) both live under Frontend, so they can't anchor Backend.
const CATEGORY_HINTS = [
  { any: ["react", "vue", "angular", "svelte", "next", "remix", "tailwind", "responsive", "accessibility", "wcag", "storybook", "framer", "i18n", "pwa"], anchor: ["tailwind", "shadcn", "redux", "html", "css"] },
  { any: ["jest", "vitest", "cypress", "playwright", "selenium", "tdd", "e2e", "testing"], anchor: ["jest", "cypress", "playwright"] },
  { any: ["docker", "kubernetes", "k8s", "jenkins", "cicd", "ci/cd", "terraform", "aws", "gcp", "azure", "nginx", "serverless", "lambda", "cloudflare", "jira", "confluence", "agile", "scrum", "githubactions", "gitlab", "vercel"], anchor: ["docker", "jenkins", "webpack", "agile"] },
  { any: ["websocket", "graphql", "grpc", "rest", "microservice", "multi-tenant", "multitenant", "rbac", "sso", "saml", "oidc", "oauth", "auth", "node", "express", "nestjs", "fastapi", "django", "spring", "postgres", "mysql", "mongo", "redis", "prisma", "drizzle", "kafka", "queue", "python", "webhook", "sse", "event"], anchor: ["node", "express", "postgres", "microservices", "jwt"] },
];

export function augmentSkills(aiSkills, masterSkills, jdTargets, jd, allow = null) {
  const out = { ...aiSkills };
  const labels = masterSkills.map((s) => s.label);
  const catText = Object.fromEntries(masterSkills.map((s) => [s.label, `${s.label} ${s.list}`]));
  const idf = buildIdf([jd, ...labels.map((l) => catText[l])]);
  const jdVec = vectorize(jd, idf);
  const catJdRel = Object.fromEntries(labels.map((l) => [l, cosine(vectorize(catText[l], idf), jdVec)]));

  // Alias-aware "already placed?" test: a target counts as placed if any current skills token
  // is verbatim / normalized / alias-equivalent (so "Next.js" isn't re-injected when the line
  // already has "Next.js (App Router, RSC)"). Rebuilt as we inject so later targets see earlier
  // ones. Falls back to normalized equality if the whitelist gate is unavailable.
  const injected = [];
  const injectedForms = new Set();
  const already = (t) => {
    const gate = makeSkillGate(Object.values(out).join(", ") || " ", "");
    if (gate && (gate(t.surface) || gate(t.canonical))) return true;
    for (const f of normForms(t.surface)) if (injectedForms.has(f)) return true;
    return false;
  };
  const lc = (l) => catText[l].toLowerCase();
  const pickCategory = (t) => {
    const term = `${t.surface} ${t.canonical}`.toLowerCase();
    // 1. Semantic hint: keyword type → category holding a matching anchor skill.
    for (const h of CATEGORY_HINTS) {
      if (!h.any.some((a) => term.includes(a))) continue;
      const cat = labels.find((l) => h.anchor.some((anc) => lc(l).includes(anc)));
      if (cat) return cat;
    }
    // 2. tf-idf token overlap with a category's existing items.
    let best = labels[0], bestScore = -1;
    const tokVec = vectorize(term, idf);
    for (const l of labels) { const sc = cosine(tokVec, vectorize(catText[l], idf)); if (sc > bestScore) { bestScore = sc; best = l; } }
    if (bestScore > 0) return best;
    // 3. Last resort: most JD-relevant category, penalised for how full it already is so a lazy
    //    AI response doesn't pile every injection into one line and evict its master skills.
    const fit = (l) => catJdRel[l] - 0.03 * splitSkills(out[l] ?? "").length;
    return labels.reduce((a, b) => (fit(b) > fit(a) ? b : a), labels[0]);
  };
  for (const t of jdTargets) {
    if (already(t)) continue;
    // Inject a spelling the whitelist gate will accept (mergeSkills re-checks it): prefer the
    // JD's surface, but fall back to the whitelist's canonical when the surface is a variant the
    // gate rejects (e.g. JD "responsive designs" → whitelist "Responsive design").
    const spelling = allow && !allow(t.surface) && allow(t.canonical) ? t.canonical : t.surface;
    const best = pickCategory(t);
    out[best] = spelling + (out[best] ? ", " + out[best] : "");
    for (const f of normForms(spelling)) injectedForms.add(f);
    injected.push({ keyword: spelling, category: best });
  }

  // Protect JD-relevant MASTER skills from the one-line cap: reorder every category so items
  // the JD names (injected terms AND master items like Node.js / PostgreSQL / Microservices)
  // lead, and non-JD master items trail. mergeSkills trims from the end, so it now drops a
  // skill the JD never mentioned before one it asked for.
  const jdGate = makeSkillGate(jdTargets.map((t) => `${t.surface}, ${t.canonical}`).join(", ") || " ", "");
  if (jdGate) {
    for (const label of Object.keys(out)) {
      const toks = splitSkills(out[label] ?? "");
      const hot = toks.filter((t) => jdGate(t));
      const cold = toks.filter((t) => !jdGate(t));
      out[label] = [...hot, ...cold].join(", ");
    }
  }
  return { skills: out, injected };
}

// ── public entry point ─────────────────────────────────────────────────────────
// `aiResponse`, if given, replays a captured model response instead of calling DeepSeek —
// used to render/debug a known delta offline (and to exercise the pipeline without a key).
export async function tailorResume({ jd = "", company = "", title = "", onEvent = null, aiResponse = null } = {}) {
  if (!existsSync(MASTER)) throw new Error(`master resume not found at ${MASTER}`);
  mkdirSync(OUTDIR, { recursive: true });

  // Master mode: no JD → just convert the master, cached. No AI call.
  if (!jd.trim()) {
    onEvent?.({ type: "prompt", system: null, user: null });
    const cached = path.join(OUTDIR, "master.pdf");
    if (!existsSync(cached)) {
      const pdf = docxToPdf(MASTER, OUTDIR);
      if (pdf !== cached) { copyFileSync(pdf, cached); rmSync(pdf, { force: true }); }
    }
    return {
      pdfPath: cached, pdfB64: readFileSync(cached).toString("base64"),
      docxB64: readFileSync(MASTER).toString("base64"), filename: "master.pdf", filenameDocx: "master.docx",
      patch: null, mode: "master",
    };
  }

  const xml = readDocumentXml(MASTER);
  const { paras, summaryPara, skills, experience, roles } = extractSections(xml);

  const ai = aiResponse ?? await askDeepSeek(summaryPara.text, skills, experience, jd, onEvent);

  // Whitelist gate: skills.md plus the master's own text define what "I know this" claims are
  // allowed on skills lines — used both to filter AI skills and to compute the placeable
  // JD-keyword universe (gate-1 coverage).
  const whitelist = loadWhitelist();
  const masterSkillText = skills.map((s) => `${s.label}: ${s.list}`).join("\n");
  const allowSkill = makeSkillGate(
    whitelist,
    [summaryPara.text, masterSkillText, ...experience].join("\n"),
  );

  // Gate 1 — every whitelist/master skill the JD actually names, in the JD's own spelling.
  const jdTargets = extractJdTargets(jd, whitelist, masterSkillText);

  // Babysit the AI's skills: guarantee every placeable JD keyword lands on a skills line
  // (prepended into its best category; mergeSkills then caps count + width).
  const aiSkillsRaw = ai.skills && typeof ai.skills === "object" ? ai.skills : {};
  const { skills: aiSkills, injected: injectedSkills } = augmentSkills(aiSkillsRaw, skills, jdTargets, jd, allowSkill);

  // Gate 2 — decide each role's bullet order (relevance + impact, lead-punch guaranteed) and
  // reorder the paragraphs once. Reorder is length-neutral, so it sits outside the repair loop.
  const orderedRoles = planExperience(roles, ai.experience_order, jd);
  const orderedXml = applyReorder(xml, orderedRoles);

  // Allow both the summary and bullets to grow modestly — most lines have slack at the end
  // of their last row, so a small addition rarely spills a line. The render/repair loop
  // below is the real one-page guard: it re-renders and rolls back the biggest grower
  // (summary swap or bullet) until the PDF is back to one page.
  const GROWTH_BUDGET = 24;
  const summaryMax = summaryPara.text.length + GROWTH_BUDGET;

  // Anchored summary: validate the AI's {find, replace} keyword swaps against the MASTER
  // summary (verbatim spans, no scope-word drops, within budget). These are the swaps
  // eligible to apply; the repair loop may still roll some back. If none are valid the
  // summary stays the master's, so it can never overclaim.
  const summaryValidated = applySummaryEdits(summaryPara.text, ai.summary_edits, summaryMax);
  const summarySwapGrowth = (s) => s.replace.length - s.find.length;

  // Resolve each AI edit to { original, revised }. Prefer the numbered "id" (points into
  // the master experience lines) so a paraphrased "original" can't break the match; fall
  // back to the AI-echoed "original" text for older-format responses.
  const rawEdits = Array.isArray(ai.experience_edits)
    ? ai.experience_edits.flatMap((r) => (Array.isArray(r?.edits) ? r.edits : []))
    : Array.isArray(ai.edits) ? ai.edits : [];
  const resolved = rawEdits.map((e) => {
    let original = typeof e?.original === "string" ? e.original.trim() : "";
    const id = Number(e?.id);
    if ((!original || !experience.includes(original)) && Number.isInteger(id) && experience[id - 1]) {
      original = experience[id - 1];
    }
    return { original, revised: typeof e?.revised === "string" ? e.revised.trim() : "" };
  }).filter((e) => e.original && e.revised);

  const base = `${slug(company, "Resume")}-${slug(title, "Role")}-${stamp()}`;
  const docxPath = path.join(OUTDIR, base + ".docx");

  const render = (summarySwaps, editSubset) => {
    const summary = applySummaryEdits(summaryPara.text, summarySwaps, summaryMax).summary;
    const { patched, patch } = patchDocumentXml(orderedXml, {
      summary, aiSkills, edits: editSubset, growthBudget: GROWTH_BUDGET, allowSkill,
    });
    writePatchedDocx(MASTER, patched, docxPath);
    const pdfPath = docxToPdf(docxPath, OUTDIR);
    return { patch, pdfPath, pages: pdfPageCount(pdfPath), summary };
  };

  let activeSummary = summaryValidated.applied;
  let active = resolved;
  let result = render(activeSummary, active);

  // Repair: while the PDF spills past one page, drop the applied edit that grew the most —
  // whether that's a summary swap or a bullet — and re-render. Bounded by the number of
  // growth edits (typically a handful).
  const rolledBack = [];
  while (result.pages > 1) {
    const bulletGrower = result.patch.edits
      .filter((e) => e.growth > 0)
      .sort((a, b) => b.growth - a.growth)[0];
    const summaryGrower = activeSummary
      .filter((s) => summarySwapGrowth(s) > 0)
      .sort((a, b) => summarySwapGrowth(b) - summarySwapGrowth(a))[0];
    const bg = bulletGrower ? bulletGrower.growth : 0;
    const sg = summaryGrower ? summarySwapGrowth(summaryGrower) : 0;
    if (bg === 0 && sg === 0) break; // nothing grew — can't fix by rollback (master overflowed)

    if (sg >= bg) {
      rolledBack.push({ kind: "summary", ...summaryGrower, growth: sg });
      activeSummary = activeSummary.filter((s) => !(s.find === summaryGrower.find && s.replace === summaryGrower.replace));
    } else {
      rolledBack.push({ kind: "bullet", ...bulletGrower });
      active = active.filter((e) => !(e.original === bulletGrower.original && e.revised === bulletGrower.revised));
    }
    result = render(activeSummary, active);
  }

  const { patch, pdfPath, pages } = result;
  patch.rolledBack = rolledBack;
  // Report the summary swaps that actually survived to the final render.
  const summaryResult = {
    summary: result.summary,
    applied: activeSummary,
    skipped: summaryValidated.skipped,
  };
  patch.summaryEdits = summaryResult; // { summary, applied, skipped } for the debug modal

  // ── gate-1 coverage audit + gate-2 callback score ──────────────────────────────
  // Reconstruct the EXACT final resume text (summary + final skills + edited bullets +
  // untouched Projects/Education) so keyword placement is measured on what actually ships —
  // no PDF text extraction needed, and static sections (which carry real keywords) count too.
  const editByOrig = new Map((patch.edits ?? []).map((e) => [normText(e.original), e.revised]));
  const skillByLabel = patch.skills ?? {};
  const skillLabels = new Set(skills.map((s) => s.label));
  const finalOf = (p) => {
    if (p === summaryPara) return result.summary;
    const ci = p.text.indexOf(":");
    const label = ci > 0 ? p.text.slice(0, ci).trim() : "";
    if (label && skillLabels.has(label) && skillByLabel[label] != null) return `${label}: ${skillByLabel[label]}`;
    return editByOrig.get(normText(p.text)) ?? p.text;
  };
  const finalText = paras.map(finalOf).join("\n");

  // Experience-only text (lead lines + bullets, final order) for keyword-in-context.
  const bulletFinal = (b) => editByOrig.get(normText(b.text)) ?? b.text;
  const rolesForScore = orderedRoles.map((r) => ({
    mostRecent: r.mostRecent,
    bulletTexts: r.orderedBullets.map(bulletFinal),
  }));
  const experienceText = orderedRoles
    .flatMap((r) => [r.leadPara ? bulletFinal(r.leadPara) : "", ...r.orderedBullets.map(bulletFinal)])
    .join("\n");

  // Placed vs. unplaced across the placeable JD-keyword universe.
  const inText = (t, hay) => namedIn(t.surface, hay) || namedIn(t.canonical, hay);
  const placedTargets = jdTargets.filter((t) => inText(t, finalText));
  const missingTargets = jdTargets.filter((t) => !inText(t, finalText));
  const bulletTargets = jdTargets.filter((t) => inText(t, experienceText));

  // Honest, computed missing_keywords: whitelisted-but-unplaced (lost the one-line contest),
  // plus the AI's genuinely-off-whitelist terms (verified against the gate). Never trust the
  // AI's own reason — this run proved it can mislabel a whitelisted term as off-whitelist.
  const llmMissing = Array.isArray(ai.missing_keywords) ? ai.missing_keywords : [];
  const offWhitelist = llmMissing
    .filter((m) => m?.keyword && (!allowSkill || !allowSkill(String(m.keyword))))
    .map((m) => ({ keyword: String(m.keyword), reason: "not-on-whitelist" }));
  const seenMk = new Set();
  patch.missingKeywords = [
    ...missingTargets.map((t) => ({ keyword: t.surface, reason: "no-room" })),
    ...offWhitelist,
  ].filter((m) => { const k = m.keyword.toLowerCase(); if (seenMk.has(k)) return false; seenMk.add(k); return true; });

  // Cross-check: AI claimed a term was off-whitelist that the gate actually allows (this run's
  // "Confluence: not-on-whitelist" bug). Surface as a warning; the computed audit above wins.
  patch.coverageWarnings = llmMissing
    .filter((m) => m?.reason === "not-on-whitelist" && allowSkill && allowSkill(String(m.keyword)))
    .map((m) => ({ keyword: String(m.keyword), note: "AI marked not-on-whitelist but it IS whitelisted" }));
  patch.injectedSkills = injectedSkills;

  // Gate-2 callback score. Title = the posting's exact title (caller-supplied); strip a leading
  // seniority word so "Sr. Fullstack Engineer" still matches a summary led by "Fullstack Engineer".
  const jdTitle = String(title || "").replace(/^\s*(sr\.?|senior|jr\.?|junior|lead|staff|principal)\s+/i, "").trim();
  const cb = callbackScore({
    summary: result.summary,
    jdTitle,
    roles: rolesForScore,
    jdKeywords: jdTargets.map((t) => t.surface),
    placedKeywords: placedTargets.map((t) => t.surface),
    bulletKeywords: bulletTargets.map((t) => t.surface),
  });
  patch.callback = {
    ...cb, jdTitle,
    coverage: jdTargets.length ? placedTargets.length / jdTargets.length : 1,
    cosine: resumeJdCosine(finalText, jd),
  };

  // Per-application trend log (best-effort).
  try {
    appendFileSync(
      path.join(OUTDIR, "callback-log.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), company, title, score: cb.score, components: cb.components, coverage: patch.callback.coverage, cosine: patch.callback.cosine }) + "\n",
    );
  } catch { /* logging is best-effort */ }

  // Diagnostics: summary swaps, then which bullet edits landed / were dropped, and why.
  const summaryDropped = summaryValidated.skipped.filter((s) => s.reason !== "unchanged");
  console.log(
    `[tailor] summary swaps: ${activeSummary.length} applied, ${summaryDropped.length} rejected`,
  );
  for (const s of summaryDropped) console.log(`  reject [${s.reason}] "${s.find.slice(0, 40)}" → "${s.replace.slice(0, 40)}"`);

  const dropped = patch.skipped.filter((s) => s.reason !== "unchanged");
  console.log(
    `[tailor] bullet edits: ${patch.edits.length} applied, ${dropped.length} dropped, ` +
      `${rolledBack.length} rolled back for page-fit (of ${resolved.length} proposed)`,
  );
  for (const s of dropped) console.log(`  drop [${s.reason}] ${s.original.slice(0, 60)}…`);
  for (const r of rolledBack) {
    const what = r.kind === "summary" ? `summary "${r.find.slice(0, 50)}"` : `${r.original.slice(0, 50)}…`;
    console.log(`  rollback [+${r.growth}] ${what}`);
  }
  for (const [label, toks] of Object.entries(patch.blockedSkills ?? {})) {
    console.log(`[tailor] whitelist blocked in "${label}": ${toks.join(", ")}`);
  }
  if (patch.missingKeywords.length) {
    console.log(`[tailor] JD keywords not placed (${patch.missingKeywords.length}):`);
    for (const m of patch.missingKeywords) {
      console.log(`  missing [${m?.reason ?? "?"}] ${m?.keyword ?? JSON.stringify(m)}`);
    }
  }
  if (pages > 1) console.warn(`[tailor] WARNING: ${path.basename(pdfPath)} still ${pages} pages after repair`);

  const c = patch.callback;
  console.log(
    `[tailor] callback score ${c.score}/100  ` +
    `(title:${c.components.titleHit ? "✓" : "✗"} lead:${c.components.leadPunch ? "✓" : "✗"} ` +
    `kw:${c.components.keywordCount}${c.belowBand ? "↓" : c.aboveBand ? "↑" : ""} ` +
    `cov:${Math.round(c.coverage * 100)}% cos:${c.cosine.toFixed(2)})`,
  );
  if (injectedSkills.length) console.log(`[tailor] skills injected by net: ${injectedSkills.map((s) => `${s.keyword}→${s.category}`).join(", ")}`);
  if (patch.coverageWarnings?.length) for (const w of patch.coverageWarnings) console.warn(`[tailor] coverage warning: ${w.keyword} — ${w.note}`);

  return {
    pdfPath,
    pdfB64: readFileSync(pdfPath).toString("base64"),
    docxB64: readFileSync(docxPath).toString("base64"),
    filename: path.basename(pdfPath),
    filenameDocx: path.basename(docxPath),
    patch,
    pages,
    mode: "tailored",
  };
}

// Tailoring orchestrator — the full blueprint Part 6 pipeline, tying the deterministic
// foundation (extract/validate/score/verdicts) to the four DeepSeek calls (llm.mjs).
//
//   1  extract editable units from master.docx
//   2  CALL 1  analyzeJd → { exact_title, must_haves, keywords, … }
//   3-8 resolveAdditions → approved additions (verified, capped), respellings, keywords_missing
//   9  CALL 4  tailor → { headline, edits, bullet_order }
//   10 validate edits (char budget retry-once, numbers, no-new-noun, headline ∈ allowed)
//   11 apply: merge per-unit edits + code-appended additions, insert headline, reorder bullets
//   12 SCORE GATE: coverage(tailored) ≥ coverage(master) — else serve master unchanged
//   13 write tailored .docx (+ PDF when LibreOffice is available)
//   14 return { file, headline, additions(with evidence), respellings, keywords_missing, scores }
//
// Honesty guarantees are all mechanical: additions carry verbatim evidence + a skeptical
// verifier verdict; edits that change a number or introduce a new tech noun are dropped; the
// score gate makes the output provably never worse than the master.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readDocumentXml, writePatchedDocx, buildParagraphLike, insertParagraphAfter, canRenderPdf, docxToPdf, pdfPageCount } from "./docx.mjs";
import { extractUnits, editableUnits, applyEdits, applyBulletOrder } from "./extract.mjs";
import { loadVerdicts } from "./verdicts.mjs";
import { resolveAdditions } from "./additions.mjs";
import { analyzeJd, tailor as tailorCall } from "./llm.mjs";
import { makeNounGuard, validateEdit, isAllowedTitle, checkBudget } from "./validate.mjs";
import { scoreGate } from "./score.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MASTER = process.env.MASTER_RESUME ?? path.join(HERE, "master-resume.docx");
const OUTDIR = process.env.TAILORED_DIR ?? path.join(HERE, "tailored");
const ALLOWED = JSON.parse(readFileSync(path.join(HERE, "allowed-titles.json"), "utf8")).titles;

const MAX_ADDITION_CHARS = 60; // total chars appended across all skills lines (blueprint Part 5)

/**
 * Load the verdict cache scoped to the current master resume — the same cache the tailoring
 * pipeline uses. Exposed so the server's /veto route can flip a wrong AI ACCEPT to a permanent
 * user REJECT without re-running the whole pipeline. Recomputes masterText the identical way
 * (units joined by newline) so the master-hash key matches.
 * @returns {{ masterText: string, cache: import("./verdicts.mjs").VerdictCache }}
 */
export function loadMasterCache(cacheFile = undefined) {
  if (!existsSync(MASTER)) throw new Error(`master resume not found at ${MASTER}`);
  const { units } = extractUnits(readDocumentXml(MASTER));
  const masterText = units.map((u) => u.text).join("\n");
  return { masterText, cache: loadVerdicts(masterText, cacheFile) };
}

const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
const slug = (s, f) => (String(s || "").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || f);
const squash = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * @param {object} o
 * @param {string} o.jd          raw job-description text (required)
 * @param {string} [o.company]   for the output filename
 * @param {string} [o.title]     for the output filename
 * @param {function} [o.onLog]   progress callback(line)
 * @param {object} [o.replay]    { analysis, additions, tailored } to bypass the 4 AI calls (tests)
 * @param {string} [o.cacheFile] verdict-cache path override (tests use a temp file, not the real one)
 */
export async function tailorResume({ jd = "", company = "", title = "", onLog = () => {}, replay = null, cacheFile = undefined, onePage = true } = {}) {
  if (!jd.trim()) throw new Error("tailorResume needs a job description");
  if (!existsSync(MASTER)) throw new Error(`master resume not found at ${MASTER}`);
  mkdirSync(OUTDIR, { recursive: true });

  // 1 — extract.
  const xml = readDocumentXml(MASTER);
  const { units, roles, byId, headline: masterHeadline } = extractUnits(xml);
  const masterText = units.map((u) => u.text).join("\n");

  // 2 — JD analysis.
  const jdA = replay?.analysis ?? await analyzeJd(jd);
  onLog(`analysis: "${jdA.exact_title}" · ${jdA.must_haves.length} must-haves · ${jdA.keywords.length} keywords`);

  // 3-8 — additions (proposer/verifier/cache). The cache is keyed by master hash and persisted.
  const cache = loadVerdicts(masterText, cacheFile);
  const { approved, respellings, missing } = replay?.additions ??
    await resolveAdditions({ masterText, jd: jdA, cache, onLog });
  if (!replay) cache.save();
  onLog(`additions: ${approved.map((a) => `+${a.keyword}⟵${a.evidence.slice(0, 20)}`).join(" ") || "(none)"}`);

  // 9 — tailor (surface rewrite: headline + summary + respellings + reorder).
  const jobs = roles.map((r) => ({ id: r.headerId, title: byId.get(r.headerId).text, bullets: r.bulletIds }));
  const ai = replay?.tailored ?? await tailorCall({
    resume: editableUnits(units), jobs, jd: jdA, allowedTitles: ALLOWED,
    respellings: respellings.map((r) => ({ from: r.from, to: r.to })),
  });

  // 10 — validate edits. The tailor may only introduce the JD spellings we approved as
  // respellings; everything else must already be on the resume.
  const nounGuard = makeNounGuard(masterText, respellings.map((r) => r.to));
  const finalText = new Map(); // id → new text (only changed units)
  const droppedEdits = [];
  for (const e of ai.edits) {
    const unit = byId.get(e.id);
    if (!unit || !unit.editable) { droppedEdits.push({ id: e.id, reason: "unknown-id" }); continue; }
    let text = e.new_text;
    let v = validateEdit(unit, text, nounGuard);
    if (v.status === "retry") { // one shortening retry: hard-trim to budget, re-validate
      text = text.slice(0, unit.chars);
      v = validateEdit(unit, text, nounGuard);
    }
    if (v.status !== "ok") { droppedEdits.push({ id: e.id, reason: v.reasons.join(","), attempted: text.slice(0, 90) }); continue; }
    finalText.set(e.id, text);
  }

  // 11b — headline decision (the master has none, so we INSERT a title line under the name).
  let headlineUsed = null, headlineMismatch = null;
  if (ai.headline && isAllowedTitle(ai.headline, ALLOWED)) {
    headlineUsed = ALLOWED.find((t) => squash(t) === squash(ai.headline));
    if (jdA.exact_title && headlineUsed.toLowerCase() !== jdA.exact_title.toLowerCase()) {
      headlineMismatch = { jdTitle: jdA.exact_title, used: headlineUsed };
    }
  } else if (ai.headline) {
    headlineMismatch = { jdTitle: jdA.exact_title, used: null, note: `"${ai.headline}" not in allowed_titles` };
  }

  // 11a/c — build the tailored document from a chosen subset of additions and headline flag.
  // Placement is one-page-aware two ways: no skills line grows WIDER than the widest line the
  // master already renders, and total appended chars across the section is capped (Part 5).
  const skillWidths = units.filter((u) => u.kind === "skills").map((u) => u.chars);
  const maxSkillWidth = skillWidths.length ? Math.max(...skillWidths) : 0;
  const editEntries = [...finalText]; // validated, length-neutral — always safe

  function build(activeAdditions, withHeadline) {
    const ft = new Map(editEntries);
    const placed = [], budgetMissing = [];
    let addedChars = 0;
    for (const add of activeAdditions) {
      const target = pickSkillsUnit(add, units, byId);
      if (!target) { budgetMissing.push({ keyword: add.keyword, reason: "no-skills-line" }); continue; }
      const current = ft.get(target.id) ?? target.text;
      const next = `${current}, ${add.keyword}`;
      const cost = add.keyword.length + 2;
      if (addedChars + cost > MAX_ADDITION_CHARS || next.length > maxSkillWidth) {
        budgetMissing.push({ keyword: add.keyword, reason: "skills-budget" });
        continue;
      }
      ft.set(target.id, next);
      addedChars += cost;
      placed.push({ ...add, placedIn: target.id });
    }
    let outXml = applyEdits(xml, [...ft].map(([id, new_text]) => ({ id, new_text })), byId);
    outXml = applyBulletOrder(outXml, ai.bullet_order, roles, byId);
    if (withHeadline && headlineUsed && !masterHeadline.present) {
      const nameXml = byId.get("name")?.xml;
      const refXml = byId.get("sum")?.xml ?? nameXml;
      if (nameXml && refXml) outXml = insertParagraphAfter(outXml, nameXml, buildParagraphLike(refXml, headlineUsed));
    }
    return { outXml, finalText: ft, placed, budgetMissing };
  }

  // 11d — page-fit repair. The headline (an insertion) and additions (appends) are unbudgeted by
  // the char contract, so if the render spills past one page we search for the highest-VALUE
  // config that fits: prefer keeping the headline (lever #1); within a headline choice, keep as
  // many additions (lever #5) as fit. Length-neutral edits alone never spill (the master is one
  // page), so a fitting config always exists. Without LibreOffice we skip rendering and trust the
  // char/width budgets (best effort, one page not verified).
  const base = `${slug(company, "Resume")}-${slug(title, "Role")}-${stamp()}`;
  const docxPath = path.join(OUTDIR, base + ".docx");
  const wantHeadline = !!headlineUsed && !masterHeadline.present;

  const renderPages = (b) => { writePatchedDocx(MASTER, b.outXml, docxPath); return pdfPageCount(docxToPdf(docxPath, OUTDIR)); };
  let built, withHeadline, active;

  if (onePage && canRenderPdf() && !replay) {
    let chosen = null;
    for (const useHead of wantHeadline ? [true, false] : [false]) {
      let adds = [...approved];
      while (true) {
        const b = build(adds, useHead);
        if (renderPages(b) <= 1) { chosen = { b, useHead, adds }; break; }
        if (adds.length) adds = adds.slice(0, -1); else break; // headline (or nothing) is the spiller
      }
      if (chosen) break;
    }
    if (!chosen) { const b = build([], false); renderPages(b); chosen = { b, useHead: false, adds: [] }; }
    built = chosen.b; withHeadline = chosen.useHead; active = chosen.adds;
    onLog(`page-fit: 1 page${wantHeadline && !withHeadline ? ", headline omitted" : ""}${active.length < approved.length ? `, dropped ${approved.length - active.length} addition(s)` : ""}`);
  } else {
    active = [...approved]; withHeadline = wantHeadline; built = build(active, withHeadline);
  }

  const headlineDroppedForFit = wantHeadline && !withHeadline;
  // Additions removed from `active` never reached build → report them as page-fit casualties.
  const activeKw = new Set(active.map((a) => a.keyword.toLowerCase()));
  const pageFitDropped = approved.filter((a) => !activeKw.has(a.keyword.toLowerCase())).map((a) => ({ keyword: a.keyword, reason: "page-fit" }));
  const servedHeadline = withHeadline ? headlineUsed : null;

  // 12 — score gate on the FINAL served version. Edits/additions/headline only ever add
  // coverage, so tailored ≥ master holds except when repair stripped everything — then master
  // ships, honoring "never worse than master".
  const tailoredText = [
    servedHeadline ? servedHeadline : "",
    ...units.map((u) => built.finalText.get(u.id) ?? u.text),
  ].join("\n");
  const gate = scoreGate(masterText, tailoredText, jdA);
  onLog(`score: master ${gate.master.score} → tailored ${gate.tailored.score} (Δ${gate.delta >= 0 ? "+" : ""}${gate.delta}) → serve ${gate.serve}`);

  // 13 — write the served document. Gate says master → ship untouched master bytes.
  if (gate.serve === "tailored") writePatchedDocx(MASTER, built.outXml, docxPath);
  else writeFileSync(docxPath, readFileSync(MASTER));

  // 13a — render the FINAL served .docx to a matching .pdf so the tailored dir always holds both.
  // The page-fit loop's PDF is stale (it renders candidates, and the gate may ship the master
  // instead), so re-render here off the bytes we just wrote. Best-effort: skip if no LibreOffice.
  let pdfPath = null;
  if (canRenderPdf()) {
    try { pdfPath = docxToPdf(docxPath, OUTDIR); onLog(`pdf: ${path.basename(pdfPath)}`); }
    catch (e) { onLog(`pdf: skipped (${e.message})`); }
  }

  const placedAdditions = gate.serve === "tailored" ? built.placed : [];
  const edits = editEntries.map(([id, new_text]) => ({ id, new_text }));
  for (const m of [...built.budgetMissing, ...pageFitDropped]) missing.push(m);

  // 14 — result.
  return {
    filename: path.basename(docxPath),
    docxPath,
    pdfPath,
    served: gate.serve,
    headline: gate.serve === "tailored" ? servedHeadline : null,
    headlineMismatch,
    headlineOmittedForFit: headlineDroppedForFit,
    additions: placedAdditions.map((a) => ({ keyword: a.keyword, evidence: a.evidence, tier: a.tier, placedIn: a.placedIn })),
    respellings,
    keywords_missing: dedupeMissing(missing),
    edits_applied: edits.length,
    edits_dropped: droppedEdits,
    bullet_order: ai.bullet_order,
    notes: ai.notes,
    score_master: gate.master.score,
    score_tailored: gate.tailored.score,
    analysis: jdA,
  };
}

// Place an addition next to the sibling it's adjacent to: the skills line that contains (most
// of) its verbatim evidence quote. Falls back to the first skills line.
function pickSkillsUnit(add, units, byId) {
  const skills = units.filter((u) => u.kind === "skills");
  if (!skills.length) return null;
  const ev = String(add.evidence ?? "");
  let best = null, bestOverlap = -1;
  for (const u of skills) {
    const full = byId.get(u.id);
    const overlap = ev && full.text.includes(ev) ? ev.length
      : ev.split(/[,\s]+/).filter((tok) => tok.length > 2 && full.text.includes(tok)).length;
    if (overlap > bestOverlap) { bestOverlap = overlap; best = full; }
  }
  return bestOverlap > 0 ? best : byId.get(skills[0].id);
}

function dedupeMissing(missing) {
  const seen = new Set(), out = [];
  for (const m of missing) {
    const k = String(m.keyword).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

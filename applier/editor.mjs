// Manual resume editor: master.docx → editable text rows, and edited text → styled .docx.
//
// The whole point: the human edits TEXT; the code swaps that text into each paragraph's
// EXISTING run, leaving all formatting XML (fonts, sizes, bold, spacing, bullet styles)
// byte-for-byte untouched. So the round-trip is lossless by construction — there is no
// "guess the style back" step, because the style never left.
//
// Row id = paragraph index in document order ("p0", "p1", …). Stable across a single
// open→save cycle (the master doesn't change in between), which is all we need — no AI,
// no semantic ids, no cache.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readDocumentXml, writePatchedDocx, paragraphs,
  rebuildParagraph, rebuildLabelledParagraph, firstRun, xmlUnesc,
} from "./docx.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Master résumé lives in the project root (one dir up from applier/).
const MASTER = process.env.MASTER_RESUME ?? path.join(HERE, "..", "Lakhveer Singh Resume.docx");

const SECTION_HEADERS = ["SUMMARY", "SKILLS", "WORK EXPERIENCE", "EDUCATION", "PROJECTS", "CERTIFICATIONS", "ACHIEVEMENTS"];
const headerOf = (t) => {
  const up = t.trim().toUpperCase();
  return SECTION_HEADERS.find((h) => up === h || up.startsWith(h + " ")) ?? null;
};

// A "Label: list" skills line, e.g. **Frontend:** React, … — a BOLD run holding exactly the
// "Label:" prefix, followed by the list. Only these need the label-preserving rebuild. The test
// is on the FIRST RUN, not the paragraph text: an ordinary line like "Stack: Next.js, React"
// also starts "Word: " but its first run is "Stack: Next.js" (not bold, not a bare label), so it
// must take the plain single-run rebuild — otherwise the label re-appends and duplicates a word.
const firstRunText = (xml) => {
  const m = firstRun(xml).match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/);
  return m ? xmlUnesc(m[1]) : "";
};
const firstRunBold = (xml) => {
  const rPr = (firstRun(xml).match(/<w:rPr>[\s\S]*?<\/w:rPr>/) ?? [""])[0];
  return /<w:b\/>|<w:b /.test(rPr);
};
const looksLabelled = (para) =>
  firstRunBold(para.xml) && /^[^:\n]{1,32}:\s*$/.test(firstRunText(para.xml));

/**
 * Read the master and return editable rows + full text.
 * @returns {{
 *   rows: Array<{ id, section, kind, text }>,   // kind: "header" (read-only) | "text" (editable)
 *   text: string                                 // full plain text (for keyword onResume scan)
 * }}
 */
export function extractRows(masterPath = MASTER) {
  const paras = paragraphs(readDocumentXml(masterPath));
  const rows = [];
  const textParts = [];
  let section = "";

  paras.forEach((p, i) => {
    const t = p.text.trim();
    if (!t) return; // blank paragraph — structural spacing, not editable, left untouched
    textParts.push(p.text);
    const h = headerOf(p.text);
    if (h) { section = h; rows.push({ id: `p${i}`, section, kind: "header", text: p.text }); return; }
    rows.push({ id: `p${i}`, section, kind: "text", text: p.text });
  });

  return { rows, text: textParts.join("\n") };
}

/**
 * Apply text edits and write a styled .docx to destPath.
 * @param {Array<{id:string,text:string}>} edits  ids are "p<index>" from extractRows
 * @param {string} destPath
 * @param {string} masterPath
 * @param {{highlight?:boolean}} opts  highlight:true shades every changed paragraph yellow
 *        (review preview only — the final saved résumé is built with highlight:false)
 * @returns {string} destPath
 */
export function saveEdited(edits, destPath, masterPath = MASTER, opts = {}) {
  const { highlight = false } = opts;
  const xml = readDocumentXml(masterPath);
  const paras = paragraphs(xml); // same order as extractRows → index maps to id

  const byIndex = new Map();
  for (const e of Array.isArray(edits) ? edits : []) {
    const m = /^p(\d+)$/.exec(String(e?.id || ""));
    if (!m || typeof e.text !== "string") continue;
    byIndex.set(Number(m[1]), e.text);
  }

  let out = xml;
  for (let i = 0; i < paras.length; i++) {
    if (!byIndex.has(i)) continue;
    const p = paras[i];
    const newText = byIndex.get(i);
    if (newText === p.text) continue; // unchanged — leave the original paragraph byte-for-byte
    const rebuilt = looksLabelled(p)
      ? rebuildLabelledParagraph(p.xml, stripLabel(newText), { highlight, oldListText: stripLabel(p.text) })
      : rebuildParagraph(p.xml, newText, { highlight, oldText: p.text });
    // Replace this exact paragraph occurrence (paragraphs can repeat, so replace positionally).
    out = replaceNth(out, p.xml, rebuilt, occurrencesBefore(paras, i));
  }

  return writePatchedDocx(masterPath, out, destPath);
}

// How many earlier paragraphs share this one's exact xml (to target the right occurrence).
function occurrencesBefore(paras, i) {
  let n = 0;
  for (let j = 0; j < i; j++) if (paras[j].xml === paras[i].xml) n++;
  return n;
}

// Replace the (skip+1)-th occurrence of `find` in `str` with `repl`.
function replaceNth(str, find, repl, skip) {
  let from = 0, idx = -1;
  for (let k = 0; k <= skip; k++) {
    idx = str.indexOf(find, from);
    if (idx < 0) return str;
    from = idx + find.length;
  }
  return str.slice(0, idx) + repl + str.slice(idx + find.length);
}

// A skills edit may arrive with the label ("Frontend: React, …") or without; the labelled
// rebuild re-emits the master's own bold label, so drop any leading "Label:" echoed back.
function stripLabel(text) {
  const ci = text.indexOf(":");
  return ci > 0 && ci < 32 ? text.slice(ci + 1).trim() : text.trim();
}

export { MASTER };

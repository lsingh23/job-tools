// Zero-dependency .docx read/patch primitives for the tailoring pipeline.
//
// A .docx is a zip; the body lives in word/document.xml. We read that one entry, parse it
// into paragraphs, and — when applying edits — rewrite only the paragraphs we touch, leaving
// every other byte of the archive untouched. That "touch nothing you didn't edit" rule is
// what makes a zero-edit round-trip byte-identical (see extract.mjs round-trip test) and what
// preserves the master's exact fonts/styles/spacing.
//
// These are ported from the proven helpers in legacy/tailor.mjs, kept here so the new engine
// has no dependency on the legacy whitelist module.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DOC_ENTRY = "word/document.xml";
const SOFFICE = process.env.SOFFICE ?? "/Applications/LibreOffice.app/Contents/MacOS/soffice";

/** True iff LibreOffice is available for docx→PDF rendering (the one-page guard needs it). */
export const canRenderPdf = () => existsSync(SOFFICE);

/** Render a .docx to PDF via headless LibreOffice; returns the PDF path. */
export function docxToPdf(docxPath, outDir) {
  execFileSync(SOFFICE, ["--headless", "--convert-to", "pdf", "--outdir", outDir, docxPath], { stdio: "ignore" });
  const pdf = path.join(outDir, path.basename(docxPath).replace(/\.docx$/i, ".pdf"));
  if (!existsSync(pdf)) throw new Error(`LibreOffice produced no PDF (installed at ${SOFFICE}?)`);
  return pdf;
}

/** Page count of a PDF (reads /Type /Pages /Count, falls back to counting /Type /Page). */
export function pdfPageCount(pdfPath) {
  const buf = readFileSync(pdfPath, "latin1");
  const m = buf.match(/\/Type\s*\/Pages\b[\s\S]*?\/Count\s+(\d+)/);
  if (m) return Number(m[1]);
  return (buf.match(/\/Type\s*\/Page\b(?!s)/g) || []).length || 1;
}

/** Extract word/document.xml from a .docx and return it as a string. */
export function readDocumentXml(docxPath) {
  const dir = mkdtempSync(path.join(tmpdir(), "docx-read-"));
  try {
    execFileSync("unzip", ["-o", docxPath, DOC_ENTRY, "-d", dir], { stdio: "ignore" });
    return readFileSync(path.join(dir, DOC_ENTRY), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Copy `masterPath` to `destDocx`, then replace only its document.xml with `newXml`.
 *  Every other archive entry (styles, fonts, numbering, rels) is preserved verbatim. */
export function writePatchedDocx(masterPath, newXml, destDocx) {
  const dir = mkdtempSync(path.join(tmpdir(), "docx-write-"));
  try {
    copyFileSync(masterPath, destDocx);
    mkdirSync(path.join(dir, "word"), { recursive: true });
    writeFileSync(path.join(dir, DOC_ENTRY), newXml, "utf8");
    execFileSync("zip", ["-q", destDocx, DOC_ENTRY], { cwd: dir });
    return destDocx;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── XML text helpers ────────────────────────────────────────────────────────────
export const xmlEsc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const xmlUnesc = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/** Plain text of a fragment: concatenate the contents of every <w:t> run. */
export const plainText = (frag) =>
  xmlUnesc((frag.match(/<w:t[^>]*>[\s\S]*?<\/w:t>/g) ?? [])
    .map((t) => t.replace(/<[^>]+>/g, "")).join(""));

/** Every <w:p>…</w:p> paragraph (non-self-closing) with its raw xml and plain text. */
export function paragraphs(xml) {
  const out = [];
  const re = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(xml))) out.push({ xml: m[0], text: plainText(m[0]) });
  return out;
}

// ── paragraph rebuild (used only for paragraphs we actually edit) ─────────────────
export const openTag = (p) => p.match(/^<w:p(?:\s[^>]*)?>/)[0];
export const pPr = (p) => (p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) ?? [""])[0];
export const firstRun = (p) => (p.match(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/) ?? [""])[0];

/** rPr of the run at occurrence `idx` (0-based), falling back to the first run's. */
export function runRpr(p, idx = 0) {
  const runs = p.match(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g) ?? [];
  const r = runs[idx] ?? runs[0] ?? "";
  return (r.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) ?? [""])[0];
}

export const buildRun = (rPrXml, text) =>
  `<w:r>${rPrXml}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;

/** Rebuild a paragraph with new plain text in a single run, keeping the paragraph's
 *  properties and the first run's character formatting. Used when we replace a unit's text. */
export function rebuildParagraph(p, newText) {
  return openTag(p) + pPr(p) + buildRun(runRpr(p, 0), newText) + "</w:p>";
}

/** Rebuild a "Label: list" paragraph, preserving the bold label run and reformatting only the
 *  list portion after it (mirrors how the master's skills lines are structured). */
export function rebuildLabelledParagraph(p, listText) {
  const label = firstRun(p);
  const listRun = buildRun(runRpr(p, 1), " " + listText);
  return openTag(p) + pPr(p) + label + listRun + "</w:p>";
}

/** Build a new paragraph carrying `text`, cloning `refPara`'s paragraph + first-run formatting
 *  (so an inserted headline matches the body's font/size/color). */
export function buildParagraphLike(refPara, text) {
  return openTag(refPara) + pPr(refPara) + buildRun(runRpr(refPara, 0), text) + "</w:p>";
}

/** Insert `newParaXml` immediately after the first occurrence of `anchorXml`. Returns xml
 *  unchanged if the anchor isn't found. */
export function insertParagraphAfter(xml, anchorXml, newParaXml) {
  const i = xml.indexOf(anchorXml);
  if (i < 0) return xml;
  const end = i + anchorXml.length;
  return xml.slice(0, end) + newParaXml + xml.slice(end);
}

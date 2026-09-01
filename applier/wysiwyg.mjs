// .docx → an editable HTML page that mirrors the PDF, and back again — losslessly.
//
// The contract is the same one editor.mjs relies on: the human edits TEXT ONLY. Here we go one
// level finer than editor.mjs — instead of collapsing a paragraph into a single run, every
// <w:t> in the document becomes its own contenteditable span. Saving writes each span's text
// back into the <w:t> it came from, so every rPr (bold/italic/size/colour/font), every pPr,
// every hyperlink, tab and break survives byte-for-byte. Mixed-format lines like
// "**KINDGI | Founding Engineer** *| Bengaluru*  →  Jun 2024 – Present" therefore stay intact,
// which the paragraph-level rebuild in editor.mjs cannot promise.
//
// Node id = "p<paraIdx>r<runIdx>t<textIdx>", all positional within the source document. Stable
// for one open→save cycle, which is all that is needed (the source file doesn't change between).
//
// The HTML is a visual mirror, not a renderer: it reads the real geometry out of the .docx
// (page size, margins, indents, spacing, tab stops, bullet levels, fonts) so what you type looks
// like what LibreOffice will print. The rendered PDF stays the ground truth — the editor has a
// "real PDF" toggle for exactly that reason.

import { execFileSync } from "node:child_process";
import { readDocumentXml, xmlEsc, xmlUnesc } from "./docx.mjs";

// ── unit conversion ─────────────────────────────────────────────────────────────
// Word measures in twips (1/1440 in) and half-points; the browser is 96 dpi CSS px.
const TW = 15;                       // twips per px  (1440/96)
const tw = (v) => Number(v || 0) / TW;
const halfPt = (v) => (Number(v) * 96) / 144;  // half-points → px

const attr = (xml, tag, name = "w:val") =>
  (new RegExp(`<${tag}\\b[^>]*\\s${name}="([^"]*)"`).exec(xml) ?? [])[1];
const has = (xml, tag) => new RegExp(`<${tag}\\b[^>/]*/?>`).test(xml);

// ── document defaults (styles.xml) ──────────────────────────────────────────────
// We only need what the résumé actually leans on: the Normal font/size/colour and the indents
// of Normal + ListParagraph, since bullet paragraphs inherit their left indent from one of them.
function readStyles(xmlOrNull) {
  const out = {
    font: "Georgia", sizePx: halfPt(21), color: "#000000",
    styleInd: {}, // styleId → {left, hanging, firstLine, right} in twips
  };
  if (!xmlOrNull) return out;
  const normal = /<w:style\b[^>]*w:styleId="Normal">[\s\S]*?<\/w:style>/.exec(xmlOrNull)?.[0] ?? "";
  const rf = attr(normal, "w:rFonts", "w:ascii");
  if (rf) out.font = rf;
  const sz = attr(normal, "w:sz");
  if (sz) out.sizePx = halfPt(sz);
  const col = attr(normal, "w:color");
  if (col && col !== "auto") out.color = `#${col}`;

  for (const m of xmlOrNull.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)">([\s\S]*?)<\/w:style>/g)) {
    const [, id, body] = m;
    const ind = /<w:ind\b[^>]*\/>/.exec(body)?.[0];
    if (!ind) continue;
    out.styleInd[id] = {
      left: attr(ind, "w:ind", "w:left"),
      right: attr(ind, "w:ind", "w:right"),
      hanging: attr(ind, "w:ind", "w:hanging"),
      firstLine: attr(ind, "w:ind", "w:firstLine"),
    };
  }
  // basedOn chains: ListParagraph is basedOn Normal and only overrides w:left, so inherit the rest.
  for (const m of xmlOrNull.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)">([\s\S]*?)<\/w:style>/g)) {
    const [, id, body] = m;
    const base = attr(body, "w:basedOn");
    if (!base || !out.styleInd[id] || !out.styleInd[base]) continue;
    out.styleInd[id] = { ...out.styleInd[base], ...clean(out.styleInd[id]) };
  }
  return out;
}
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

// Word stores Symbol/Wingdings bullets as private-use codepoints (U+F0B7 = Symbol "•"), which
// render as tofu in a browser without those fonts. Map the private-use range to a real bullet.
const bulletGlyph = (t) => {
  const s = String(t ?? "").trim();
  if (!s) return "\u2022";
  const cp = s.codePointAt(0);
  // U+E000–U+F8FF is the private-use area; %1-style placeholders need real counters.
  if ((cp >= 0xe000 && cp <= 0xf8ff) || /%\d/.test(s)) return "\u2022";
  return s;
};

// ── numbering.xml: numId → level indents (bullet paragraphs get their indent from here) ──────
function readNumbering(xmlOrNull) {
  const byNum = {};
  if (!xmlOrNull) return byNum;
  const abstracts = {};
  for (const m of xmlOrNull.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[\s\S]*?<\/w:abstractNum>/g)) {
    const levels = {};
    for (const l of m[0].matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[\s\S]*?(?=<w:lvl\b|<\/w:abstractNum>)/g)) {
      const ind = /<w:ind\b[^>]*\/>/.exec(l[0])?.[0] ?? "";
      levels[l[1]] = {
        left: attr(ind, "w:ind", "w:left"),
        hanging: attr(ind, "w:ind", "w:hanging"),
        text: bulletGlyph(attr(l[0], "w:lvlText")),
      };
    }
    abstracts[m[1]] = levels;
  }
  for (const m of xmlOrNull.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[\s\S]*?<\/w:num>/g)) {
    const aid = attr(m[0], "w:abstractNumId");
    if (abstracts[aid]) byNum[m[1]] = abstracts[aid];
  }
  return byNum;
}

// ── page geometry (sectPr) ──────────────────────────────────────────────────────
function readPage(xml) {
  const sect = /<w:sectPr\b[\s\S]*?<\/w:sectPr>/.exec(xml)?.[0] ?? "";
  const sz = /<w:pgSz\b[^>]*\/>/.exec(sect)?.[0] ?? "";
  const mar = /<w:pgMar\b[^>]*\/>/.exec(sect)?.[0] ?? "";
  const g = (frag, tag, a, d) => tw(attr(frag, tag, a) ?? d);
  return {
    width: g(sz, "w:pgSz", "w:w", 12240), height: g(sz, "w:pgSz", "w:h", 15840),
    left: g(mar, "w:pgMar", "w:left", 1440), right: g(mar, "w:pgMar", "w:right", 1440),
    top: g(mar, "w:pgMar", "w:top", 1440), bottom: g(mar, "w:pgMar", "w:bottom", 1440),
  };
}

// ── run formatting → CSS ────────────────────────────────────────────────────────
function runCss(rPr, defaults, inLink) {
  const css = [];
  const font = attr(rPr, "w:rFonts", "w:ascii");
  if (font && font !== defaults.font) css.push(`font-family:'${font}',${defaults.font},serif`);
  const sz = attr(rPr, "w:sz");
  if (sz) css.push(`font-size:${halfPt(sz).toFixed(2)}px`);
  // <w:b/> sets bold; <w:b w:val="0"/> and <w:bCs/> (complex-script only) must not.
  if (/<w:b(?:\s+w:val="(?:1|true|on)")?\s*\/>/.test(rPr)) css.push("font-weight:700");
  if (/<w:i(?:\s+w:val="(?:1|true|on)")?\s*\/>/.test(rPr)) css.push("font-style:italic");
  const u = attr(rPr, "w:u");
  const strike = has(rPr, "w:strike");
  const deco = [];
  if ((u && u !== "none") || (inLink && !u)) deco.push("underline");
  if (strike) deco.push("line-through");
  if (deco.length) css.push(`text-decoration:${deco.join(" ")}`);
  const color = attr(rPr, "w:color");
  if (color && color !== "auto") css.push(`color:#${color}`);
  else if (inLink) css.push("color:#0563C1");
  if (has(rPr, "w:caps")) css.push("text-transform:uppercase");
  if (has(rPr, "w:smallCaps")) css.push("font-variant:small-caps");
  const hl = attr(rPr, "w:highlight");
  if (hl && hl !== "none") css.push(`background:${hl}`);
  const shd = attr(rPr, "w:shd", "w:fill");
  if (shd && shd !== "auto" && shd !== "FFFFFF") css.push(`background:#${shd}`);
  return css.join(";");
}

// ── paragraph formatting → CSS ──────────────────────────────────────────────────
function paraCss(pPr, ctx) {
  const { styles, numbering } = ctx;
  const css = [];
  const styleId = attr(pPr, "w:pStyle");
  const numPr = /<w:numPr>[\s\S]*?<\/w:numPr>/.exec(pPr)?.[0] ?? "";
  const numId = attr(numPr, "w:numId");
  const ilvl = attr(numPr, "w:ilvl") ?? "0";
  const lvl = numId && numbering[numId] ? numbering[numId][ilvl] : null;

  // Indent precedence, weakest → strongest: style ← numbering level ← direct <w:ind>.
  const directInd = /<w:ind\b[^>]*\/>/.exec(pPr)?.[0] ?? "";
  const direct = clean({
    left: attr(directInd, "w:ind", "w:left"),
    right: attr(directInd, "w:ind", "w:right"),
    hanging: attr(directInd, "w:ind", "w:hanging"),
    firstLine: attr(directInd, "w:ind", "w:firstLine"),
  });
  const ind = {
    ...(styles.styleInd[styleId] ?? styles.styleInd.Normal ?? {}),
    ...(lvl ? clean({ left: lvl.left, hanging: lvl.hanging }) : {}),
    ...direct,
  };
  // hanging and firstLine are the same slot in Word: whichever the paragraph states directly
  // cancels the other, however it was inherited. (Every header line here says firstLine="0",
  // which must clear Normal's hanging="370" — otherwise the whole résumé shifts left.)
  if ("firstLine" in direct) delete ind.hanging;
  else if ("hanging" in direct) delete ind.firstLine;
  const left = tw(ind.left), right = tw(ind.right);
  const hang = tw(ind.hanging), first = tw(ind.firstLine);
  // Indents are margins, not padding — several paragraphs use negative values to hang into the
  // page margin, and CSS drops negative padding on the floor.
  if (left) css.push(`margin-left:${left.toFixed(2)}px`);
  if (right) css.push(`margin-right:${right.toFixed(2)}px`);
  if (hang) css.push(`text-indent:${(-hang).toFixed(2)}px`);
  else if (first) css.push(`text-indent:${first.toFixed(2)}px`);

  const sp = /<w:spacing\b[^>]*\/>/.exec(pPr)?.[0] ?? "";
  const before = attr(sp, "w:spacing", "w:before"), after = attr(sp, "w:spacing", "w:after");
  css.push(`margin-top:${before ? tw(before).toFixed(2) : 0}px`);
  css.push(`margin-bottom:${after ? tw(after).toFixed(2) : 0}px`);
  const line = attr(sp, "w:spacing", "w:line");
  const rule = attr(sp, "w:spacing", "w:lineRule") ?? "auto";
  if (line) css.push(rule === "auto" ? `line-height:${(Number(line) / 240).toFixed(3)}` : `line-height:${tw(line).toFixed(2)}px`);

  const jc = attr(pPr, "w:jc");
  if (jc) css.push(`text-align:${{ both: "justify", center: "center", right: "right", left: "left" }[jc] ?? "left"}`);

  const bottomBorder = /<w:pBdr>[\s\S]*?<\/w:pBdr>/.exec(pPr)?.[0] ?? "";
  const bb = /<w:bottom\b[^>]*\/>/.exec(bottomBorder)?.[0];
  if (bb && attr(bb, "w:bottom") !== "none") {
    const c = attr(bb, "w:bottom", "w:color");
    const wpx = Math.max(1, Number(attr(bb, "w:bottom", "w:sz") || 6) / 8);
    css.push(`border-bottom:${wpx.toFixed(1)}px solid ${c && c !== "auto" ? `#${c}` : "#000"}`);
    css.push(`padding-bottom:${tw(Number(attr(bb, "w:bottom", "w:space") || 0) * 20).toFixed(2)}px`);
  }
  const shdFill = attr(/<w:shd\b[^>]*\/>/.exec(pPr)?.[0] ?? "", "w:shd", "w:fill");
  if (shdFill && shdFill !== "auto" && shdFill !== "FFFFFF") css.push(`background:#${shdFill}`);

  // A right tab stop at the far margin is the "Company ……… Dates" idiom — lay it out as a
  // two-column flex row instead of trying to emulate tab arithmetic.
  const rightTab = /<w:tab\b[^>]*w:val="right"[^>]*\/>/.test(pPr);
  return { css: css.join(";"), bullet: lvl ? (lvl.text || "•") : null, hangPx: hang, rightTab };
}

// ── parse + render ──────────────────────────────────────────────────────────────
const PARA_RE = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g;
const RUN_RE = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;

/** Build the editable HTML body + page geometry for one .docx. */
export function renderEditable(docxPath) {
  const xml = readDocumentXml(docxPath);
  const styles = readStyles(safeEntry(docxPath, "word/styles.xml"));
  const numbering = readNumbering(safeEntry(docxPath, "word/numbering.xml"));
  const page = readPage(xml);
  const ctx = { styles, numbering };

  // Only the document body — the trailing sectPr and anything after it is not editable content.
  const bodyXml = xml.slice(0, xml.indexOf("<w:sectPr") >= 0 ? xml.indexOf("<w:sectPr") : xml.length);

  const html = [];
  let pIdx = -1;
  for (const pm of bodyXml.matchAll(PARA_RE)) {
    pIdx++;
    const p = pm[0];
    const pPr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(p)?.[0] ?? "";
    const body = pPr ? p.slice(p.indexOf(pPr) + pPr.length) : p;
    const { css, bullet, hangPx, rightTab } = paraCss(pPr, ctx);

    const parts = [];       // rendered pieces, in document order
    let sawTab = false;
    let rIdx = -1;
    for (const rm of body.matchAll(RUN_RE)) {
      rIdx++;
      const run = rm[0];
      const rPr = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(run)?.[0] ?? "";
      // A run inside <w:hyperlink> picks up the Hyperlink character style (blue + underline).
      const inLink = isInsideHyperlink(body, rm.index);
      const style = runCss(rPr, styles, inLink);
      let tIdx = -1;
      // Walk the run's children in order: text, tab and break each render differently.
      for (const cm of run.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\b[^>]*\/?>/g)) {
        const frag = cm[0];
        if (frag.startsWith("<w:tab")) { sawTab = true; parts.push({ tab: true }); continue; }
        if (frag.startsWith("<w:br")) { parts.push({ html: "<br>" }); continue; }
        tIdx++;
        const text = xmlUnesc(cm[1]);
        const id = `p${pIdx}r${rIdx}t${tIdx}`;
        // Whitespace-only runs are structural separators — show them, don't invite edits
        // (an empty contenteditable span collapses to a zero-width, untypeable target).
        const editable = text.trim().length > 0;
        parts.push({
          html: `<span class="t${editable ? " ed" : ""}" data-id="${id}"${editable ? ' contenteditable="true"' : ""}` +
            `${style ? ` style="${style}"` : ""}>${escHtml(text)}</span>`,
        });
      }
    }

    if (!parts.length) { html.push(`<p class="para empty" style="${css}"><br></p>`); continue; }

    const bulletSpan = bullet
      ? `<span class="bullet" style="display:inline-block;width:${(hangPx || 24).toFixed(2)}px">${escHtml(bullet)}</span>`
      : "";

    if (sawTab && rightTab) {
      // Split at the tab: everything before is the left column, everything after the right one.
      const at = parts.findIndex((x) => x.tab);
      const L = parts.slice(0, at).map((x) => x.html ?? "").join("");
      const R = parts.slice(at + 1).map((x) => x.html ?? "").join("");
      html.push(
        `<p class="para tabrow" style="${css};display:flex;justify-content:space-between;gap:12px;text-indent:0">` +
        `<span class="col">${bulletSpan}${L}</span><span class="col right">${R}</span></p>`);
    } else {
      html.push(`<p class="para" style="${css}">${bulletSpan}${parts.map((x) => (x.tab ? '<span class="tab"></span>' : x.html ?? "")).join("")}</p>`);
    }
  }

  return {
    page,
    defaults: { font: styles.font, sizePx: styles.sizePx, color: styles.color },
    html: html.join("\n"),
  };
}

// True iff the run starting at `at` sits inside a <w:hyperlink>…</w:hyperlink>.
function isInsideHyperlink(body, at) {
  const open = body.lastIndexOf("<w:hyperlink", at);
  if (open < 0) return false;
  const close = body.indexOf("</w:hyperlink>", open);
  return close > at;
}

const escHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Read one zip entry as text, or null if it isn't there (numbering.xml is optional).
function safeEntry(docxPath, entry) {
  try {
    return execFileSync("unzip", ["-p", docxPath, entry], { encoding: "utf8", maxBuffer: 32 << 20 });
  } catch { return null; }
}

/**
 * Write edited text back into the source document.xml.
 * @param {string} docxPath  source .docx (master or a previously saved one)
 * @param {Record<string,string>} edits  { "p3r0t0": "new text", … } — ids from renderEditable
 * @returns {{xml:string, changed:number}} patched document.xml
 */
export function applyTextEdits(docxPath, edits) {
  const xml = readDocumentXml(docxPath);
  const cut = xml.indexOf("<w:sectPr");
  const bodyEnd = cut >= 0 ? cut : xml.length;

  let out = "";
  let cursor = 0;
  let pIdx = -1;
  let changed = 0;

  for (const pm of xml.slice(0, bodyEnd).matchAll(PARA_RE)) {
    pIdx++;
    const start = pm.index, p = pm[0];
    out += xml.slice(cursor, start);
    cursor = start + p.length;

    const pPr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(p)?.[0] ?? "";
    const bodyAt = pPr ? p.indexOf(pPr) + pPr.length : 0;
    let rebuilt = p.slice(0, bodyAt);
    let inner = p.slice(bodyAt);

    let iCursor = 0, rIdx = -1;
    for (const rm of inner.matchAll(RUN_RE)) {
      rIdx++;
      rebuilt += inner.slice(iCursor, rm.index);
      iCursor = rm.index + rm[0].length;

      let run = rm[0], tIdx = -1, rCursor = 0, newRun = "";
      for (const cm of run.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) {
        tIdx++;
        const id = `p${pIdx}r${rIdx}t${tIdx}`;
        newRun += run.slice(rCursor, cm.index);
        rCursor = cm.index + cm[0].length;
        const next = edits[id];
        if (typeof next !== "string" || next === xmlUnesc(cm[1])) { newRun += cm[0]; continue; }
        changed++;
        // xml:space="preserve" keeps leading/trailing spaces — dropping it would silently
        // eat the padding that separates runs on a line.
        newRun += `<w:t xml:space="preserve">${xmlEsc(next)}</w:t>`;
      }
      rebuilt += newRun + run.slice(rCursor);
    }
    rebuilt += inner.slice(iCursor);
    out += rebuilt;
  }
  out += xml.slice(cursor);
  return { xml: out, changed };
}

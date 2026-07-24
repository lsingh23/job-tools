// Extractor (blueprint Part 5, build step 1): master.docx → a list of editable text units,
// each with a STABLE id and its current character count. The character-budget contract lives
// on top of this: a cheap text model never sees fonts or wraps, only { id, text, chars }, and
// every replacement it proposes is validated to be 90–100% of the original's `chars`.
//
// Stable id scheme (so ids line up across prompt, edits, reorder, and applier):
//   sum                 the summary paragraph
//   skills.<slug>       one skills line, slug from its "Label:" (e.g. skills.frontend)
//   exp<n>.h            role n header line   ("COMPANY | Title | Loc | Dates")
//   exp<n>.lead         role n context/lead line (optional)
//   exp<n>.b<m>         role n achievement bullet m (reorderable)
//   exp<n>.stack        role n "Stack: …" line (optional)
//   edu<n> / proj<n>.*  education / projects (extracted read-only for scoring)
//
// Round-trip guarantee: applyEdits(xml, [], units) === xml exactly (we rewrite only the
// paragraphs named in `edits`; zero edits ⇒ zero rewrites ⇒ identical document).

import { readDocumentXml, paragraphs, rebuildParagraph, rebuildLabelledParagraph } from "./docx.mjs";

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);

// A role header ("COMPANY | Title | Remote | Location…Dates") has ≥2 pipe separators; bullets
// have none. Robust to the master's location/date concatenation and "… – Present" ranges.
const isHeaderLine = (t) => (t.match(/\|/g) || []).length >= 2;
const isStackLine = (t) => /^\s*Stack\s*:/i.test(t);
// A short "Label: …" context line that scene-sets a role (e.g. "WITS: a FedWire-certified…").
const isLeadLine = (t) => /^[A-Z][\w.&+/-]*\s*:/.test(t.trim()) && !isStackLine(t);

const SECTION_HEADERS = ["SUMMARY", "SKILLS", "WORK EXPERIENCE", "EDUCATION", "PROJECTS"];
const headerOf = (t) => {
  const up = t.trim().toUpperCase();
  return SECTION_HEADERS.find((h) => up === h || up.startsWith(h + " ")) ?? null;
};

/**
 * Parse a document.xml string into units.
 * Returns { units, roles, byId, headline }.
 *  - units:  ordered [{ id, section, kind, text, chars, editable }] (xml kept only in byId)
 *  - roles:  [{ n, headerId, leadId, stackId, bulletIds:[…], mostRecent }] for reordering
 *  - byId:   Map id → { …unit, xml } (xml is the raw <w:p> block, used by the applier)
 *  - headline: { present:false } | { present:true, id:"head", text } — the title line under
 *              the name, if the master already has one (blueprint gap #1).
 */
export function extractUnits(xml) {
  const paras = paragraphs(xml);
  const units = [];
  const byId = new Map();
  const roles = [];

  let section = "HEADER"; // everything before SUMMARY is name/contact/(optional headline)
  let roleN = 0;
  let bulletN = 0;
  let cur = null;
  let headline = { present: false };
  let sawSummaryHeader = false;

  const push = (id, kind, para, { editable = true } = {}) => {
    const unit = { id, section, kind, text: para.text, chars: para.text.length, editable };
    units.push(unit);
    byId.set(id, { ...unit, xml: para.xml });
    return unit;
  };

  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    const t = p.text.trim();
    const h = headerOf(p.text);
    if (h) { section = h; if (h === "SUMMARY") sawSummaryHeader = true; continue; }
    if (!t) continue; // blank paragraph — structural, never a unit

    if (section === "HEADER") {
      // The first non-empty line is the name; a short, comma/pipe-free line right after it that
      // isn't contact info is the headline (title) line. Most masters have none — we record
      // that so the tailor step knows to ADD one rather than edit one.
      const isContact = /[@|]|\bhttps?:\/\/|\+?\d[\d\s().-]{6,}/.test(t);
      if (units.length === 0) { push("name", "name", p, { editable: false }); continue; }
      if (!headline.present && !isContact && t.length <= 60 && !sawSummaryHeader) {
        push("head", "headline", p);
        headline = { present: true, id: "head", text: p.text };
        continue;
      }
      push(`hdr${i}`, "contact", p, { editable: false });
      continue;
    }

    if (section === "SUMMARY") { push("sum", "summary", p); continue; }

    if (section === "SKILLS") {
      const ci = p.text.indexOf(":");
      const label = ci > 0 ? p.text.slice(0, ci).trim() : `line${i}`;
      push(`skills.${slug(label)}`, "skills", p);
      continue;
    }

    if (section === "WORK EXPERIENCE") {
      if (isHeaderLine(t)) {
        roleN += 1; bulletN = 0;
        cur = { n: roleN, headerId: `exp${roleN}.h`, leadId: null, stackId: null, bulletIds: [], mostRecent: roleN === 1 };
        roles.push(cur);
        push(cur.headerId, "role-header", p, { editable: false });
      } else if (!cur) {
        push(`exp0.pre${i}`, "static", p, { editable: false });
      } else if (isStackLine(t)) {
        cur.stackId = `exp${cur.n}.stack`;
        push(cur.stackId, "stack", p, { editable: false });
      } else if (isLeadLine(t) && cur.bulletIds.length === 0) {
        cur.leadId = `exp${cur.n}.lead`;
        push(cur.leadId, "role-lead", p, { editable: false });
      } else {
        bulletN += 1;
        const id = `exp${cur.n}.b${bulletN}`;
        cur.bulletIds.push(id);
        push(id, "bullet", p);
      }
      continue;
    }

    // EDUCATION / PROJECTS / anything after: read-only, extracted so the score gate can see
    // keywords that live in static sections too.
    push(`static${i}`, "static", p, { editable: false });
  }

  return { units, roles, byId, headline };
}

/** Convenience: read a .docx and extract in one call. */
export function extractFromDocx(docxPath) {
  const xml = readDocumentXml(docxPath);
  return { xml, ...extractUnits(xml) };
}

/** The AI-facing view: only editable units, only the fields the model needs. */
export function editableUnits(units) {
  return units.filter((u) => u.editable).map(({ id, section, text, chars }) => ({ id, section, text, chars }));
}

/** Full plain text of the resume in document order (for coverage scoring). */
export function unitsToText(units) {
  return units.map((u) => u.text).join("\n");
}

// ── applier ──────────────────────────────────────────────────────────────────────
/**
 * Apply text replacements by id. `edits` = [{ id, new_text }]. Only the named paragraphs are
 * rewritten (single run, first-run formatting preserved); skills lines keep their bold label.
 * Every other paragraph is left byte-for-byte untouched, so an empty `edits` is the identity.
 * Unknown ids and non-editable ids are ignored. Returns the new xml.
 */
export function applyEdits(xml, edits, byId) {
  let out = xml;
  for (const e of Array.isArray(edits) ? edits : []) {
    const id = e?.id;
    const newText = typeof e?.new_text === "string" ? e.new_text : null;
    if (!id || newText == null) continue;
    const unit = byId.get(id);
    if (!unit || !unit.editable) continue;
    const rebuilt = unit.kind === "skills"
      ? rebuildLabelledParagraph(unit.xml, stripLabel(newText))
      : rebuildParagraph(unit.xml, newText);
    out = out.replace(unit.xml, rebuilt);
  }
  return out;
}

// A skills edit may arrive as "Frontend: React, …" or just "React, …"; rebuildLabelledParagraph
// re-emits the master's own bold label, so drop any leading "Label:" the model echoed back.
function stripLabel(text) {
  const ci = text.indexOf(":");
  return ci > 0 && ci < 30 ? text.slice(ci + 1).trim() : text.trim();
}

/**
 * Reorder bullet paragraphs within roles. `order` = { "<roleHeaderId>": ["exp1.b2","exp1.b1",…] }.
 * Length-neutral (moves whole <w:p> blocks, keeps separators), so it can never change page count.
 * Bails on any role whose ordering isn't a permutation of its bullet ids.
 */
export function applyBulletOrder(xml, order, roles, byId) {
  let out = xml;
  for (const role of roles) {
    const desired = order?.[role.headerId];
    const ids = role.bulletIds;
    if (!Array.isArray(desired) || ids.length < 2) continue;
    if (!isPermutation(desired, ids)) continue;
    if (desired.every((id, i) => id === ids[i])) continue; // already in order
    const blocks = ids.map((id) => byId.get(id).xml);
    const perm = desired.map((id) => ids.indexOf(id));
    out = reorderBlocks(out, blocks, perm);
  }
  return out;
}

const isPermutation = (a, b) =>
  a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));

/** Replace the span of paragraph `blocks` with the same blocks in `order`, preserving whatever
 *  separators sat between them. Returns xml unchanged if any block can't be located. */
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

// JD + master résumé → text-only paragraph edits (+ ranked keywords), applied losslessly.
//
// ONE DeepSeek call. The model never sees or emits .docx — only numbered paragraph text — so
// it CANNOT break the master's styling. It returns changed paragraphs keyed by id
// ({id, new_text}); editor.mjs swaps that text into each paragraph's existing run, byte-for-byte
// preserving every font/size/spacing. Diffing new_text vs the original gives the review
// highlight for free. See prompts/tailor.txt for the contract.

import { deepseekChat } from "./deepseek.mjs";
import { loadPrompt } from "./prompts.mjs";
import { extractRows } from "./editor.mjs";
import { resumeHas, norm } from "./keywords.mjs";

// Reject an edit whose length strays past ±PCT of the original — the one-page layout guard.
// (The prompt asks for this too; we enforce it so a misbehaving model can't blow up the page.)
const LEN_PCT = 0.18; // a hair looser than the prompt's 15% to avoid rejecting good borderline edits
const withinLength = (orig, next) => {
  const o = orig.length, n = next.length;
  if (o === 0) return n <= 4;
  return Math.abs(n - o) / o <= LEN_PCT;
};

/**
 * @param {string} jd  the target job description
 * @param {string} masterPath  optional override
 * @returns {Promise<{
 *   exact_title: string,
 *   keywords: Array<{term,weight,onResume}>,
 *   rows: Array<{id,section,kind,text}>,          // every master paragraph, for rendering
 *   edits: Array<{id, old_text, new_text}>,       // accepted changes only
 *   rejected: Array<{id, reason}>                  // edits dropped by the guards (for logging)
 * }>}
 */
export async function tailor(jd, masterPath) {
  const { rows, text } = extractRows(masterPath);
  const editable = rows.filter((r) => r.kind === "text");
  const byId = new Map(editable.map((r) => [r.id, r.text]));

  const system = loadPrompt("tailor");
  const user =
    "JOB DESCRIPTION:\n" + String(jd || "").trim() +
    "\n\nMASTER RESUME PARAGRAPHS (edit only these ids):\n" +
    editable.map((r) => `[${r.id}] ${r.text}`).join("\n");

  const content = await deepseekChat({ system, user, temperature: 0.3, json: true });
  let parsed = {};
  try { parsed = JSON.parse(content); } catch { parsed = {}; }

  const exact_title = String(parsed.exact_title || "").trim();

  // ── edits: keep only valid ids, real changes, within the length guard ──
  const edits = [];
  const rejected = [];
  const seenIds = new Set();
  for (const e of Array.isArray(parsed.edits) ? parsed.edits : []) {
    const id = String(e?.id || "").trim();
    const next = typeof e?.new_text === "string" ? e.new_text.trim() : "";
    if (!byId.has(id) || seenIds.has(id)) continue;
    seenIds.add(id);
    const orig = byId.get(id);
    if (!next || next === orig) continue;
    // The location is a short "City, Country" token on the contact line — exempt from the
    // paragraph length lock (it's one tab-stopped cell), just capped so it can't overflow the line.
    if (id === "loc" ? next.length > 40 : !withinLength(orig, next)) { rejected.push({ id, reason: "length", old_text: orig, new_text: next }); continue; }
    edits.push({ id, old_text: orig, new_text: next });
  }

  // ── keywords: dedupe, guarantee the title as weight-4 top chip, tag onResume, rank ──
  const seen = new Set();
  const kws = (Array.isArray(parsed.keywords) ? parsed.keywords : [])
    .map((k) => ({
      term: String(k?.term || "").trim(),
      weight: [1, 2, 3, 4].includes(k?.weight) ? k.weight : 1,
    }))
    .filter((k) => {
      const key = norm(k.term);
      if (!k.term || !key.trim() || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (exact_title) {
    const titleNorm = norm(exact_title);
    const existing = kws.find((k) => norm(k.term) === titleNorm);
    if (existing) existing.weight = 4;
    else kws.unshift({ term: exact_title, weight: 4 });
  }
  const keywords = kws
    .map((k) => ({ ...k, onResume: resumeHas(text, k.term) }))
    .sort((a, b) => b.weight - a.weight || Number(a.onResume) - Number(b.onResume));

  return { exact_title, keywords, rows, edits, rejected };
}

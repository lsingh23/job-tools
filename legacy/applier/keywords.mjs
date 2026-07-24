// JD → ranked, impact-ordered keyword list for the manual resume editor.
//
// This is the ONLY AI in the manual-editor flow. One DeepSeek call turns a job description
// into the terms a recruiter/ATS search looks for, ranked by callback weightage:
// exact title (4) > required (3) > preferred (2) > mentioned (1). The API does the weighting
// (see prompts/keywords.txt); we just enforce the order and guarantee the title is present.
// The human does all the actual editing — the AI never touches the resume. Each keyword is
// tagged onResume by a word-boundary scan of the master text so the editor can pre-strike
// terms already covered.

import { deepseekChat } from "./deepseek.mjs";
import { loadPrompt } from "./prompts.mjs";

// Case- and punctuation-insensitive WORD-BOUNDARY match. Both sides normalize to a
// space-delimited token stream, and we match the term padded with spaces — so "Go" matches
// " go " but not "Google"/"Mongo", and "responsive design" matches only the full phrase.
// "Node.js"→"node js", "CI/CD"→"ci cd" still match their spaced forms.
const norm = (s) => ` ${String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
export const resumeHas = (resumeText, term) => {
  const t = norm(term);
  return t.trim().length > 0 && norm(resumeText).includes(t);
};

/**
 * @param {string} jd          the job description text
 * @param {string} resumeText  full plain text of the master resume (for onResume tagging)
 * @returns {Promise<{ exact_title:string, keywords:Array<{term,weight,onResume}> }>}
 */
export async function analyzeKeywords(jd, resumeText = "") {
  const system = loadPrompt("keywords");
  const content = await deepseekChat({ system, user: jd, temperature: 0.2, json: true });

  let parsed = {};
  try { parsed = JSON.parse(content); } catch { parsed = {}; }

  const exact_title = String(parsed.exact_title || "").trim();
  const titleNorm = norm(exact_title);

  const seen = new Set();
  const kws = (Array.isArray(parsed.keywords) ? parsed.keywords : [])
    .map((k) => ({
      term: String(k?.term || "").trim(),
      weight: [1, 2, 3, 4].includes(k?.weight) ? k.weight : 1,
    }))
    .filter((k) => {
      const key = norm(k.term);
      if (!k.term || !key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  // Guarantee the exact posted title is present as the top-tier (weight 4) chip — the #1
  // callback lever. If the model already emitted it verbatim, promote that entry to weight 4.
  if (exact_title) {
    const existing = kws.find((k) => norm(k.term) === titleNorm);
    if (existing) existing.weight = 4;
    else kws.unshift({ term: exact_title, weight: 4 });
  }

  const keywords = kws
    .map((k) => ({ ...k, onResume: resumeHas(resumeText, k.term) }))
    // Highest weightage first; within a weight, the ones you still need (not on resume) first.
    .sort((a, b) => b.weight - a.weight || Number(a.onResume) - Number(b.onResume));

  return { exact_title, keywords };
}

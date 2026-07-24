// The four DeepSeek calls of the tailoring pipeline (blueprint Part 6 / Part 7). Each is a thin
// wrapper: build the prompt, call the model in JSON mode, parse defensively (one retry, then a
// safe empty result — the orchestrator turns "empty" into "serve the master unchanged").
//
// CALL 1 analyzeJd     — JD → { exact_title, must_haves, nice_to_haves, keywords, seniority, domain }
// CALL 2 propose       — missing keywords + resume → claims [{ keyword, tier, evidence_quote }]
// CALL 3 verifyClaim   — one (keyword ⟵ evidence) pair → ACCEPT / REJECT (skeptical, default REJECT)
// CALL 4 tailor        — units + jd + respellings → { headline, edits, bullet_order, notes }

import { deepseekChat } from "./deepseek.mjs";
import { loadPrompt } from "./prompts.mjs";

const str = (v) => (typeof v === "string" ? v.trim() : "");
const arr = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim() : x)).filter(Boolean) : []);

// Safety net for CALL 1: the analyzer is asked for atomic terms but occasionally returns
// requirement sentences. Split each entry on clear list delimiters (comma, ";", " and ",
// " or "), strip leading filler ("experience with", "N+ years of"), drop trailing clauses
// ("… for state management"), and discard anything still sentence-shaped (>5 words or >40
// chars). Slashes are NOT split on — "CI/CD" is one skill and can't be told from "React/Vue".
// De-duplicated, case-insensitive.
export function atomize(terms) {
  const seen = new Set(), out = [];
  for (const raw of arr(terms)) {
    const parts = String(raw).split(/,|;|\band\b|\bor\b/i);
    for (let p of parts) {
      p = p
        .replace(/^\s*(?:strong|proven|solid|deep|hands-on|extensive)\s+/i, "")
        .replace(/^\s*(?:experience|expertise|proficiency|familiarity|knowledge)\s+(?:with|in|of)\s+/i, "")
        .replace(/^\s*\d+\+?\s*years?\s*(?:of|with|in)?\s*/i, "")
        .replace(/\s+for\s+[\w\s-]+$/i, "")
        .replace(/\s+(?:is\s+)?a\s+plus$/i, "")
        .trim().replace(/^[-•*]\s*/, "").replace(/[.:,;]+$/, "").trim();
      if (!p) continue;
      if (p.split(/\s+/).length > 5 || p.length > 40) continue; // still a sentence — drop
      const k = p.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(p); }
    }
  }
  return out;
}

/** Parse JSON, tolerating a ```json fence or leading prose the model occasionally adds. */
function safeParse(content) {
  if (!content) return null;
  try { return JSON.parse(content); } catch { /* fall through */ }
  const m = content.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return null;
}

/** Call in JSON mode; if the first response won't parse, retry once, then give up (→ null). */
async function callJson({ system, user, temperature }) {
  let content = await deepseekChat({ system, user, temperature, json: true });
  let parsed = safeParse(content);
  if (parsed) return parsed;
  content = await deepseekChat({ system, user, temperature, json: true });
  return safeParse(content);
}

// ── CALL 1 — JD analysis ────────────────────────────────────────────────────────
export async function analyzeJd(jd) {
  const system = loadPrompt("analyze");
  const p = (await callJson({ system, user: String(jd).slice(0, 9000), temperature: 0.1 })) ?? {};
  return {
    exact_title: str(p.exact_title),
    must_haves: atomize(p.must_haves),
    nice_to_haves: atomize(p.nice_to_haves),
    keywords: atomize(p.keywords),
    seniority: str(p.seniority) || "mid",
    domain: str(p.domain),
  };
}

// ── CALL 2 — proposer ────────────────────────────────────────────────────────────
/** candidates: JD keywords NOT already on the resume. Returns claims [{ keyword, tier,
 *  evidence_quote }]. tier ∈ T1|T2|T3; evidence_quote is null for T3. */
export async function propose(resumeText, candidates) {
  if (!candidates.length) return [];
  const system = loadPrompt("propose");
  const user = JSON.stringify({ resume_text: resumeText, candidates });
  const p = (await callJson({ system, user, temperature: 0.1 })) ?? {};
  const claims = Array.isArray(p.claims) ? p.claims : [];
  return claims
    .map((c) => ({
      keyword: str(c?.keyword),
      tier: /^T[123]$/.test(c?.tier) ? c.tier : "T3",
      evidence_quote: typeof c?.evidence_quote === "string" ? c.evidence_quote : null,
    }))
    .filter((c) => c.keyword);
}

// ── CALL 3 — verifier (one claim, fresh context) ──────────────────────────────────
/** Judge a single (keyword ⟵ evidence) pair. With `samples`>1, sample at temp 0.3 and require
 *  UNANIMOUS ACCEPT (any REJECT ⇒ REJECT) — the near-zero-cost precision trick from the design.
 *  Returns { verdict:"ACCEPT"|"REJECT", reason }. A parse failure is treated as REJECT (safe). */
export async function verifyClaim(keyword, evidence, { samples = 2 } = {}) {
  const system = loadPrompt("verify", { KEYWORD: keyword, EVIDENCE: evidence });
  const user = "Return your verdict as the specified JSON object.";
  let reason = "";
  for (let i = 0; i < Math.max(1, samples); i++) {
    const temp = samples > 1 ? 0.3 : 0.1;
    const p = (await callJson({ system, user, temperature: temp })) ?? {};
    const verdict = p.verdict === "ACCEPT" ? "ACCEPT" : "REJECT";
    reason = str(p.reason) || reason;
    if (verdict === "REJECT") return { verdict: "REJECT", reason: reason || "verifier rejected" };
  }
  return { verdict: "ACCEPT", reason: reason || "verifier accepted" };
}

// ── CALL 4 — tailor (closed-vocabulary surface rewrite) ───────────────────────────
export async function tailor({ resume, jobs, jd, allowedTitles, respellings }) {
  const system = loadPrompt("tailor");
  const user = JSON.stringify({
    resume,
    jobs, // [{ id:"exp1.h", title, bullets:["exp1.b1",…] }] — bullet_order is keyed by job id
    jd: { exact_title: jd.exact_title, must_haves: jd.must_haves, keywords: jd.keywords, seniority: jd.seniority, domain: jd.domain },
    allowed_titles: allowedTitles,
    respellings, // [{ from, to }]
  });
  const p = (await callJson({ system, user, temperature: 0.1 })) ?? {};
  return {
    headline: str(p.headline),
    edits: Array.isArray(p.edits) ? p.edits.filter((e) => e && typeof e.id === "string" && typeof e.new_text === "string") : [],
    bullet_order: p.bullet_order && typeof p.bullet_order === "object" ? p.bullet_order : {},
    notes: str(p.notes),
  };
}

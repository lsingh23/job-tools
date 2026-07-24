// Skill-addition resolver — blueprint Part 6 steps 3–8, the honesty heart. Turns the JD's
// missing keywords into a small, defensible set of additions + respellings, adjudicated by the
// proposer/verifier and remembered forever in the verdict cache. AI proposes; code proves and
// caps; the cache means each novel pair is judged only once.
//
//   split → propose → verbatim-gate → (T1 → respelling) → (T2 → cache | verify) → cap → missing

import { propose, verifyClaim } from "./llm.mjs";
import { isVerbatimEvidence } from "./validate.mjs";
import { mentions } from "./score.mjs";

// A T1 evidence quote is usable as a respelling FROM only when it's essentially the skill token
// itself (short, no sentence punctuation) — respelling a whole sentence is unsafe.
const isTokenLike = (s) => s.length > 0 && s.length <= 40 && !/[.!?]/.test(s);

// A respelling TARGET must be a SINGLE-skill rename ("REST APIs" → "RESTful APIs"), never a
// list. A conjunction or comma in the keyword means it bundles two skills ("Redux or Zustand"):
// applying it would smuggle the unowned skill (Zustand) in through the respelling backdoor, past
// the verifier. Reject those — the extra skill must earn its place as a T2 addition or not at
// all. (Checked on the keyword only; the verbatim evidence quote may legitimately contain commas,
// e.g. "Next.js (App Router, RSC)".)
const isSingleSkill = (s) => !/\b(?:or|and)\b/i.test(s) && !s.includes(",") && !/\bvs\.?\b/i.test(s);

// The résumé already carries a RICHER variant of the keyword when every significant word of the
// keyword appears in the evidence quote (e.g. keyword "Next.js (App Router)" ⊆ résumé "Next.js
// (App Router, RSC)"). Respelling would DOWNGRADE (drop "RSC"); it's honestly already present, so
// leave the résumé untouched and don't nag about it as missing.
const sigWords = (s) => (String(s).toLowerCase().match(/[a-z0-9.]+/g) ?? [])
  .filter((w) => w.length > 2 && !["the", "and", "for", "with"].includes(w));
const alreadyRicherVariant = (evidence, keyword) => {
  const e = String(evidence).toLowerCase();
  const w = sigWords(keyword);
  return w.length > 0 && w.every((tok) => e.includes(tok));
};

// The full résumé line an evidence quote sits in — richer context for the verifier than the bare
// quote. masterText is newline-joined units, so a "line" is one unit's text.
const lineContext = (masterText, quote) => {
  const q = String(quote ?? "");
  const line = masterText.split("\n").find((l) => l.includes(q));
  return line && line.length <= 400 ? line : q;
};

/**
 * @param {object}   o
 * @param {string}   o.masterText   full plain text of the master resume (evidence + presence)
 * @param {object}   o.jd           analyzeJd() output
 * @param {VerdictCache} o.cache     loaded verdict cache (mutated: new verdicts written, not saved)
 * @param {number}   [o.cap=5]      max accepted T2 additions per application
 * @param {number}   [o.samples=2]  verifier samples (unanimity)
 * @param {function} [o.onLog]      optional progress callback (line:string)
 * @returns {Promise<{ approved, respellings, missing, verifierCalls }>}
 */
export async function resolveAdditions({ masterText, jd, cache, cap = 5, samples = 2, onLog = () => {} }) {
  // Step 3 — candidate universe: must-haves first (they get cap priority), then other keywords,
  // minus anything already present verbatim on the resume. De-duplicated case-insensitively.
  const seen = new Set();
  const candidates = [];
  const isMust = new Set(jd.must_haves.map((k) => k.toLowerCase()));
  for (const kw of [...jd.must_haves, ...jd.keywords]) {
    const k = kw.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    if (mentions(masterText, kw)) continue; // already on the resume — nothing to add
    candidates.push(kw);
  }
  if (!candidates.length) return { approved: [], respellings: [], missing: [], verifierCalls: 0 };

  // Step 5 — proposer (recall-oriented): every candidate → best evidence + tier.
  const claims = await propose(masterText, candidates);
  const byKw = new Map(claims.map((c) => [c.keyword.toLowerCase(), c]));

  const respellings = [];
  const approved = [];
  const missing = [];
  const t2 = [];

  for (const kw of candidates) {
    const c = byKw.get(kw.toLowerCase());
    // Step 6 — code gate: no claim, T3, or non-verbatim evidence ⇒ honestly unplaceable.
    if (!c || c.tier === "T3" || !c.evidence_quote) { missing.push({ keyword: kw, reason: "no-evidence" }); continue; }
    if (!isVerbatimEvidence(c.evidence_quote, masterText)) { missing.push({ keyword: kw, reason: "evidence-not-verbatim" }); continue; }

    if (c.tier === "T1") {
      // Same skill, different spelling → a respelling the tailor may apply anywhere (incl. bullets).
      if (alreadyRicherVariant(c.evidence_quote, kw)) continue; // present as a richer form — leave it
      if (!isSingleSkill(kw)) missing.push({ keyword: kw, reason: "t1-compound-keyword" });
      else if (isTokenLike(c.evidence_quote)) respellings.push({ from: c.evidence_quote, to: kw });
      else missing.push({ keyword: kw, reason: "t1-evidence-too-broad" });
      continue;
    }
    // T2 — a sibling skill; needs the skeptical verifier.
    t2.push({ keyword: kw, evidence: c.evidence_quote, context: lineContext(masterText, c.evidence_quote), must: isMust.has(kw.toLowerCase()) });
  }

  // Steps 4+7 — cache first, verifier only for never-seen keywords. The verifier sees the full
  // résumé LINE the evidence came from (so "serious use" of the sibling is visible — a bare token
  // like "Jest" underspecifies it); the short quote is what we store and display.
  let verifierCalls = 0;
  const verdictOf = async (keyword, quote, context) => {
    const cached = cache.get(keyword);
    if (cached) return { ...cached, cached: true };
    const { verdict, reason } = await verifyClaim(keyword, context, { samples });
    verifierCalls += samples;
    cache.set(keyword, verdict, { evidence: quote, by: "ai", reason });
    onLog(`verify ${keyword} ⟵ "${quote.slice(0, 30)}" → ${verdict}`);
    return { verdict, reason, cached: false };
  };

  // Must-haves first so the cap favors required skills.
  t2.sort((a, b) => Number(b.must) - Number(a.must));
  const accepted = [];
  for (const claim of t2) {
    const v = await verdictOf(claim.keyword, claim.evidence, claim.context);
    if (v.verdict === "ACCEPT") accepted.push({ ...claim, reason: v.reason });
    else missing.push({ keyword: claim.keyword, reason: v.cached ? "verifier-rejected(cached)" : "verifier-rejected" });
  }

  // Step 8 — cap accepted additions (must-haves already first); overflow → missing.
  for (let i = 0; i < accepted.length; i++) {
    if (i < cap) approved.push({ keyword: accepted[i].keyword, evidence: accepted[i].evidence, tier: "T2", reason: accepted[i].reason });
    else missing.push({ keyword: accepted[i].keyword, reason: "over-cap" });
  }
  return { approved, respellings, missing, verifierCalls };
}

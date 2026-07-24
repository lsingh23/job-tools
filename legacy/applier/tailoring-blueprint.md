# Resume Tailoring Blueprint — JD-aware, honest, one-page-safe, DeepSeek-powered

Target pipeline: applier badge → **Tailor Resume** button → local server takes the JD →
DeepSeek proposes and *independently verifies* evidence-backed changes → code applies the
surviving edits to the master `.docx` → validated tailored `.docx` is used for the
application.

---

## Part 1 — Review of the master resume (Lakhveer Singh Resume.docx)

### What's already right (don't touch)
- **Single column, standard section headers** (`SUMMARY`, `SKILLS`, `WORK EXPERIENCE`, `EDUCATION`, `PROJECTS`) — parses cleanly.
- **Consistent "Mon YYYY – Mon YYYY" dates** everywhere — experience math will compute correctly.
- **Contact info appears in the body**, not a Word header (verify once with the gate-0 parse audit — `audit-master.mjs`).
- **Strong keyword base already**: React, Next.js, TypeScript, Node.js, Redux, PostgreSQL, Cypress, Playwright, Docker, CI/CD, AWS, GCP, RAG, LLM tooling — roughly 30–35 role-relevant terms, which is already in the sweet spot.
- Quantified bullets (67% gen-time cut, 60% API-call cut, ~5s load-time, 40%→70% accuracy) — this is what makes a recruiter pick up the phone.

### Gaps the tailoring step must fix per-application
1. **No headline/title line.** There is no line stating a job title under your name. This is the single highest-leverage tailoring edit (the "exact title match" effect). The tailored resume must carry a headline line, e.g. `Senior Frontend Engineer` — the *exact* title from the JD, when it's a truthful framing of your experience.
2. **Summary is fixed-generic.** The first sentence should mirror the JD's title and top-3 stack terms per application.
3. **Skills lines are where JD-adjacent keywords earn their place** — via the evidence gate below, never by free-form model choice.
4. **`GitHub | LinkedIn | Portfolio` are link-text only.** Some parsers extract hyperlink targets, some don't. Low risk, but consider spelling out at least the LinkedIn URL.
5. Minor: exact-string matching matters — if a JD says "React.js" vs "React", "Node" vs "Node.js", the tailored skills line should use the JD's exact spelling.

### Verdict
The master is a solid ATS baseline (single column, standard headers, consistent dates,
quantified bullets). It does **not** need restructuring — it needs a per-JD *surface layer*:
title, summary lead, skill spellings, evidence-backed skill additions, bullet ordering.

---

## Part 2 — Review of the Reddit post (what to trust, what to discount)

| Claim | Verdict | Use it? |
|---|---|---|
| ATS rarely auto-rejects; you're *unsurfaced*, not rejected | **True and important.** Recruiters query the ATS like a database. Optimization = being findable, not "beating a filter". | Yes — this reframes the whole strategy as *search-result ranking* |
| Exact job-title match → ~10.6x callbacks | Direction is right (title match is the strongest single signal); the precise 10.6x figure comes from vendor marketing studies — treat as "big multiplier", not gospel | Yes — headline = exact JD title |
| Two-column / icons / fancy headers get scrambled | True for older parsers (Taleo, iCIMS); modern ones cope better. Cheap to comply, so comply | Already compliant |
| Contact info in header/footer gets dropped | True on several real systems | Already compliant — keep it that way |
| 25–35 keyword "sweet spot" | The exact range is pseudo-precision, but both failure modes are real: too few = fewer search hits, stuffing = human-visible garbage and AI-screen flags | Use as a *budget*, not a law: target 25–35, hard cap ~40 |
| Exact strings matter ("Adobe Creative Cloud" ≠ "Suite") | True — keyword search is largely literal | Yes — mirror JD spellings exactly |
| Consistent date format | True — mixed formats break experience calculation | Already compliant |
| .docx safest format | True across the widest set of parsers | Yes — pipeline outputs .docx by default, PDF only when a form demands it |
| White-text keyword stuffing now gets flagged | True — don't ever do it | Never |

**Net:** the post's checklist is ~90% sound. The two things it *underweights*: (a) recruiters
read the top third of page one and decide in seconds — ordering matters as much as keywords;
(b) honesty — a keyword-matched resume that can't survive a phone screen wastes the interview
you fought for.

---

## Part 3 — Recruiter perspective: what makes a "call this person today" resume

A recruiter running a search + 6-second skim is answering five questions, in order:

1. **"Is this the title I'm hiring for?"** — headline + summary must echo the req's title. This is both the ATS search hit and the human's first glance.
2. **"Do they have my top 3 must-haves, recently?"** — the must-have stack should appear in the *most recent role's first two bullets*, not buried in role #3. Recency beats totality.
3. **"Right level of scope?"** — words like "architected", "led end-to-end", "founding engineer" signal seniority; "assisted", "worked on" signal junior. Your master already signals well.
4. **"Did they cause outcomes?"** — numbers next to verbs (your 67%, 60%, ~5s bullets). A recruiter forwards resumes with numbers because *their* hiring manager skims the same way.
5. **"Any reason to hesitate?"** — gaps, title inflation that contradicts LinkedIn, keyword salad that doesn't read like a human. The tailored output must still read naturally aloud.

**Implication for tailoring:** the five levers, in impact order, are
**(1) headline title, (2) summary first sentence, (3) bullet *ordering* inside each role,
(4) exact-string keyword spellings, (5) evidence-backed skill additions.** All five are
achievable without inventing a single fact.

---

## Part 4 — Evidence-gated skill ingestion: AI judges, code enforces, cache remembers

Three designs were considered and the first two rejected:

- **Whitelist-as-insertion-source**: hand DeepSeek a bag of claimable keywords → it treats
  every entry as a target → stuffing, worse resume.
- **Closed vocabulary**: forbid all new terms → tailoring degenerates to respelling; genuinely
  adjacent skills (the Cypress→Playwright class) never get in, score barely moves.
- **Static rule map in code**: can't enumerate every tool-adjacency in code. Not attempted.

The working design accepts that **adjacency judgment must be AI** — and makes cheap-model
judgment trustworthy through three structural moves rather than through trust:

### Move 1 — Split the proposer from the verifier

Generation and restraint are different skills, and cheap models only have the first. So no
single call both finds keywords and decides they belong:

- **Proposer call**: for each JD keyword missing from the resume, find the strongest
  supporting evidence on the resume, quoted verbatim, and classify it
  (T1 spelling-variant / T2 adjacent-sibling / T3 no-evidence). It is *allowed* to be generous —
  its output is a list of claims, not resume text, so there is nothing to stuff.
- **Verifier call**: a *separate* request with fresh context, framed as a skeptical technical
  interviewer, sees one claim at a time — `keyword + evidence quote` — and returns binary
  ACCEPT / REJECT with "when in doubt, REJECT" as an explicit instruction. Binary
  classification with a strict default is exactly the regime where cheap models are reliable,
  and the verifier has no investment in the proposer's work. Optionally sample the verifier
  twice at temperature 0.3 and require unanimity — near-zero cost, big precision gain.

### Move 2 — Code verifies only what code *can* verify

No adjacency rules in code. Code's checks are purely mechanical:
- `evidence_quote` must be a **verbatim substring of the master resume** (`resume_text.includes()`), so hallucinated justification dies automatically;
- **cap**: max 5 accepted additions per application, must-haves first;
- **placement**: additions go to the matching Skills line only — a term in Skills claims *competence*; a term in a work bullet claims *history*, and only the first is honest for adjacent tools (T1 respells may touch bullets since they change no meaning);
- **char budget**: code computes the exact cost of each append before writing (skills lines may grow to ~110%).

### Move 3 — Every verdict is cached forever (the rule map writes itself)

The master resume is static, so a verdict like `("Playwright", evidence "Cypress") → ACCEPT`
is true for *every future JD*. All verdicts land in `verdicts.json`:

```json
{ "playwright⟵cypress": { "verdict": "ACCEPT", "by": "ai", "at": "2026-07-14" },
  "kubernetes⟵docker":  { "verdict": "REJECT", "by": "user-veto", "at": "2026-07-14" } }
```

- Before calling the verifier, code looks up the cache — **AI only adjudicates keywords it has never seen**. After a few hundred applications, almost everything is a cache hit and the marginal AI-judgment surface shrinks toward zero.
- **The badge shows every addition with its evidence** (`+ Playwright ⟵ Cypress  [✕]`); a veto writes a permanent REJECT. A wrong AI verdict gets corrected exactly once, ever.
- Re-cache verdicts only if the master resume changes (key the cache file by a hash of the master).

### The rest of the honesty contract (unchanged, absolute)

- **Bullets are rename-only**: the tailoring call may re-word to a JD spelling and reorder — it may **never change a number, invent a metric, add an accomplishment, change a date, or change an employer/title of record.**
- **Rejected/T3 keywords are never silently dropped** — `keywords_missing` is always reported. After ~100 applications its frequency table tells you which 3–4 skills to actually learn for maximum callback lift.
- **Headline must come from an allowed-titles list** you define (e.g. `Frontend Engineer`, `Senior Frontend Engineer`, `Software Engineer (Frontend)`, `Full Stack Engineer`, `React Developer`, `UI Engineer`). If the JD title isn't a truthful framing ("Engineering Manager", "Staff Engineer"), use the closest allowed title and report the mismatch.

### Where the score gains come from

Title match (highest weight) + summary echo + T1 respells convert near-misses into exact
hits; verified T2 additions add net-new coverage precisely where you can defend it in a phone
screen. That combination beats the master's score — not volume.

---

## Part 5 — The one-page / line-length problem (solved without the model seeing the doc)

A cheap text model cannot see fonts, margins, or line wraps. So never ask it to. Instead:

**Character-budget contract.** Before the API calls, the server extracts every editable text
unit from the .docx with a stable ID and its current character count:

```json
{ "id": "exp1.b2", "text": "Cut app-generation time 67% (15 → 5 min) by building…", "chars": 172 }
```

The tailoring prompt requires every replacement to be between 90% and 100% of the original's
character count (shorter is always safe; longer risks a wrap). The server then **validates
mechanically**: any edit exceeding its budget is either (a) retried once with a "shorten this"
follow-up, or (b) discarded — the original line is kept. The model never touches layout;
length-neutral edits are provably one-page-safe.

Structural consequences:
- **The model outputs JSON claims/edits, never the document.** Code applies them by replacing text inside the existing docx XML runs, so fonts/styles/spacing are untouched.
- **Reordering is free**: swapping bullet order within a role changes zero characters.
- **Skills appends are done by code**, which knows the exact character cost before writing (skills lines may grow to ~110% of original; total added chars across the section capped at ~60).

---

## Part 6 — Pipeline architecture (maps onto existing `applier/` files)

```
[autofill.user.js]  Tailor button → POST /tailor { jd_text, job_title, company }
        │
[server.mjs]
  0. hash(JD) → cache hit? return cached tailored.docx
  1. Extract editable units from master-resume.docx → resume JSON (ids + chars)
  2. CALL 1 (DeepSeek): JD analysis → { exact_title, must_haves[], nice_to_haves[],
         keywords[] (25–35, JD's exact spellings), seniority, domain }
  3. Code: split keywords → already-on-resume (exact/alias match) vs candidates[]
  4. Code: verdicts.json lookup → cached ACCEPT/REJECT skip AI entirely
  5. CALL 2 (DeepSeek, proposer): uncached candidates → claims
         [{ keyword, tier, evidence_quote }]
  6. Code: drop any claim whose evidence_quote is not a verbatim resume substring
  7. CALL 3 (DeepSeek, verifier): each surviving T2 claim, one at a time, fresh context
         → ACCEPT / REJECT (skeptical-interviewer framing, default REJECT;
           optionally 2 samples, require unanimity)
  8. Code: write all verdicts to verdicts.json; cap accepted additions at 5
         (must-haves first) → approved_additions[]; the rest → keywords_missing[]
  9. CALL 4 (DeepSeek, tailor): { headline, edits[], bullet_order, notes }
         (closed-vocab rewrite: title/summary/respells/reorder — insertion already settled)
 10. VALIDATE edits (pure code): ids exist; char budgets (retry-once, else drop);
         no new tech nouns beyond approved respells; digits/dates/employers unchanged;
         headline ∈ allowed_titles
 11. Code: apply edits + bullet_order; append approved_additions to their skills lines
 12. SCORE GATE: keywordCoverage(tailored, JD) ≥ keywordCoverage(master, JD)
         — if not, serve master unchanged (hard guarantee: never worse than master)
 13. Write tailored-{company}-{hash}.docx
 14. Respond: { file, title_used, respellings, additions (with evidence), keywords_missing,
               score_master, score_tailored }
        │
[userscript badge]  ✅ 31/34 · title: "Senior Frontend Engineer"
                    + Playwright ⟵ Cypress [✕] · + GitHub Actions ⟵ Jenkins CI/CD [✕]
                    ⚠ missing: Kubernetes, GraphQL        (✕ veto → permanent REJECT)
```

**Score gate detail (step 12):** score = weighted coverage of CALL-1 keywords — must-haves ×3,
others ×1, title match ×5, same normalization both sides (lowercase, exact string). It only
needs to be *monotonic*: edits are respell/reorder/append, so tailored ≥ master holds except
when validation dropped everything — then master ships, which still satisfies "never worse".

**Cost:** CALL 1 + proposer + a handful of tiny verifier calls + tailor ≈ 6–8K tokens in,
~2K out ≈ **still ~$0.01 per application**, and the verdict cache makes verifier calls vanish
over time. Cache by JD hash. `temperature: 0.1` (verifier 0.3 for the two-sample trick),
`response_format: { type: "json_object" }`.

---

## Part 7 — The prompts

### CALL 1 — JD analysis (system prompt)

```
You are an ATS keyword analyst. You will receive a job description. Extract, using the
job description's EXACT spellings (never paraphrase, never expand or abbreviate):

1. "exact_title": the job title as posted, stripped of req IDs and location suffixes.
2. "must_haves": skills/tools/qualifications stated as required (max 10).
3. "nice_to_haves": skills stated as preferred/bonus (max 10).
4. "keywords": 25-35 role-relevant terms a recruiter would search for, drawn verbatim
   from the posting: technologies, frameworks, methodologies, domain terms. Prefer
   multi-word exact phrases as written ("React.js" not "React" if the posting says
   "React.js"). Exclude generic filler ("team player", "fast-paced").
5. "seniority": one of "junior" | "mid" | "senior" | "staff+" | "lead/manager".
6. "domain": 1-3 words (e.g. "fintech", "healthcare", "devtools").

Respond with ONLY a JSON object with those six keys. No commentary.
```

User message: the raw JD text.

### CALL 2 — Proposer (system prompt)

```
You are a resume-evidence scout. You receive a candidate's resume text and a list of
keywords from a job description that do NOT currently appear on the resume. For each
keyword, find the strongest evidence on the resume that the candidate could credibly
claim it, and classify:

- "T1": same thing, different spelling (abbreviation, suffix, pluralization, vendor
  renaming). Example: resume says "REST APIs", keyword is "RESTful APIs".
- "T2": a direct sibling of a tool/skill demonstrated on the resume - same job-to-be-done,
  transferable within days for someone who used the sibling seriously. Example: keyword
  "Playwright" with evidence "Cypress" (both end-to-end testing).
- "T3": no credible evidence found.

For every T1 or T2, "evidence_quote" MUST be a VERBATIM substring copied
character-for-character from the resume text. If you cannot copy an exact substring,
classify T3. Do not judge borderline cases strictly - a separate reviewer will. Your job
is recall: surface every plausibly supportable keyword with its best evidence.

Respond with ONLY:
{ "claims": [ { "keyword": "...", "tier": "T1"|"T2"|"T3", "evidence_quote": "..."|null } ] }
```

User message: `{ "resume_text": "<full plain text>", "candidates": [ ...keywords ] }`.

### CALL 3 — Verifier (system prompt; one claim per request, fresh context)

```
You are a skeptical senior engineer running a phone screen. A candidate's resume
demonstrates the following (verbatim from their resume):

  EVIDENCE: "{evidence_quote}"

Their resume's Skills section is about to additionally list: "{keyword}".

Question: if you probed "{keyword}" for five minutes on a call, would this candidate's
demonstrated experience with the evidence above let them answer credibly, given a few
days of ramp-up? ACCEPT only if the evidence shows serious use of a direct sibling tool
or technique - same job-to-be-done, same layer of the stack. REJECT if the connection
requires a leap (different layer, different discipline, "same ecosystem" is NOT enough:
Docker is not evidence for Kubernetes; JavaScript is not evidence for every JS library).

When in doubt, REJECT. A false ACCEPT wastes an interview and burns trust; a false
REJECT costs one keyword.

Respond with ONLY: { "verdict": "ACCEPT"|"REJECT", "reason": "<one sentence>" }
```

*(Run per-claim; optionally twice at temperature 0.3, require unanimous ACCEPT. Code caches
every verdict in `verdicts.json`; user vetoes in the badge overwrite with permanent REJECTs.)*

### CALL 4 — Tailoring (system prompt)

```
You are a resume tailoring engine. You rewrite ONLY surface wording so an honest resume
surfaces in recruiter keyword searches. Skill additions have already been decided
elsewhere - that is NOT your job. Violating any rule makes your output unusable.

INPUTS you will receive as JSON:
- "resume": list of editable units, each { id, section, text, chars }
- "jd": { exact_title, must_haves, keywords, seniority, domain }
- "allowed_titles": the ONLY strings permitted for the headline
- "respellings": pairs of (string currently in resume -> JD's exact spelling). These are
  the ONLY vocabulary changes you may make.

RULES - absolute:
1. NEVER invent, add, or alter: numbers, percentages, dates, durations, employer names,
   job titles of record, project names, skills, tools, or accomplishments. If a bullet
   says 60%, the rewrite says 60%.
2. You may not introduce ANY word naming a technology, tool, or methodology that is not
   already in the resume units, except via the provided "respellings" substitutions.
3. Every rewritten text must be 90%-100% of the original's "chars" value. Count
   characters carefully. When in doubt, go shorter.
4. Rewrites must read naturally to a human reading aloud.
5. Your levers, in order of impact:
   a. "headline": choose the entry from allowed_titles closest to jd.exact_title.
   b. Rewrite the summary's first sentence to echo the headline and the 2-3 most
      important jd.must_haves that ALREADY appear in the resume.
   c. Apply the respellings substitutions wherever those strings occur.
   d. Reorder bullets WITHIN each job so bullets containing jd.must_haves come first
      (output "bullet_order" per job; reordering changes no text).
   e. Reorder terms WITHIN each skills line so jd.must_haves come first.
6. Leave any unit you are not improving out of "edits" entirely.

OUTPUT - only this JSON object:
{
  "headline": "<string from allowed_titles>",
  "edits": [ { "id": "<unit id>", "new_text": "<replacement>" } ],
  "bullet_order": { "<job id>": ["<bullet id>", ...] },
  "notes": "<one sentence on the single biggest improvement made>"
}
```

User message: the JSON inputs object, serialized.

**Retry prompt** (only for edits that blew their char budget):

```
The following replacements exceeded their character budgets. Shorten each to AT MOST the
stated budget while keeping all numbers, dates, and keywords intact. Return the same JSON
edit format with only these ids: [...]
```

---

## Part 8 — Build order (each step independently testable)

**Status legend:** ✅ built + tested · ◐ partial · ⬜ not started. The full pipeline (steps 1–6
+ the server half of 7) is built and verified end-to-end against the real master with live
DeepSeek calls; only the userscript badge (step 7 UI) and the feedback loop (8) remain.

1. ✅ **Extractor** — `applier/extract.mjs` (+ `applier/docx.mjs` for zip/XML I/O). master.docx →
   editable units with stable ids (`sum`, `skills.<slug>`, `exp<n>.b<m>`, …) + char counts.
   Round-trip test passes: `applyEdits(xml, [], byId) === xml` byte-for-byte. Verified on the
   real master: 18 editable / 34 units, 4 roles, `headline:{present:false}` (gap #1 → the tailor
   *inserts* a title line).
2. ✅ **Allowed titles + `verdicts.json`** — `applier/allowed-titles.json` (14 truthful titles),
   hash-keyed cache in `applier/verdicts.mjs`. **Cache is keyed on the KEYWORD, not keyword⟵evidence**
   — the proposer's evidence quote is non-deterministic across runs, so keyword-keying is what
   actually delivers "adjudicate each keyword once" (evidence is stored for display/audit only).
3. ✅ **CALL 1** — JD analysis (`applier/llm.mjs` `analyzeJd`, `prompts/analyze.txt`). Emits
   ATOMIC terms; a code-side `atomize()` safety net splits any requirement-sentence residue
   ("4+ years with React and TS" → "React", "TypeScript") and drops sentence-shaped leftovers.
4. ✅ **Proposer + verifier + cache** — the heart (`applier/additions.mjs`, `llm.mjs`,
   `prompts/propose.txt`+`verify.txt`). Verifier gets the full résumé LINE the evidence sits in
   (bare tokens like "Jest" underspecify "serious use"). **Planted-trap test passes 3/3
   consecutively** (`applier/test/trap.mjs`): Kubernetes⟵Docker REJECT, Vitest⟵Jest &
   Zustand⟵Redux ACCEPT, non-verbatim evidence killed, and run-2 is 100% cache hits (0 verifier
   calls). T1 respellings are guarded against smuggling a second skill ("Redux or Zustand").
5. ✅ **CALL 4 + edit validator + score gate** — tailor call (`llm.mjs`, `prompts/tailor.txt`),
   validators (`validate.mjs`), monotonic gate (`score.mjs`). Bad edits (number changed, new
   tech noun, over-budget) are dropped; unit-tested + covered by an offline `replay` orchestrator test.
6. ✅ **Applier + end-to-end + one-page guarantee** — `tailor.mjs` orchestrates all 14 steps.
   **Render-and-repair page-fit loop** (two-phase: prefer keeping the headline, else keep as many
   additions as fit) guarantees exactly one page — verified: master+headline alone spilled to 2
   pages, the loop brings it back to 1. e2e (`applier/test/e2e.mjs`): served tailored, score
   33→38, all metrics preserved, PDF = 1 page.
7. ✅ **Wire the button** — server `POST /tailor` route (`server.mjs`) live and tested (returns
   docxB64 + full audit: additions-with-evidence, keywords_missing, scores, log). Userscript badge
   (`autofill.user.js` v4.7): 📝 Tailor modal → per-skill evidence card + **Veto** button →
   `POST /veto` → `cache.veto()` → permanent REJECT (re-tailor drops it); tailored .docx is cached
   as the file Autofill attaches.
8. ✅ **Feedback loop** — `feedback.mjs` logs each run as `{id, jd_hash, additions,
   keywords_missing, callback?}` to `applications.json` (gitignored). `POST /outcome` records a
   callback; the badge's "Heard back?" buttons post it. `GET /insights` + `node insights.mjs` + the
   badge's **📊 Insights** view render the "learn next" table: gap keywords ranked by how often
   they cost you (missed) and how many of those got no callback — with a separate "have it, no
   room" list for defensible skills dropped only for one-page fit.

### Known limitation — the master has zero vertical slack

The master resume renders as a *completely full* one page, so the highest-leverage lever (a
standalone headline line) never fits and is omitted by the page-fit loop. **Title-match credit is
still captured** because CALL 4 rewrites the summary's first sentence to echo the exact title.
To let the standalone headline through, free ~one line in the master (trim a bullet/skill).

### Modules built

| File | Role |
|---|---|
| `applier/docx.mjs` | zero-dep .docx zip/XML I/O, paragraph rebuild, headline insert, PDF render + page count |
| `applier/extract.mjs` | master.docx → units (ids + chars); `applyEdits`, `applyBulletOrder` |
| `applier/verdicts.mjs` | keyword-keyed, master-hash-scoped verdict cache; `partition`; permanent veto |
| `applier/validate.mjs` | verbatim evidence, char budget, numbers-preserved, no-new-tech-noun, allowed-title |
| `applier/score.mjs` | weighted coverage (title×5/must×3/other×1) + monotonic serve gate |
| `applier/llm.mjs` | the 4 DeepSeek calls (analyze/propose/verify/tailor) + `atomize` safety net |
| `applier/additions.mjs` | proposer→verbatim-gate→cache→verifier→cap resolver (Part 6 steps 3–8) |
| `applier/tailor.mjs` | orchestrator (14 steps) incl. two-phase page-fit repair |
| `applier/prompts/{analyze,propose,verify,tailor}.txt` | the four editable system prompts (Part 7) |
| `applier/allowed-titles.json`, `applier/verdicts.json` | allowed headline list; hash-keyed cache |
| `applier/test/foundation.test.mjs` | 19 offline tests — `node --test applier/test/foundation.test.mjs` |
| `applier/test/trap.mjs`, `e2e.mjs` | live acceptance tests — `node --env-file=.env applier/test/{trap,e2e}.mjs` |

Reused from `legacy/` (not reimplemented): `recruiter.mjs` / `relevance.mjs` remain available for
a future gate-2 callback score. The docx render was re-ported into `applier/docx.mjs` to keep the
new engine self-contained.

## Failure-mode cheat sheet

| Failure | Guard |
|---|---|
| Model stuffs keywords into prose | Insertion never happens in a prose-writing call; the tailor call (CALL 4) has no insertable vocabulary |
| Model claims an unsupported skill | Verbatim evidence-quote substring check + independent skeptical verifier with default-REJECT + unanimity sampling + your badge veto |
| Adjacency rules impossible to enumerate in code | Not enumerated — AI judges each novel pair once, `verdicts.json` remembers forever, vetoes correct mistakes permanently |
| Model invents a metric | Rule 1 + digit-diff regex → edit dropped |
| Resume spills to 2 pages | Char budgets + mechanical validation → over-budget edits dropped; code-side appends know their exact cost |
| Tailored worse than master | Score gate → serve master |
| Keyword stuffing flagged by AI screen | Additions capped at 5, Skills-only placement, 25–35 budget, natural-read rule |
| JD title is a lie for you | allowed_titles list → closest truthful title + mismatch reported |
| DeepSeek returns malformed JSON | `response_format: json_object`, parse-fail → retry once → serve master |
| Same JD re-clicked | JD-hash cache |

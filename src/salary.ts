import { politeFetch, HttpError } from "./http.js";
import { embedBatch, cosine } from "./embed.js";
import { CONFIG, KEYWORDS } from "../config.js";
import type { ScoredJob, SalaryBand, ExpBucket } from "./types.js";

/**
 * Salary enrichment from AmbitionBox (Naukri-owned, deepest India coverage).
 *
 * No API, no key, no login: the company salary page is a Next.js app that
 * server-renders its whole payload into a __NEXT_DATA__ <script> tag, including
 * the top ~20 job profiles with outlier-trimmed CTC bands. We parse that.
 *
 * Cost model: ONE request per unique company, not per job. The company page
 * already lists every profile, so N jobs at one company cost one fetch.
 */

const AB_BASE = "https://www.ambitionbox.com";

/** Legal-entity suffixes that AmbitionBox usually drops from its slugs. */
const LEGAL_SUFFIX = /\b(pvt|private|ltd|limited|inc|llc|corp|corporation|gmbh|plc|co)\b/g;

/**
 * Regional qualifiers LinkedIn bolts onto employer display names but AmbitionBox
 * never puts in a slug. Without stripping these, the biggest employers on the
 * board silently resolve to nothing: "Accenture in India" guesses only
 * `accenture-in-india` (404) when the page is plain `accenture` (200, 20 profiles,
 * n=34898 on the top one); "NTT DATA North America" needs `ntt-data`.
 *
 * `in india` must precede `india` — alternation is ordered, and matching the
 * bare token first would leave a dangling "in".
 */
const REGION_QUALIFIER =
  /\b(in\s+india|north\s+america|latin\s+america|south\s+america|americas|apac|emea|anz|middle\s+east|global|worldwide|international|india|usa|uk)\b/g;

/** Title noise that never appears in an AmbitionBox profile name. */
const TITLE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "at", "in", "of", "to",
  "hiring", "urgent", "immediate", "opening", "openings", "job", "jobs", "role",
  "remote", "hybrid", "onsite", "wfh", "contract", "fulltime", "permanent",
  "years", "yrs", "exp", "experience", "req", "requisition", "middle",
  "i", "ii", "iii", "iv", "v",
]);

/**
 * Seniority tiers. This gate is the whole point: at Wissen, "Software Engineer"
 * is ~13-14 LPA and "Senior Software Engineer" is ~23-25 LPA. Matching across
 * tiers would attach a number that is wrong by 10 LPA, which is worse than
 * attaching nothing. Tiers must be EQUAL for a match to count.
 */
const TIERS: ReadonlyArray<readonly [number, RegExp]> = [
  [4, /\b(architect|director|head|vp|vice president|chief|cto|principal architect)\b/],
  [3, /\b(principal|staff|lead)\b/],
  [2, /\b(senior|sr)\b/],
  [0, /\b(associate|junior|jr|trainee|intern|graduate|fresher|entry)\b/],
];

function tierOf(title: string): number {
  for (const [tier, re] of TIERS) if (re.test(title)) return tier;
  return 1; // plain individual contributor
}

function tokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((t) => t && !/\d/.test(t) && t.length > 1 && !TITLE_STOPWORDS.has(t)),
  );
}

/**
 * Role nouns so common they carry no signal about WHICH job this is. Two titles
 * sharing only these (plus a seniority word) are not the same role — that's how
 * "Senior Digital Engineer (Frontend)" scores 0.57 against "Senior Engineer
 * Mechanical". Everything left after removing these is the discriminative part.
 */
const GENERIC_ROLE = new Set([
  "engineer", "engineering", "developer", "development", "software", "programmer",
  "senior", "sr", "junior", "jr", "associate", "lead", "staff", "principal",
  "trainee", "intern", "graduate", "fresher", "entry", "architect", "director",
  "head", "vp", "chief", "specialist", "professional",
]);

const domainTokens = (t: Set<string>): Set<string> =>
  new Set([...t].filter((x) => !GENERIC_ROLE.has(x)));

/**
 * Every tech word the project already knows about, reused as the gate for the
 * ladder fallback (see CONFIG.salary.ladderFallback for why cosine can't do it).
 * Built from the résumé keyword table + the filter's frontend tokens so it stays
 * in sync with the rest of the config instead of drifting as a second list.
 */
const TECH_TOKENS: Set<string> = new Set(
  [
    ...KEYWORDS.flatMap((k) => k.aliases),
    ...CONFIG.filter.frontendTitleTokens,
    // Shape-of-role words the keyword table has no reason to carry (it lists
    // technologies, not job shapes) but that titles are full of. Without "stack",
    // "Full Stack Developer" reads as non-technical and loses its ladder band.
    "stack", "fullstack", "mern", "mean", "sde", "swe", "backend", "api", "microservices", "mobile",
  ]
    .flatMap((a) => a.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" "))
    .filter((t) => t.length > 1),
);

/**
 * A generic ladder rung: a profile that is pure seniority + role noun, with no
 * specialisation left after stripping GENERIC_ROLE. "Software Engineer" and
 * "Senior Software Engineer" qualify; "Java Developer" and "Devops Engineer"
 * don't. These are the rungs whose CTC tracks level rather than stack.
 */
const isLadderRung = (profileName: string): boolean =>
  domainTokens(tokens(profileName)).size === 0;

/** Does the posting name a technology we recognise? The ladder gate. */
const looksTechnical = (title: string): boolean =>
  [...domainTokens(tokens(title))].some((t) => TECH_TOKENS.has(t));

/** Dice coefficient — symmetric, penalises both missing and extra tokens. */
function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Candidate slugs for a company name, best guess first. Naive slugification
 * resolves ~89% of real LinkedIn company names; the variants cover most of the
 * rest. Anything still unresolved gets no band rather than a wrong one — add a
 * CONFIG.salary.aliases entry if you hit one that matters.
 *
 * ORDER IS LOAD-BEARING, in both directions:
 *  - Correctness: the first slug that returns a page WINS, so the most literal
 *    reading of the name must come first. "Kwalee" and "Kwalee India" are
 *    different AmbitionBox pages; trying the exact name before either the
 *    region-stripped or the `-india` variant is what keeps them apart.
 *  - Cost: every miss is a real HTTP request behind a 2.5-5s polite delay, so
 *    likelier guesses go earlier.
 */
export function slugCandidates(company: string): string[] {
  const alias = CONFIG.salary.aliases[company.trim()];
  if (alias) return [alias];

  const slugify = (s: string): string =>
    s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const base = slugify(company);
  const stripped = slugify(company.toLowerCase().replace(LEGAL_SUFFIX, " "));
  // "Accenture in India" → "accenture"; "NTT DATA North America" → "ntt-data".
  const deregioned = slugify(company.toLowerCase().replace(LEGAL_SUFFIX, " ").replace(REGION_QUALIFIER, " "));

  const out = [base, stripped, deregioned];
  if (!base.endsWith("-india")) out.push(`${base}-india`);
  return [...new Set(out)].filter(Boolean);
}

interface AbProfile {
  jobProfileName: string;
  urlName: string;
  minExperience: string;
  maxExperience: string;
  avgCtc: string;
  dataPoints: string;
  typicalMinCtc: string;
  typicalMaxCtc: string;
}

interface AbCompany {
  companyName: string;
  slug: string; // the slug that actually resolved — used to build profile URLs
  profiles: AbProfile[];
}

function parseNextData(html: string): Record<string, any> | null {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!);
  } catch {
    return null;
  }
}

/** Fetch a company's salary page and pull its job-profile table. Null = not on AmbitionBox. */
async function fetchCompany(company: string): Promise<AbCompany | null> {
  for (const slug of slugCandidates(company)) {
    const url = `${AB_BASE}/salaries/${slug}-salaries`;
    let html: string;
    try {
      html = await politeFetch(url, {
        cacheKey: `ab:${slug}`,
        ttlMinutes: CONFIG.salary.cacheTtlMinutes,
        label: `ambitionbox ${slug}`,
        headers: { Referer: `${AB_BASE}/` },
      });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) continue; // wrong slug — try next
      throw err;
    }

    const data = parseNextData(html);
    const pp = data?.props?.pageProps;
    const profiles: AbProfile[] = pp?.jobProfiles ?? [];
    if (!pp?.companyName || profiles.length === 0) continue;
    return { companyName: pp.companyName, slug, profiles };
  }
  return null;
}

const lpa = (raw: string | number): number => Math.round((Number(raw) / 1e5) * 10) / 10;

/**
 * Best profile for a job title within one company, or null if nothing clears the
 * seniority gate, the domain gate, and the similarity floor.
 *
 * `vecs` supplies embeddings for every title and profile name (see matchAll). When
 * present we score by cosine; when the model is unavailable we degrade to the old
 * Dice token overlap rather than fail the run.
 *
 * BOTH gates stay in force under embeddings — they are doing more work here, not
 * less. Cosine on short titles is mushy: "Senior Fullstack Developer" scores 0.773
 * against "Senior 2D Animator" and "Senior Digital Engineer (Frontend)" scores
 * 0.814 against "Senior Engineer Mechanical" — both above any usable floor. The
 * domain-token gate is the only thing rejecting them.
 */
function matchProfile(title: string, c: AbCompany, vecs: Map<string, number[]> | null): SalaryBand | null {
  const jt = tokens(title);
  const jTier = tierOf(title.toLowerCase());
  const jDomain = domainTokens(jt);
  const jVec = vecs?.get(title);
  const strong = jVec ? CONFIG.salary.minTitleSim : CONFIG.salary.minTitleMatch;
  const loose = jVec ? CONFIG.salary.minApproxSim : CONFIG.salary.minTitleMatch;

  // Pass 1 — the closest profile that shares this posting's specialisation.
  let best: { p: AbProfile; q: number } | null = null;
  // Pass 2 (gathered in the same loop) — the best generic rung at this tier,
  // used only if pass 1 finds nothing.
  let rung: { p: AbProfile; q: number } | null = null;

  for (const p of c.profiles) {
    if (tierOf(p.jobProfileName.toLowerCase()) !== jTier) continue;
    if (Number(p.dataPoints) < CONFIG.salary.minDataPoints) continue;

    const pt = tokens(p.jobProfileName);
    const pDomain = domainTokens(pt);
    const pVec = jVec ? vecs!.get(p.jobProfileName) : undefined;
    const q = jVec && pVec ? cosine(jVec, pVec) : dice(jt, pt);

    // A generic rung sits close to EVERY engineering-ish title — "Network
    // Engineer" scores 0.823 against "Software Engineer" — so cosine to a rung is
    // evidence of LEVEL, never of role identity. The domain gate can't catch this
    // (a rung has no domain tokens to compare), so: whenever the posting names a
    // specialisation the rung doesn't, the rung is only ever a ladder proxy. That
    // demotion is what stops "Network Engineer" being sold as a title match.
    if (isLadderRung(p.jobProfileName) && jDomain.size > 0) {
      if (!rung || q > rung.q || (q === rung.q && Number(p.dataPoints) > Number(rung.p.dataPoints))) rung = { p, q };
      continue;
    }

    // Both sides specialise but into different fields (frontend vs mechanical)
    // → different jobs that merely share "senior engineer". Reject.
    if (jDomain.size && pDomain.size && dice(jDomain, pDomain) === 0) continue;

    if (q >= loose && (!best || q > best.q)) best = { p, q };
  }

  let chosen: { p: AbProfile; q: number } | null = best;
  let matchType: SalaryBand["matchType"] = best && best.q >= strong ? "title" : "approx";

  // Nothing resembled the title → fall back to what someone at this LEVEL earns
  // here. Only for postings naming a tech we recognise: cosine cannot tell a
  // Business Analyst from a Java dev at this distance (0.706 vs 0.643), so the
  // tech-vocabulary gate is the only thing standing between this and nonsense.
  if (!chosen && CONFIG.salary.ladderFallback && rung && looksTechnical(title)) {
    chosen = rung;
    matchType = "ladder";
  }
  if (!chosen) return null;

  const { p, q } = chosen;
  return {
    company: c.companyName,
    profile: p.jobProfileName,
    minLpa: lpa(p.typicalMinCtc),
    maxLpa: lpa(p.typicalMaxCtc),
    avgLpa: lpa(p.avgCtc),
    dataPoints: Number(p.dataPoints),
    expRange: `${p.minExperience}-${p.maxExperience}`,
    matchQuality: Math.round(q * 100) / 100,
    matchType,
    url: `${AB_BASE}/salaries/${c.slug}-salaries/${p.urlName}`,
    companySlug: c.slug,
    roleSlug: p.urlName,
  };
}

/**
 * Parse a posting's required-experience text into a [min, max] year range.
 * Handles the shapes these boards actually emit: "3-7 Yrs", "5+ years",
 * "2 to 4 years", "4 Years". Null when there's no usable number.
 */
export function parseExpYears(raw: string | null | undefined): [number, number] | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  const span = s.match(/(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})/);
  if (span) return [Number(span[1]), Number(span[2])];
  const plus = s.match(/(\d{1,2})\s*\+/);
  if (plus) return [Number(plus[1]), Number(plus[1]) + 3];
  const one = s.match(/(\d{1,2})/);
  if (one) return [Number(one[1]), Number(one[1])];
  return null;
}

/**
 * The bucket best matching the posting's required years, by overlap.
 *
 * Ties are common and matter: "2-4 yrs" overlaps both a 1-3 and a 3-6 bucket by
 * exactly one year, and at Wissen those read 9–10.3 (n=116) vs 13.6–15 (n=1014).
 * Break ties toward the larger sample — the thin bucket is usually the tail of a
 * neighbouring band, not a real cohort.
 *
 * Thin buckets are dropped on the SAME floor as profiles. `minDataPoints` used to
 * guard only the profile total, but formatBand/CSV prefer the bucket — so a
 * profile could clear the gate on n=3443 and still display a band built from 3
 * submissions (seen live: Xylem, "Software Developer" @ 3-6 yrs, n=3). Returning
 * nothing here falls back to the headline band, which is the honest answer.
 */
function pickBucket(buckets: ExpBucket[], exp: [number, number]): ExpBucket | undefined {
  let best: { b: ExpBucket; ov: number } | null = null;
  for (const b of buckets) {
    if (b.n < CONFIG.salary.minDataPoints) continue;
    const ov = Math.min(exp[1], b.maxExp) - Math.max(exp[0], b.minExp);
    if (ov <= 0) continue;
    if (!best || ov > best.ov || (ov === best.ov && b.n > best.b.n)) best = { b, ov };
  }
  return best?.b;
}

/**
 * Fetch a role's own page for salary split by experience. Mutates the band.
 * Best-effort: any failure leaves the headline band intact.
 */
async function attachExpBuckets(band: SalaryBand, roleSlug: string): Promise<void> {
  const url = `${AB_BASE}/salaries/${band.companySlug}-salaries/${roleSlug}`;
  let html: string;
  try {
    html = await politeFetch(url, {
      cacheKey: `ab:role:${band.companySlug}:${roleSlug}`,
      ttlMinutes: CONFIG.salary.cacheTtlMinutes,
      label: `ambitionbox ${band.companySlug}/${roleSlug}`,
      headers: { Referer: `${AB_BASE}/` },
    });
  } catch {
    return;
  }

  const sd = parseNextData(html)?.props?.pageProps?.salaryData?.data;
  if (!sd) return;

  band.confidence = sd.confidence;
  const raw: any[] = sd.bucketedExperienceLevels ?? [];
  const buckets: ExpBucket[] = raw
    .filter((b) => b?.bucketLabel && Number(b.count) > 0)
    .map((b) => ({
      label: String(b.bucketLabel),
      minExp: Number(b.minExp),
      maxExp: Number(b.maxExp),
      minLpa: lpa(b.typicalMinCtc),
      maxLpa: lpa(b.typicalMaxCtc),
      avgLpa: lpa(b.avgCtc),
      n: Number(b.count),
    }));
  if (buckets.length) band.expBuckets = buckets;
}

/**
 * Attaches `salaryBand` to jobs in place. Groups by company so each company
 * costs one fetch regardless of how many jobs it posted. Never throws: a
 * company that fails to resolve just gets no band.
 */
export async function enrichWithSalary(jobs: ScoredJob[]): Promise<{ matched: number; companies: number; unresolved: string[] }> {
  const byCompany = new Map<string, ScoredJob[]>();
  for (const j of jobs) {
    const key = j.company.trim();
    if (!key) continue;
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key)!.push(j);
  }

  // Most jobs first — if we hit the cap, spend it where it covers the most rows.
  const ordered = [...byCompany.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, CONFIG.salary.maxCompanies);

  let matched = 0;
  const unresolved: string[] = [];

  // Phase 1 — resolve every company first, so phase 2 can embed all the text in
  // one batch instead of once per company.
  const resolved = new Map<string, AbCompany>();
  for (const [company] of ordered) {
    let c: AbCompany | null = null;
    try {
      c = await fetchCompany(company);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  [salary] ${company}: fetch failed — ${msg}\n`);
      // NOTE: a throw here means we never learned whether AmbitionBox has a page,
      // so this company is deliberately NOT pushed to `unresolved` — presence
      // must not report on a company we merely failed to reach.
      continue;
    }
    if (!c) {
      unresolved.push(company);
      continue;
    }
    resolved.set(company, c);
  }

  // Phase 2 — one embedding pass over every distinct job title and profile name.
  // Local CPU only, no network, and cost scales with distinct strings rather than
  // companies. Note this is the ONLY caller of embed.ts (prefilter.ts is pure
  // regex despite CONFIG.embedPrefilter existing), so the first embedBatch of a
  // run pays the nomic-embed load from ./.model-cache.
  let vecs: Map<string, number[]> | null = null;
  const texts = [
    ...new Set([
      ...[...resolved.keys()].flatMap((co) => byCompany.get(co)!.map((j) => j.title)),
      ...[...resolved.values()].flatMap((c) => c.profiles.map((p) => p.jobProfileName)),
    ]),
  ];
  if (texts.length) {
    try {
      const out = await embedBatch(texts);
      vecs = new Map(texts.map((t, i) => [t, out[i]!]));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  [salary] embeddings unavailable (${msg}) — falling back to token overlap\n`);
    }
  }

  // Phase 3 — match every job against its company's profile table.
  for (const [company, c] of resolved) {
    for (const j of byCompany.get(company)!) {
      const band = matchProfile(j.title, c, vecs);
      if (band) {
        j.salaryBand = band;
        matched++;
      }
    }
  }

  // Second pass: salary-by-experience. Deduped by (company, role) — several jobs
  // often map to the same profile, and they can all share one fetch + one result.
  if (CONFIG.salary.roleDetail) {
    const byRole = new Map<string, SalaryBand[]>();
    for (const j of jobs) {
      if (!j.salaryBand) continue;
      const key = `${j.salaryBand.companySlug}/${j.salaryBand.roleSlug}`;
      if (!byRole.has(key)) byRole.set(key, []);
      byRole.get(key)!.push(j.salaryBand);
    }

    for (const bands of [...byRole.values()].slice(0, CONFIG.salary.maxRoleLookups)) {
      const head = bands[0]!;
      await attachExpBuckets(head, head.roleSlug);
      // Fan the fetched buckets out to the other jobs sharing this role.
      for (const b of bands.slice(1)) {
        b.expBuckets = head.expBuckets;
        b.confidence = head.confidence;
      }
    }

    // Pick each posting's own bucket from its required experience.
    for (const j of jobs) {
      const b = j.salaryBand;
      if (!b?.expBuckets) continue;
      const exp = parseExpYears(j.experience);
      if (exp) b.atExp = pickBucket(b.expBuckets, exp);
    }
  }

  return { matched, companies: ordered.length, unresolved };
}

/**
 * Compact console rendering. Prefers the posting's own experience bucket over
 * the blended headline, since that's the number that actually applies:
 *   "21–23.2 LPA @ 3-6 yrs (n=553)"  vs  "22.9–25.3 LPA @ 3-8 yrs (n=1148)"
 */
export function formatBand(b: SalaryBand | undefined): string {
  if (!b) return "";
  // Always show how the profile was picked — a ladder band is a level proxy, not
  // this job's pay, and must never read like a title match.
  const tag = b.matchType === "title" ? "" : ` [${b.matchType}: ${b.profile}]`;
  if (b.atExp) return `${b.atExp.minLpa}–${b.atExp.maxLpa} LPA @ ${b.atExp.label} yrs (n=${b.atExp.n})${tag}`;
  return `${b.minLpa}–${b.maxLpa} LPA @ ${b.expRange} yrs (n=${b.dataPoints})${tag}`;
}

/** All experience buckets on one line: "3-6: 21–23.2 (n=553); 6-9: 24.7–27.3 (n=595)". */
export function formatBuckets(b: SalaryBand | undefined): string {
  if (!b?.expBuckets) return "";
  return b.expBuckets.map((x) => `${x.label}y: ${x.minLpa}–${x.maxLpa} (n=${x.n})`).join("; ");
}

import { CONFIG } from "../../config.js";
import { politeFetch, HttpError } from "../http.js";
import { loadRegistry, type Ats, type Company } from "../discover.js";
import type { Job } from "../types.js";
import type { Source } from "./base.js";

/**
 * THE FAST LOOP — poll every company board we know about.
 *
 * These four endpoints ARE the company's careers page, not a mirror or an index
 * of it, which is the whole reason this source exists alongside LinkedIn/Naukri:
 * a job appears here the moment a recruiter clicks publish, and a CLOSED job is
 * simply absent from the response. There is no staleness to defend against and
 * no "is this still open?" check to make. Newest rows measured 2026-08-11:
 * Razorpay 1.3h, Binance 1.9h, GitLab 3.9h, ClickUp 9.6h.
 *
 * Slugs come from data/companies.json, which src/discover.ts fills weekly.
 * Without a registry these sources are silently empty — run `npm run discover`.
 *
 * A note on volume: these are whole-org boards (Binance 298 postings, jobgether
 * 3,766), so `matchesTitle` cuts hard before anything downstream runs. Unlike
 * LinkedIn there is no enrich budget to worry about — every one of these APIs
 * ships the full JD inline, so a kept job is fully scoreable from one request.
 */

/** Fetch pool. These are public JSON APIs built to be called, not scraped HTML —
 *  so we skip politeFetch's 2.5-5s human delay and bound concurrency instead.
 *  At 6-wide a 400-company registry finishes in a couple of minutes. */
const CONCURRENCY = 6;

async function pooled<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out.push(await fn(items[i]!));
    }
  });
  await Promise.all(workers);
  return out;
}

/** Strip HTML (and Greenhouse's entity-escaped HTML) down to scoreable text. */
function toText(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const INDIA_TOKENS = [
  "india", "bengaluru", "bangalore", "hyderabad", "pune", "mumbai", "chennai",
  "gurgaon", "gurugram", "noida", "delhi", "ncr", "kolkata", "ahmedabad",
  "jaipur", "indore", "chandigarh", "kochi", "coimbatore", "trivandrum",
];
const REMOTE_TOKENS = ["remote", "anywhere", "distributed", "work from home", "wfh"];

/**
 * Place names that mean "not open to India" when they appear with NO India
 * token anywhere in the string.
 *
 * Deliberately a plain table rather than a clever heuristic: the input is free
 * text typed by whoever posted the job — "Remote - CO, FL, GA", "USA Only -
 * 100% Remote", "Zagreb, Remote (EU)", "Lagos, Nigeria; Remote, Nigeria" — and
 * a list you can read and correct beats a rule you have to reverse-engineer.
 * Anything not listed is KEPT, so the failure mode is a little noise rather
 * than a silently deleted job.
 */
export const FOREIGN_TOKENS = [
  // Countries and regions
  "united states", "usa", "u.s.", "canada", "united kingdom", "britain",
  "europe", "european", "emea", "latam", "latin america", "north america",
  "south america", "americas", "apac", "australia", "new zealand",
  "brazil", "argentina", "chile", "colombia", "columbia", "peru", "uruguay",
  "mexico", "costa rica", "panama", "nicaragua", "honduras", "jamaica",
  "dominican republic", "bolivia", "ecuador", "paraguay", "parugauy", "venezuela",
  "poland", "portugal", "spain", "france", "germany", "netherlands", "belgium",
  "ireland", "italy", "sweden", "norway", "denmark", "finland", "iceland",
  "austria", "switzerland", "czech", "slovakia", "slovenia", "croatia",
  "serbia", "romania", "bulgaria", "hungary", "greece", "turkey", "ukraine",
  "moldova", "estonia", "latvia", "lithuania", "malta", "cyprus", "luxembourg",
  "albania", "kazakhstan", "russia", "israel", "egypt", "nigeria", "kenya",
  "uganda", "tanzania", "south africa", "morocco", "ghana",
  "philippines", "vietnam", "malaysia", "singapore", "indonesia", "thailand",
  "japan", "south korea", "taiwan", "hong kong", "china", "pakistan",
  "bangladesh", "uae", "dubai", "saudi",
  // Cities that carry the same meaning on their own
  "new york", "san francisco", "seattle", "boston", "chicago", "los angeles",
  "austin", "denver", "atlanta", "dallas", "miami", "baltimore", "portland",
  "las vegas", "vancouver", "toronto", "montreal", "london", "berlin", "munich",
  "paris", "amsterdam", "dublin", "lisbon", "madrid", "barcelona", "warsaw",
  "krakow", "kyiv", "kharkiv", "lviv", "zagreb", "belgrade", "bucharest",
  "sofia", "budapest", "prague", "athens", "tel aviv", "cairo", "alexandria",
  "lagos", "nairobi", "cape town", "johannesburg", "kampala", "manila", "dhaka",
  "islamabad", "tokyo", "seoul", "sydney", "melbourne", "auckland",
  "sao paulo", "são paulo", "buenos aires", "santiago", "bogota", "bogotá",
  "medellin", "medellín", "lima", "montevideo", "monterrey", "guadalajara",
  "santo domingo", "managua", "tegucigalpa", "kingston", "asuncion",
  "guayaquil", "caracas",
];

/**
 * Short codes need word boundaries — a plain `includes("us")` matches "campus".
 * `(` `/` `-` are all non-word characters, so \b does the right thing on the
 * real strings ("US/EU - Remote", "Remote (US)", "-REMOTE, USA-").
 */
const FOREIGN_CODE_RE = /\b(u\.?s\.?a?|u\.?k\.?|e\.?u\.?|nyc|latam|emea|apac)\b/i;

/**
 * US state abbreviations, matched CASE-SENSITIVELY and only when two or more
 * appear — that's the "Remote - CO, FL, GA, MA, MD…" pattern. Lower-casing or
 * accepting a single code would match ordinary words ("IN", "OR", "ME", "HI")
 * and throw away real India roles.
 */
const US_STATE_RE = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|IL|IA|KS|KY|LA|MD|MA|MI|MN|MS|MO|MT|NV|NH|NJ|NM|NY|NC|ND|OH|OK|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/g;

function isIndia(location: string): boolean {
  const l = location.toLowerCase();
  return INDIA_TOKENS.some((t) => l.includes(t));
}
function isRemote(location: string): boolean {
  const l = location.toLowerCase();
  return REMOTE_TOKENS.some((t) => l.includes(t));
}

/** A remote role that names somewhere else and never names India. */
function isForeignOnly(location: string): boolean {
  if (isIndia(location)) return false; // any India mention wins outright
  const l = location.toLowerCase();
  if (FOREIGN_TOKENS.some((t) => l.includes(t))) return true;
  if (FOREIGN_CODE_RE.test(location)) return true;
  return (location.match(US_STATE_RE) ?? []).length >= 2;
}

/**
 * India evidence in the JD body. The location field is the wrong place to look
 * for a bare-"Remote" role — the body is where a globally-open company actually
 * names its hubs ("our teams in Bengaluru", "overlap with IST").
 *
 * `IST` is matched case-sensitively: lowercase "ist" is a substring of ordinary
 * words and of every German JD Accenture posts.
 */
const JD_INDIA_RE =
  /\b(india|indian|bengaluru|bangalore|hyderabad|pune|mumbai|chennai|gurugram|gurgaon|noida|delhi|kolkata|ahmedabad)\b/i;
const JD_IST_RE = /\bIST\b/;

/**
 * Work-authorization / residency fences, which a JD states in prose even when
 * the location field says nothing. Matched only to REJECT — a JD that says none
 * of this is not thereby proven open to India.
 */
const JD_FOREIGN_FENCE: RegExp[] = [
  /\b(?:authori[sz]ed|eligible|legally\s+able)\s+to\s+work\s+in\s+(?:the\s+)?(?:us|u\.s\.|usa|united\s+states|uk|united\s+kingdom|eu|european\s+union|canada|australia)\b/i,
  /\b(?:must|required\s+to|need\s+to|should)\b[^.]{0,60}\b(?:reside|residing|located|based|live|living)\b[^.]{0,40}\b(?:in|within)\b[^.]{0,30}\b(?:the\s+)?(?:us|u\.s\.|usa|united\s+states|uk|united\s+kingdom|eu|european\s+union|canada|australia|latam|emea)\b/i,
  /\b(?:us|u\.s\.|usa)\s+(?:citizens?|permanent\s+residents?|work\s+authori[sz]ation)\b[^.]{0,20}\b(?:only|required)\b/i,
  /\bthis\s+(?:role|position)\s+is\s+(?:only\s+)?(?:open|available)\s+(?:only\s+)?to\b[^.]{0,60}\b(?:us|united\s+states|uk|eu|canada|emea|latam|australia)\b/i,
  /\b(?:us|u\.s\.|usa|uk|eu|canada)[\s-]*(?:based|only)\b[^.]{0,20}\b(?:candidates?|applicants?|residents?)\b/i,
];

/**
 * Location gate. India in the location wins outright; a non-remote role that
 * names somewhere else loses outright; and a remote role fenced to somewhere
 * else ("Remote - United States", "USA Only - 100% Remote", "Zagreb, Remote
 * (EU)") loses too — the word "remote" was the only reason those were ever in.
 *
 * What is left is the hard case this used to punt on: a BARE "Remote", or an
 * EMPTY location (Workday leaves it blank), which names no country at all. The
 * old code kept both on the theory that filter.ts would judge them from the JD.
 * filter.ts never had any location logic, so nothing ever judged them, and they
 * became the bulk of the noise — 279 of them in the day measured 2026-08-11,
 * every one a US/LATAM/EU role, and NOT ONE of the 279 mentioned India anywhere
 * in its JD body. Zero. So requiring positive India evidence for a role that
 * states no location costs nothing real and removes the whole class.
 *
 * Needs the JD, so unlike the old version this cannot run before the fetch —
 * see locationPlausible for the cheap pre-JD screen Workday still uses.
 */
export function locationOk(location: string, description: string): boolean {
  if (!CONFIG.ats.poll.indiaOnly) return true;
  if (isIndia(location)) return true;
  const stated = location.trim().length > 0;
  if (stated && !isRemote(location)) return false;
  if (stated && isForeignOnly(location)) return false;

  // Bare "Remote", or no location at all. Evidence required.
  if (!CONFIG.ats.poll.requireIndiaEvidence) return true;
  const jd = description || "";
  if (JD_FOREIGN_FENCE.some((re) => re.test(jd))) return false;
  return JD_INDIA_RE.test(jd) || JD_IST_RE.test(jd);
}

/**
 * The half of locationOk that needs no JD. Workday (alone among the four) has
 * to pay a second request per row to get the description, so it screens on this
 * first and lets pollCompanies apply the full gate afterwards. Deliberately
 * permissive: everything it keeps is re-judged with the JD in hand.
 */
function locationPlausible(location: string): boolean {
  if (!CONFIG.ats.poll.indiaOnly) return true;
  if (!location.trim()) return true;
  if (isIndia(location)) return true;
  if (!isRemote(location)) return false;
  return !isForeignOnly(location);
}

/**
 * Cheap title gate, run before anything else. Intentionally WIDER than the
 * pipeline's own title classes — this only has to survive being wrong on a
 * 3,766-row board, and filter.ts/scoring.ts do the precise cut afterwards.
 */
const TITLE_RE =
  /\b(front[\s-]?end|frontend|react|reactjs|next\.?js|ui|ux|web|javascript|typescript|full[\s-]?stack|mern|angular|vue)\b/i;

function matchesTitle(title: string): boolean {
  return TITLE_RE.test(title);
}

/**
 * Age gate — DISABLED by default, on purpose. See CONFIG.ats.poll.maxAgeHours:
 * presence in one of these responses already proves the role is open, so an age
 * window here deletes open jobs rather than stale ones (measured: 64 → 2).
 */
function withinAge(postedAt: string | null): boolean {
  if (!CONFIG.ats.poll.maxAgeHours) return true;
  if (!postedAt) return true; // unknown age is not a reason to drop
  const hours = (Date.now() - new Date(postedAt).getTime()) / 3_600_000;
  return hours <= CONFIG.ats.poll.maxAgeHours;
}

/** Shared shape for every board row before it becomes a Job. */
interface Raw {
  externalId: string;
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  postedAt: string | null;
  employmentType?: string | null;
  salary?: string | null;
}

function toJob(source: string, r: Raw): Job {
  return {
    source,
    externalId: r.externalId,
    title: r.title,
    company: r.company,
    location: r.location,
    url: r.url,
    description: r.description,
    postedAt: r.postedAt,
    salary: r.salary ?? null,
    remote: isRemote(r.location),
    tags: [],
    // Every one of these IS the company's own ATS — that is the entire point.
    // Nothing here is an Easy Apply; you apply on the company's board.
    applyType: "external",
    employmentType: r.employmentType ?? null,
  };
}

// ─────────────────────────────── Greenhouse ───────────────────────────────

interface GhJob {
  id: number;
  title: string;
  updated_at: string;
  first_published?: string;
  absolute_url: string;
  content: string;
  company_name?: string;
  location?: { name?: string };
}

async function fetchGreenhouse(c: Company): Promise<Raw[]> {
  // EU boards use this same host — see CONFIG.ats.endpoints.greenhouse.
  const body = await politeFetch(CONFIG.ats.endpoints.greenhouse.replace("{slug}", c.slug), {
    noDelay: true,
    cacheKey: `gh:${c.slug}`,
    ttlMinutes: 30,
    maxRetries: 1,
    label: `greenhouse/${c.slug}`,
  });
  const jobs = (JSON.parse(body) as { jobs?: GhJob[] }).jobs ?? [];
  return jobs.map((j) => ({
    externalId: `gh:${c.slug}:${j.id}`,
    title: j.title,
    company: j.company_name ?? c.slug,
    location: j.location?.name ?? "",
    url: j.absolute_url,
    // `content` is HTML that has been entity-escaped a second time.
    description: toText(j.content ?? ""),
    // first_published is when it went live; updated_at moves on every edit.
    postedAt: j.first_published ?? j.updated_at ?? null,
  }));
}

// ───────────────────────────────── Lever ──────────────────────────────────

interface LeverPost {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt: number;
  descriptionPlain?: string;
  descriptionBodyPlain?: string;
  workplaceType?: string;
  categories?: { location?: string; commitment?: string; allLocations?: string[] };
}

async function fetchLever(c: Company): Promise<Raw[]> {
  const body = await politeFetch(CONFIG.ats.endpoints.lever.replace("{slug}", c.slug), {
    noDelay: true,
    cacheKey: `lever:${c.slug}`,
    ttlMinutes: 30,
    maxRetries: 1,
    label: `lever/${c.slug}`,
  });
  const posts = JSON.parse(body) as LeverPost[];
  if (!Array.isArray(posts)) return [];
  return posts.map((p) => ({
    externalId: `lever:${c.slug}:${p.id}`,
    title: p.text,
    company: c.slug,
    // allLocations matters: a role listed "Kuala Lumpur" can also be open in
    // Bengaluru, and only this array says so.
    location: [p.categories?.location, ...(p.categories?.allLocations ?? [])]
      .filter(Boolean)
      .join(", "),
    url: p.hostedUrl,
    description: [p.descriptionPlain, p.descriptionBodyPlain].filter(Boolean).join("\n\n"),
    postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
    employmentType: p.categories?.commitment ?? null,
  }));
}

// ───────────────────────────────── Ashby ──────────────────────────────────

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: { location?: string }[];
  employmentType?: string;
  publishedAt?: string;
  jobUrl: string;
  descriptionPlain?: string;
  isListed?: boolean;
  compensation?: { compensationTierSummary?: string };
}

async function fetchAshby(c: Company): Promise<Raw[]> {
  const body = await politeFetch(
    // Re-encode: Ashby slugs may contain spaces ("Fermi AI"), which the registry
    // stores decoded. Verified live — the encoded form returns 16 jobs.
    CONFIG.ats.endpoints.ashby.replace("{slug}", encodeURIComponent(c.slug)) +
      "?includeCompensation=true",
    {
      noDelay: true,
      cacheKey: `ashby:${c.slug}`,
      ttlMinutes: 30,
      maxRetries: 1,
      label: `ashby/${c.slug}`,
    },
  );
  const jobs = (JSON.parse(body) as { jobs?: AshbyJob[] }).jobs ?? [];
  return jobs
    .filter((j) => j.isListed !== false)
    .map((j) => ({
      externalId: `ashby:${c.slug}:${j.id}`,
      title: j.title,
      company: c.slug,
      location: [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)]
        .filter(Boolean)
        .join(", "),
      url: j.jobUrl,
      description: j.descriptionPlain ?? "",
      postedAt: j.publishedAt ?? null,
      employmentType: j.employmentType ?? null,
      salary: j.compensation?.compensationTierSummary ?? null,
    }));
}

// ──────────────────────────────── Workday ─────────────────────────────────

interface WdPosting {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}

/**
 * Workday is the odd one out: the list call returns no JD and only a relative
 * "Posted 5 Days Ago" string, so survivors need a second call for the real
 * description and `startDate`. We therefore title-filter BEFORE fetching detail
 * — that ordering is what keeps a 47-result tenant to a handful of requests.
 */
async function fetchWorkday(c: Company): Promise<Raw[]> {
  if (!c.wd || !c.site) return [];
  const base = CONFIG.ats.endpoints.workday
    .replace(/{tenant}/g, c.slug)
    .replace("{wd}", c.wd)
    .replace("{site}", c.site);
  const host = `https://${c.slug}.${c.wd}.myworkdayjobs.com`;

  const LIMIT = 20;
  const out: Raw[] = [];
  const seen = new Set<string>();

  for (let page = 0; page < CONFIG.ats.poll.workday.maxPages; page++) {
    const body = await politeFetch(base, {
      method: "POST",
      noDelay: true,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        appliedFacets: {},
        limit: LIMIT,
        offset: page * LIMIT,
        searchText: "frontend",
      }),
      cacheKey: `wd:${c.slug}:${c.site}:${page}`,
      ttlMinutes: 30,
      maxRetries: 1,
      label: `workday/${c.slug} p${page}`,
    });
    const parsed = JSON.parse(body) as { jobPostings?: WdPosting[]; total?: number };
    const postings = parsed.jobPostings ?? [];
    if (!postings.length) break;

    for (const p of postings) {
      // Workday IGNORES an out-of-range offset and silently re-serves page 1
      // (measured: total=7, offset=20 → the same 7 rows). Without this guard
      // every small tenant was emitted `maxPages` times over.
      const id = p.bulletFields?.[0] ?? p.externalPath;
      if (seen.has(id)) continue;
      seen.add(id);

      if (!matchesTitle(p.title)) continue;
      // Cheap screen only — the JD arrives below, and pollCompanies re-judges
      // this row with locationOk once it has one.
      if (!locationPlausible(p.locationsText ?? "")) continue;

      let description = "";
      let postedAt: string | null = null;
      try {
        const detail = await politeFetch(`${base.replace(/\/jobs$/, "")}${p.externalPath}`, {
          noDelay: true,
          headers: { Accept: "application/json" },
          cacheKey: `wd:detail:${c.slug}:${p.externalPath}`,
          ttlMinutes: 60 * 6,
          maxRetries: 1,
          label: `workday/${c.slug} jd`,
        });
        const info = (JSON.parse(detail) as { jobPostingInfo?: { jobDescription?: string; startDate?: string } })
          .jobPostingInfo;
        description = toText(info?.jobDescription ?? "");
        // startDate is a real ISO date; postedOn is only "Posted 5 Days Ago".
        postedAt = info?.startDate ?? null;
      } catch {
        // JD fetch failed — keep the row, it is still a real lead.
      }

      out.push({
        externalId: `wd:${c.slug}:${id}`,
        title: p.title,
        company: c.slug,
        location: p.locationsText ?? "",
        url: `${host}/${c.site}${p.externalPath}`,
        description,
        postedAt,
      });
    }
    // Last page: fewer rows than asked for, or we've now seen the whole total.
    if (postings.length < LIMIT || (parsed.total != null && (page + 1) * LIMIT >= parsed.total)) break;
  }
  return out;
}

// ─────────────────────────── Source construction ──────────────────────────

const FETCHERS: Record<Ats, (c: Company) => Promise<Raw[]>> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  workday: fetchWorkday,
};

/** Is this company excluded by config (a reseller, not an employer)? */
export function isExcluded(c: Company): boolean {
  return CONFIG.ats.poll.excludeSlugs.some((s) => s.toLowerCase() === c.slug.toLowerCase());
}

export interface PollResult {
  jobs: Job[];
  /** Boards actually contacted this pass — the caller stamps their lastPolledAt. */
  polled: Company[];
  /** Boards that errored or returned nothing usable, for failure backoff. */
  failed: Company[];
  rawPostings: number;
}

/**
 * Poll an explicit set of company boards. Takes the list rather than reading the
 * registry itself so the scheduler can hand it a rotating slice (and so a manual
 * "poll now" can pass everything).
 */
export async function pollCompanies(companies: Company[]): Promise<PollResult> {
  const targets = companies.filter((c) => !isExcluded(c));
  const failed: Company[] = [];
  const raw: Raw[] = [];

  const results = await pooled(targets, async (c) => {
    try {
      return { c, rows: await FETCHERS[c.ats](c) };
    } catch (err) {
      // 404 = the company left this ATS (or the slug was a bad harvest). Expected
      // and cheap; the registry never shrinks, so this happens on every run.
      if (!(err instanceof HttpError && err.status === 404)) {
        console.error(`    · ${c.ats}/${c.slug}: ${err instanceof Error ? err.message : String(err)}`);
      }
      failed.push(c);
      return { c, rows: [] as Raw[] };
    }
  });

  const jobs: Job[] = [];
  for (const { c, rows } of results) {
    raw.push(...rows);
    for (const r of rows) {
      if (!matchesTitle(r.title)) continue;
      if (!locationOk(r.location, r.description)) continue;
      if (!withinAge(r.postedAt)) continue;
      jobs.push(toJob(c.ats, r));
    }
  }

  return { jobs, polled: targets, failed, rawPostings: raw.length };
}

function makeSource(ats: Ats): Source {
  return {
    name: ats,
    async fetchJobs(): Promise<Job[]> {
      const companies = loadRegistry().companies.filter((c) => c.ats === ats && !isExcluded(c));
      if (!companies.length) {
        console.log(`  (no ${ats} companies in registry — run \`npm run discover\`)`);
        return [];
      }
      console.log(`  polling ${companies.length} ${ats} boards…`);
      const r = await pollCompanies(companies);
      console.log(`  ${ats}: ${r.rawPostings} postings → ${r.jobs.length} after title/location/age`);
      return r.jobs;
    },
  };
}

export const greenhouseSource = makeSource("greenhouse");
export const leverSource = makeSource("lever");
export const ashbySource = makeSource("ashby");
export const workdaySource = makeSource("workday");

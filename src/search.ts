/**
 * Quick single-city job search — spawned by the dashboard /api/search endpoint.
 *
 *   tsx src/search.ts --source linkedin --city Bengaluru --hours 15 --pages 3
 *   tsx src/search.ts --source naukri   --city Bengaluru --hours 2  --pages 3
 *
 * Card fetching differs per platform (LinkedIn cards are title-only and need a
 * per-job enrich; Naukri cards carry the full JD inline), but BOTH feed the same
 * shared scoring pipeline in src/pipeline.ts (prefilter → enrich → score → TF-IDF
 * → dedupe → filter → salary → presence). The multi-city collector (src/collect.ts)
 * uses that same pipeline, so single-city and hourly runs stay identical.
 *
 * Progress lines  → stderr  (streamed live to the dashboard as SSE log events)
 * Final result    → stdout  (single JSON object, parsed by the dashboard)
 */

import { publicEncrypt, constants } from "node:crypto";
import { CONFIG } from "../config.js";
import { politeFetch, HttpError } from "./http.js";
import { fetchLinkedInCards, runPipeline, type LinkedInLocation } from "./pipeline.js";
import { writeCsv } from "./csv.js";
import type { Job } from "./types.js";

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function getArg(name: string, def: string): string {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1]! : def;
}

const source = getArg("source", "linkedin") === "naukri" ? "naukri" : "linkedin";
const city  = getArg("city",  "Bengaluru");
const hours = Math.max(1, parseInt(getArg("hours",  "15"), 10));
const pages = Math.max(1, Math.min(10, parseInt(getArg("pages", "3"),  10)));
const maxApplicantsRaw = parseInt(getArg("maxApplicants", ""), 10);
const maxApplicants = isNaN(maxApplicantsRaw) ? null : maxApplicantsRaw;

const log = (...a: unknown[]) => process.stderr.write(a.join(" ") + "\n");

/**
 * Resolve the CLI `city` to a configured LinkedIn location (with its geoId/remote
 * flag) so a single-city search uses the exact same targeting as the collector.
 * Falls back to a free-text location for a city not in config.
 */
function resolveLocation(name: string): LinkedInLocation {
  const key = name.toLowerCase().replace(/[\s,]+/g, "");
  const match = (CONFIG.locations.linkedin as readonly LinkedInLocation[]).find(
    (l) => l.label.toLowerCase().replace(/[\s,()]+/g, "").includes(key),
  );
  if (match) return match;
  return { label: name, location: `${name}, India`, remote: /remote/i.test(name) };
}

// ── Naukri card fetching (LinkedIn fetching lives in src/pipeline.ts) ───────────
/** Mint a fresh, single-use `nkparam` token. See src/sources/naukri.ts for why. */
function mintNkparam(): string {
  const encrypted = publicEncrypt(
    { key: CONFIG.naukriPublicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(`v0|${Date.now()}|${CONFIG.naukriNkparamSuffix}`, "utf8"),
  );
  return encrypted.toString("base64");
}

interface NaukriCard {
  jobId?: string;
  title?: string;
  companyName?: string;
  placeholders?: { type: string; label: string }[];
  jdURL?: string;
  createdDate?: string | number;
  tagsAndSkills?: string;
  jobDescription?: string;
}

const nkPlaceholder = (j: NaukriCard, type: string): string | null =>
  j.placeholders?.find((p) => p.type === type)?.label ?? null;

const TERMS = [
  "Frontend Engineer",
  "Frontend Developer",
  "React Developer",
  "React",
  "React.js",
  "Next.js",
];

function naukriUrl(keyword: string, page: number): string {
  const p = new URLSearchParams({
    noOfResults: "20",
    urlType: "search_by_key_loc",
    searchType: "adv",
    keyword,
    k: keyword,
    location: city,
    l: city,
    pageNo: String(page),
    sort: "f",
    experience: String(CONFIG.experience.years),
    jobAge: String(Math.max(1, Math.ceil(hours / 24))),
  });
  return `${CONFIG.endpoints.naukri}?${p.toString()}`;
}

/** Cards for one Naukri page, or null at end-of-results for this keyword. */
async function fetchNaukriPage(keyword: string, page: number, first: boolean): Promise<Job[] | null> {
  let body: string;
  try {
    body = await politeFetch(naukriUrl(keyword, page), {
      noDelay: first,
      headers: { ...CONFIG.naukriHeaders, nkparam: mintNkparam(), Accept: "application/json" },
      label: `naukri "${keyword}" p${page}`,
    });
  } catch (err) {
    if (err instanceof HttpError && err.status === 400 && /pageNo/.test(err.body)) return null;
    throw err;
  }

  let data: { jobDetails?: NaukriCard[]; noOfJobs?: number; message?: string };
  try { data = JSON.parse(body); }
  catch { throw new Error("Naukri returned non-JSON (likely an anti-bot HTML challenge)."); }

  if (data.message && /recaptcha/i.test(data.message))
    throw new Error(
      "Naukri returned 'recaptcha required' despite a minted nkparam — the RSA public key " +
        "or the 'v0|…|121_srp' plaintext likely rotated. Re-extract both from Naukri's current app JS.",
    );
  if (!Array.isArray(data.jobDetails)) {
    if (!data.noOfJobs) return null;
    throw new Error("Naukri JSON missing 'jobDetails' despite noOfJobs>0 — endpoint shape changed.");
  }
  if (!data.jobDetails.length) return null;

  return data.jobDetails.flatMap((j): Job[] => {
    if (!j.jobId || !j.title) return [];
    const postedMs = j.createdDate ? Number(j.createdDate) : NaN;
    return [{
      source: "naukri",
      externalId: `naukri:${j.jobId}`,
      title: j.title,
      company: j.companyName ?? "",
      location: nkPlaceholder(j, "location") ?? city,
      url: j.jdURL
        ? (/^https?:\/\//.test(j.jdURL) ? j.jdURL : `https://www.naukri.com${j.jdURL.startsWith("/") ? "" : "/"}${j.jdURL}`)
        : `https://www.naukri.com/job-listings-${j.jobId}`,
      description: `${j.jobDescription ?? ""} ${j.tagsAndSkills ?? ""}`.trim(),
      postedAt: Number.isFinite(postedMs) ? new Date(postedMs).toISOString() : null,
      salary: nkPlaceholder(j, "salary"),
      experience: nkPlaceholder(j, "experience"),
      remote: /remote/i.test(nkPlaceholder(j, "location") ?? city),
      tags: (j.tagsAndSkills ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      applicants: null,
    }];
  });
}

/**
 * Cards from Naukri, narrowed to the `hours` window client-side. sort=f returns
 * newest-first, so the first card past the cutoff means every later card is older
 * too — stop that keyword there instead of paging through a day of stale results.
 */
async function fetchNaukriCards(): Promise<Job[]> {
  const cutoff = Date.now() - hours * 3600_000;
  const seen = new Set<string>();
  const out: Job[] = [];
  let stale = 0;
  let first = true;
  for (const kw of TERMS) {
    keyword: for (let p = 1; p <= pages; p++) {
      const cards = await fetchNaukriPage(kw, p, first);
      first = false;
      if (cards === null) { log(`  naukri "${kw}" p${p}: end of results`); break; }
      let fresh = 0;
      for (const j of cards) {
        const t = j.postedAt ? Date.parse(j.postedAt) : NaN;
        if (!Number.isFinite(t) || t < cutoff) {
          stale++;
          if (Number.isFinite(t)) {
            log(`  naukri "${kw}" p${p}: ${fresh} within ${hours}h, then past the window — stopping`);
            break keyword;
          }
          continue;
        }
        fresh++;
        if (!seen.has(j.externalId)) { seen.add(j.externalId); out.push(j); }
      }
      log(`  naukri "${kw}" p${p}: ${cards.length} cards, ${fresh} within ${hours}h`);
    }
  }
  log(`[search] naukri: ${stale} cards outside the ${hours}h window dropped`);
  return out;
}

// ── Pipeline ──────────────────────────────────────────────────────────────────
async function main() {
  const loc = source === "linkedin" ? resolveLocation(city) : null;
  log(
    `[search] source=${source}  city="${city}"  hours=${hours}  pages/kw=${pages}` +
      (source === "linkedin"
        ? `  geoId=${loc?.geoId ?? "text"}${maxApplicants !== null ? `  maxApplicants=${maxApplicants}` : ""}`
        : `  exp=${CONFIG.experience.years}y  jobAge=${Math.max(1, Math.ceil(hours / 24))}d→${hours}h client-side`),
  );

  // 1. Fetch cards
  const cards = source === "naukri"
    ? await fetchNaukriCards()
    : await fetchLinkedInCards(loc!, { hours, pages, maxApplicants, sortBy: CONFIG.linkedinParams.sortBy, log });
  log(`[search] ${cards.length} unique cards fetched`);

  // 2. Shared pipeline. Naukri JDs are inline → skip the LinkedIn enrich step.
  const { jobs, stats } = await runPipeline(cards, { enrich: source === "linkedin", log });
  log(`[search] done → ${jobs.length} jobs`);

  // 3. Write CSV to output/ named after the search params.
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${source}-${city.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${hours}h-${pages}p-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const csvPath = writeCsv(jobs, stamp);
  log(`[search] CSV → ${csvPath}`);

  process.stdout.write(
    JSON.stringify({
      source, city, hours, pages,
      stats: {
        fetched:          stats.fetched,
        prefiltered:      stats.prefiltered,
        prefilterDropped: stats.prefilterDropped,
        enriched:         stats.enriched,
        final:            stats.final,
      },
      jobs,
    }) + "\n",
  );
}

main().catch((err) => {
  log("[search] FATAL:", err);
  process.exit(1);
});

/**
 * Shared Naukri guest-search card fetching — used by BOTH the on-demand CLI
 * (src/search.ts) and the hot checker (src/naukri-hot.ts).
 *
 * Extracted out of src/search.ts so the freshness-window logic (sort=f below
 * 24h, day-granular jobAge narrowed client-side off createdDate, early-stop
 * once a page goes stale) lives in exactly one place. See
 * memory "naukri-nkparam-unblock" for the measurements behind these choices.
 */

import { publicEncrypt, constants } from "node:crypto";
import { CONFIG } from "../config.js";
import { politeFetch, HttpError } from "./http.js";
import type { Job } from "./types.js";

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

export interface FetchNaukriOpts {
  hours: number;
  pages: number;
  terms: string[];
  /** Gate priority (see politeFetch): 0 = hot checker jumps the queue, 1 = sweep. */
  priority?: number;
  log?: (...a: unknown[]) => void;
}

/**
 * Sort order follows the WINDOW — see memory "naukri-nkparam-unblock" for the
 * measurement. hours>=24 → "r" (relevance; the day-wide window barely filters
 * so the server ranking decides what you see). hours<24 → "f" (freshest;
 * newest-first makes the in-window cards exactly the first N, so a few pages
 * + early-stop captures the whole window without wasting pages).
 */
function naukriSort(hours: number): "r" | "f" {
  return hours >= 24 ? "r" : "f";
}

function naukriUrl(keyword: string, location: string, page: number, hours: number): string {
  const p = new URLSearchParams({
    noOfResults: "20",
    urlType: "search_by_key_loc",
    searchType: "adv",
    keyword,
    k: keyword,
    location,
    l: location,
    pageNo: String(page),
    sort: naukriSort(hours),
    jobAge: String(Math.max(1, Math.ceil(hours / 24))),
  });
  // Off by default — see CONFIG.experience.naukriYears for why (it brackets bands,
  // so it deletes wide/senior-banded frontend roles). filter.ts cuts seniority.
  if (CONFIG.experience.naukriYears !== null) p.set("experience", String(CONFIG.experience.naukriYears));
  return `${CONFIG.endpoints.naukri}?${p.toString()}`;
}

/** Cards for one Naukri page, or null at end-of-results for this keyword. */
async function fetchNaukriPage(
  keyword: string, location: string, page: number, hours: number, first: boolean, priority?: number,
): Promise<Job[] | null> {
  let body: string;
  try {
    body = await politeFetch(naukriUrl(keyword, location, page, hours), {
      noDelay: first,
      priority,
      headers: { ...CONFIG.naukriHeaders, nkparam: mintNkparam(), Accept: "application/json" },
      label: `naukri "${keyword}" @ ${location} p${page}`,
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
      location: nkPlaceholder(j, "location") ?? location,
      url: j.jdURL
        ? (/^https?:\/\//.test(j.jdURL) ? j.jdURL : `https://www.naukri.com${j.jdURL.startsWith("/") ? "" : "/"}${j.jdURL}`)
        : `https://www.naukri.com/job-listings-${j.jobId}`,
      description: `${j.jobDescription ?? ""} ${j.tagsAndSkills ?? ""}`.trim(),
      postedAt: Number.isFinite(postedMs) ? new Date(postedMs).toISOString() : null,
      salary: nkPlaceholder(j, "salary"),
      experience: nkPlaceholder(j, "experience"),
      remote: /remote/i.test(nkPlaceholder(j, "location") ?? location),
      tags: (j.tagsAndSkills ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      applicants: null,
    }];
  });
}

/**
 * Cards from Naukri for one location, narrowed to `opts.hours` client-side.
 *
 * Naukri's `jobAge` is day-granular, so sub-day windows are applied here off
 * `createdDate`. The early-stop (bail on a keyword the moment a page goes
 * stale) is valid ONLY under sort=f (hours<24) — see naukriSort() above; it
 * must stay in step with that or it silently loses results.
 */
export async function fetchNaukriCards(location: string, opts: FetchNaukriOpts): Promise<Job[]> {
  const log = opts.log ?? (() => {});
  const canEarlyStop = naukriSort(opts.hours) === "f";
  const cutoff = Date.now() - opts.hours * 3600_000;
  const seen = new Set<string>();
  const out: Job[] = [];
  let stale = 0;
  let first = true;
  for (const kw of opts.terms) {
    keyword: for (let p = 1; p <= opts.pages; p++) {
      const cards = await fetchNaukriPage(kw, location, p, opts.hours, first, opts.priority);
      first = false;
      if (cards === null) { log(`  naukri "${kw}" @ ${location} p${p}: end of results`); break; }
      let fresh = 0;
      for (const j of cards) {
        const t = j.postedAt ? Date.parse(j.postedAt) : NaN;
        if (!Number.isFinite(t) || t < cutoff) {
          stale++;
          // Undated cards are skipped, never taken as proof we're past the window.
          if (canEarlyStop && Number.isFinite(t)) {
            log(`  naukri "${kw}" @ ${location} p${p}: ${fresh} within ${opts.hours}h, then past the window — stopping`);
            break keyword;
          }
          continue;
        }
        fresh++;
        if (!seen.has(j.externalId)) { seen.add(j.externalId); out.push(j); }
      }
      log(`  naukri "${kw}" @ ${location} p${p}: ${cards.length} cards, ${fresh} within ${opts.hours}h`);
    }
  }
  log(`[naukri] ${stale} cards outside the ${opts.hours}h window dropped`);
  return out;
}

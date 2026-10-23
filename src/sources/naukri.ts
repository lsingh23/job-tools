import { publicEncrypt, constants } from "node:crypto";
import { CONFIG } from "../../config.js";
import { politeFetch, HttpError } from "../http.js";
import type { Job } from "../types.js";
import type { Source } from "./base.js";

/**
 * Naukri — LOCAL-ONLY (residential India IP). Logged-out, no auth.
 *
 * REALITY (verified 2026-06-23): the guest JSON endpoint `jobapi/v3/search`
 * isn't actually CAPTCHA-gated. The `406 {"message":"recaptcha required"}` is a
 * red herring for ONE missing header — `nkparam` — which is generated entirely
 * client-side. So we mint it ourselves: no headless browser, no CAPTCHA solver,
 * no proxy, no login.
 *
 * `nkparam` = base64( RSA_publicEncrypt( NAUKRI_PUBLIC_KEY, plaintext ) )
 * where plaintext = "v0|" + Date.now() + "|121_srp". PKCS#1 v1.5 random padding
 * makes every token look unique/one-time, but we can mint unlimited fresh ones
 * locally in microseconds. A fresh token is minted PER REQUEST (and per retry).
 *
 * See README → "Naukri — the nkparam unblock" for the full write-up + caveats.
 */

/** Mint a fresh, single-use `nkparam` token (cheap; do it per request). */
function mintNkparam(): string {
  const plaintext = `v0|${Date.now()}|${CONFIG.naukriNkparamSuffix}`;
  const encrypted = publicEncrypt(
    { key: CONFIG.naukriPublicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(plaintext, "utf8"),
  );
  return encrypted.toString("base64");
}

interface NaukriJob {
  jobId?: string;
  title?: string;
  companyName?: string;
  placeholders?: { type: string; label: string }[];
  jdURL?: string;
  createdDate?: string;
  footerPlaceholderLabel?: string;
  tagsAndSkills?: string;
  jobDescription?: string;
}

function placeholder(j: NaukriJob, type: string): string | null {
  return j.placeholders?.find((p) => p.type === type)?.label ?? null;
}

/** Naukri's `jdURL` is a root-relative path (e.g. "/job-listings-…"); make it absolute. */
function absoluteUrl(jdURL: string | undefined, jobId: string): string {
  if (!jdURL) return `https://www.naukri.com/job-listings-${jobId}`;
  if (/^https?:\/\//.test(jdURL)) return jdURL;
  return `https://www.naukri.com${jdURL.startsWith("/") ? "" : "/"}${jdURL}`;
}

export const naukriSource: Source = {
  name: "naukri",
  async fetchJobs(): Promise<Job[]> {
    const out: Job[] = [];
    const seen = new Set<string>();

    for (const loc of CONFIG.locations.naukri) {
      for (const term of CONFIG.linkedinSearchTerms) {
        for (let page = 1; page <= CONFIG.sources.naukri.maxPages; page++) {
          const p = new URLSearchParams({
            noOfResults: "20",
            urlType: "search_by_key_loc",
            searchType: "adv",
            keyword: term,
            k: term,
            location: loc,
            l: loc,
            pageNo: String(page),
            // Relevance, not freshness — `keyword` matches title + skills + JD, and
            // freshness-order floats whichever bulk poster posted last to the top.
            // Same reasoning (and measurement) as src/search.ts naukriUrl().
            sort: "r",
            [CONFIG.freshness.naukri_param]: CONFIG.freshness.naukri_value, // jobAge=1 (last day)
          });
          // Off by default — see CONFIG.experience.naukriYears. Naukri keeps only
          // bands that BRACKET the value, which drops wide/senior-banded frontend
          // roles outright; filter.ts does the seniority cut client-side instead.
          if (CONFIG.experience.naukriYears !== null) p.set("experience", String(CONFIG.experience.naukriYears));
          const url = `${CONFIG.endpoints.naukri}?${p.toString()}`;
          let body: string;
          try {
            body = await politeFetch(url, {
              // Fresh nkparam per request (and politeFetch retries reuse this; on a
              // hard 406 a re-run mints anew). Token is single-use by design.
              headers: { ...CONFIG.naukriHeaders, nkparam: mintNkparam(), Accept: "application/json" },
              // `sort` and `experience` are part of the key: those are different
              // result sets, not stale copies of the same one.
              cacheKey: `naukri:${term}:${loc}:${page}:e${CONFIG.experience.naukriYears ?? "any"}:r`,
              label: `naukri "${term}" @ ${loc} p${page}`,
            });
          } catch (err) {
            // When a query has fewer pages than maxPages, Naukri 400s the overflow
            // page ("Requested page number doesn't exists") instead of returning an
            // empty list — that's the end of this query's results, not breakage.
            if (err instanceof HttpError && err.status === 400 && /pageNo/.test(err.body)) break;
            throw err;
          }

          let data: { jobDetails?: NaukriJob[]; noOfJobs?: number; message?: string };
          try {
            data = JSON.parse(body);
          } catch {
            throw new Error("Naukri returned non-JSON (likely an anti-bot HTML challenge).");
          }
          if (data.message && /recaptcha/i.test(data.message)) {
            throw new Error(
              "Naukri returned 'recaptcha required' despite a minted nkparam — the RSA " +
                "public key or the 'v0|…|121_srp' plaintext likely rotated. Re-extract " +
                "both from Naukri's current app JS (see README → Naukri).",
            );
          }
          if (!Array.isArray(data.jobDetails)) {
            // When a query is exhausted on a clean page boundary, Naukri returns a
            // 200 with `noOfJobs:0` and OMITS `jobDetails` entirely (it used to send
            // an empty array). That's end-of-results, not breakage. Only treat a
            // missing array as a real shape change when jobs actually exist.
            if (!data.noOfJobs) break;
            throw new Error("Naukri JSON missing 'jobDetails' despite noOfJobs>0 — endpoint shape changed (check config).");
          }
          if (data.jobDetails.length === 0) break; // no more pages for this query

          for (const j of data.jobDetails) {
            if (!j.jobId || !j.title) continue;
            const key = `naukri:${j.jobId}`;
            if (seen.has(key)) continue;
            seen.add(key);

            // Naukri's location placeholder can be "Remote", "On-site",
            // "Hybrid" or a city, and it is the ONLY thing consulted here.
            // `loc` (the search location, one of which is "Remote") must never
            // stand in for it: inheriting the sweep is what made LinkedIn call
            // Delhi office jobs Remote (see readWorkArrangement in
            // sources/linkedin.ts). Naukri does honour `location=Remote` today
            // — 137/137 cards across 3 keywords came back labelled Remote,
            // none missing (2026-09-18) — so this costs nothing now and stops
            // the day the filter starts leaking like LinkedIn's does.
            const ownLocation = placeholder(j, "location");
            const location = ownLocation ?? loc;
            const isRemote = ownLocation !== null && /remote/i.test(ownLocation) && !/hybrid/i.test(ownLocation);

            out.push({
              source: "naukri",
              externalId: key,
              title: j.title,
              company: j.companyName ?? "",
              location,
              url: absoluteUrl(j.jdURL, j.jobId),
              description: `${j.jobDescription ?? ""} ${j.tagsAndSkills ?? ""}`.trim(),
              postedAt: j.createdDate ? new Date(j.createdDate).toISOString() : null,
              salary: placeholder(j, "salary"),
              experience: placeholder(j, "experience"),
              remote: isRemote,
              tags: (j.tagsAndSkills ?? "").split(",").map((s) => s.trim()).filter(Boolean),
            });
          }
        }
      }
    }
    return out;
  },
};

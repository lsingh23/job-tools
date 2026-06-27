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
            sort: "f", // freshness
            experience: String(CONFIG.experience.years), // server-side: only bands bracketing this
            [CONFIG.freshness.naukri_param]: CONFIG.freshness.naukri_value, // jobAge=1 (last day)
          });
          const url = `${CONFIG.endpoints.naukri}?${p.toString()}`;
          let body: string;
          try {
            body = await politeFetch(url, {
              // Fresh nkparam per request (and politeFetch retries reuse this; on a
              // hard 406 a re-run mints anew). Token is single-use by design.
              headers: { ...CONFIG.naukriHeaders, nkparam: mintNkparam(), Accept: "application/json" },
              cacheKey: `naukri:${term}:${loc}:${page}:e${CONFIG.experience.years}`,
              label: `naukri "${term}" @ ${loc} p${page}`,
            });
          } catch (err) {
            // When a query has fewer pages than maxPages, Naukri 400s the overflow
            // page ("Requested page number doesn't exists") instead of returning an
            // empty list — that's the end of this query's results, not breakage.
            if (err instanceof HttpError && err.status === 400 && /pageNo/.test(err.body)) break;
            throw err;
          }

          let data: { jobDetails?: NaukriJob[]; message?: string };
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
            throw new Error("Naukri JSON missing 'jobDetails' — endpoint shape changed (check config).");
          }
          if (data.jobDetails.length === 0) break; // no more pages for this query

          for (const j of data.jobDetails) {
            if (!j.jobId || !j.title) continue;
            const key = `naukri:${j.jobId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
              source: "naukri",
              externalId: key,
              title: j.title,
              company: j.companyName ?? "",
              location: placeholder(j, "location") ?? loc,
              url: absoluteUrl(j.jdURL, j.jobId),
              description: `${j.jobDescription ?? ""} ${j.tagsAndSkills ?? ""}`.trim(),
              postedAt: j.createdDate ? new Date(j.createdDate).toISOString() : null,
              salary: placeholder(j, "salary"),
              experience: placeholder(j, "experience"),
              remote: /remote/i.test(loc),
              tags: (j.tagsAndSkills ?? "").split(",").map((s) => s.trim()).filter(Boolean),
            });
          }
        }
      }
    }
    return out;
  },
};

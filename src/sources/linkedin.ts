import * as cheerio from "cheerio";
import { CONFIG } from "../../config.js";
import { politeFetch } from "../http.js";
import type { Job } from "../types.js";
import type { Source } from "./base.js";

/**
 * LinkedIn — LOGGED-OUT GUEST endpoint only. We never authenticate (see
 * CONFIG.forbidLogin); this is the same public API the unauthenticated jobs
 * page calls. Response is an HTML fragment of <li> job cards.
 *
 * Freshness: f_TPR=r86400 → posted in the last 24h (server-side).
 */

const sel = CONFIG.linkedinSelectors;

/** Pull the numeric job id from a guest job URL or an entity-urn attribute. */
function extractId(href: string | undefined, urn: string | undefined): string | null {
  const fromUrn = urn?.match(/(\d{6,})/)?.[1];
  if (fromUrn) return fromUrn;
  const fromUrl = href?.match(/-(\d{6,})(?:\?|$)/)?.[1] ?? href?.match(/\/(\d{6,})/)?.[1];
  return fromUrl ?? null;
}

function buildUrl(
  term: string,
  loc: { geoId?: string; location?: string },
  remote: boolean,
  start: number,
): string {
  const p = new URLSearchParams({
    keywords: term,
    f_TPR: CONFIG.freshness.linkedin_f_TPR,
    start: String(start),
  });
  if (loc.geoId) p.set("geoId", loc.geoId);
  else if (loc.location) p.set("location", loc.location);
  if (remote) p.set("f_WT", CONFIG.linkedinParams.f_WT_remote);
  if (CONFIG.experience.linkedinLevels.length) p.set("f_E", CONFIG.experience.linkedinLevels.join(","));
  return `${CONFIG.endpoints.linkedin}?${p.toString()}`;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Enrich a set of LinkedIn jobs in place by fetching each one's guest
 * job-detail page for the full description (+ salary if shown). Each fetch is
 * polite (delay/backoff/cache). A per-job failure is swallowed — we keep the
 * title-only data rather than dropping the job or crashing the run.
 * Returns the count successfully enriched.
 */
export async function enrichLinkedInJobs(jobs: Job[]): Promise<number> {
  const dsel = CONFIG.linkedinDetailSelectors;
  let enriched = 0;
  for (const job of jobs) {
    const id = job.externalId.replace(/^linkedin:/, "");
    const url = `${CONFIG.endpoints.linkedinDetail}${id}`;
    try {
      const html = await politeFetch(url, { cacheKey: `li-detail:${id}`, label: `linkedin detail ${id}` });
      const $ = cheerio.load(html);
      const desc = stripHtml($(dsel.description).html() ?? "");
      if (desc) job.description = desc;
      const salary = $(dsel.salary).first().text().trim();
      if (salary) job.salary = salary;
      const applicants = $(dsel.applicants).first().text().trim();
      if (applicants) job.applicants = applicants;

      // Job criteria list: Seniority level / Employment type / Job function /
      // Industries, in that order but not all always present — match by label.
      $(dsel.criteriaItem).each((_, item) => {
        const label = $(item).find(dsel.criteriaHeader).text().trim();
        const value = $(item).find(dsel.criteria).text().trim();
        if (!label || !value) return;
        if (/seniority/i.test(label)) job.tags = [...job.tags, value];
        else if (/employment type/i.test(label)) job.employmentType = value;
        else if (/job function/i.test(label)) job.jobFunction = value;
        else if (/industr/i.test(label)) job.industries = value;
      });

      // Apply type: LinkedIn distinguishes "onsite" (Easy Apply, stays on
      // LinkedIn) from "offsite" (redirects to the company's own site/ATS)
      // via the apply button's tracking-control-name.
      const applyTrack = $(dsel.applyButton).first().attr("data-tracking-control-name") ?? "";
      if (applyTrack.includes("apply-link-onsite")) job.applyType = "easy_apply";
      else if (applyTrack.includes("apply-link-offsite")) job.applyType = "external";

      // Recruiter/HR profile, when LinkedIn shows a "message the recruiter" block.
      const recruiterEl = $(dsel.recruiterLink).first();
      const recruiterHref = recruiterEl.attr("href");
      const recruiterName = recruiterEl.attr("aria-label")?.replace(/^Message\s+/i, "").trim();
      if (recruiterHref) {
        const profileMatch = recruiterHref.match(/session_redirect=([^&]+)/);
        job.hrProfileUrl = profileMatch ? decodeURIComponent(profileMatch[1]!) : recruiterHref;
        if (recruiterName) job.hrName = recruiterName;
      }

      if (desc) enriched++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`    (enrich skipped for ${id}: ${msg})`);
    }
  }
  return enriched;
}

export const linkedinSource: Source = {
  name: "linkedin",
  async fetchJobs(): Promise<Job[]> {
    if (CONFIG.forbidLogin) {
      // Defensive: this source must never carry auth. No cookies, no tokens.
    }

    const out: Job[] = [];
    const seen = new Set<string>();
    const maxPages = CONFIG.sources.linkedin.maxPages;
    const step = CONFIG.linkedinParams.pageStep;

    // Priority boolean terms first so their higher-signal cards seed the dedupe
    // set before the broad title queries (see CONFIG.linkedinPriorityTerms).
    const terms = [...CONFIG.linkedinPriorityTerms, ...CONFIG.linkedinSearchTerms];

    for (const loc of CONFIG.locations.linkedin) {
      for (const term of terms) {
        for (let page = 0; page < maxPages; page++) {
          const start = page * step;
          const url = buildUrl(term, loc, loc.remote, start);
          const label = `linkedin "${term}" @ ${loc.label} (start=${start})`;
          const html = await politeFetch(url, { cacheKey: `li:${term}:${loc.label}:${start}:E${CONFIG.experience.linkedinLevels.join("")}`, label });

          const $ = cheerio.load(html);
          const cards = $(sel.card);
          if (cards.length === 0) break; // no more results for this query

          let added = 0;
          cards.each((_, el) => {
            const card = $(el);
            const href = card.find(sel.link).attr("href")?.trim();
            const urn = card.find(sel.entityUrn).attr("data-entity-urn") ?? card.attr("data-entity-urn") ?? undefined;
            const id = extractId(href, urn ?? undefined);
            const title = card.find(sel.title).text().trim();
            if (!id || !title) return; // skip malformed card

            const key = `linkedin:${id}`;
            if (seen.has(key)) return;
            seen.add(key);

            const company = card.find(sel.company).text().trim();
            const location = card.find(sel.location).text().trim();
            const dt = card.find(sel.date).attr("datetime");
            const cleanUrl = href ? href.split("?")[0]! : `https://www.linkedin.com/jobs/view/${id}`;

            out.push({
              source: "linkedin",
              externalId: key,
              title,
              company,
              location: location || loc.label,
              url: cleanUrl,
              // Guest cards have no description; title+location feed scoring.
              // The match % for LinkedIn leans on the title (still meaningful).
              description: "",
              postedAt: dt ? new Date(dt).toISOString() : null,
              salary: null, // not exposed on guest cards
              remote: loc.remote,
              tags: [],
            });
            added++;
          });

          if (added === 0) break; // page had cards but none new/valid → stop paginating
        }
      }
    }

    if (out.length === 0) {
      // Distinguish "no jobs" from "blocked/markup changed": an empty parse
      // across every query usually means a block or selector breakage.
      throw new Error(
        "LinkedIn returned 0 parseable jobs across all queries — likely a soft block (429/403) or the card markup changed. Check CONFIG.linkedinSelectors.",
      );
    }
    return out;
  },
};

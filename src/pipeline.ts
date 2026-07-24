/**
 * Shared LinkedIn search pipeline — used by BOTH the on-demand CLI (src/search.ts,
 * one city) and the multi-city collector (src/collect.ts, every city hourly).
 *
 * Two independent stages so the collector can fetch cards for every city first,
 * dedupe the union by externalId, and then run the EXPENSIVE pipeline (per-job
 * enrich + salary + presence) exactly once — instead of paying it per city:
 *
 *   1. fetchLinkedInCards(loc, opts) → Job[]   (cheap: guest card HTML only)
 *   2. runPipeline(cards, opts)      → scored + filtered ScoredJob[]  (expensive)
 *
 * The LinkedIn "search hacks" all live in buildUrl() below (sortBy=DD, f_AL,
 * f_JT, f_E, tuned f_TPR) so there is one place to tune result quality/freshness.
 */

import * as cheerio from "cheerio";
import { CONFIG } from "../config.js";
import { politeFetch } from "./http.js";
import { prefilterByTitle } from "./prefilter.js";
import { enrichLinkedInJobs } from "./sources/linkedin.js";
import { loadKeywords, loadResumeText } from "./resume.js";
import { scoreAll, titleRelevance, classifyTitle } from "./scoring.js";
import { dedupe } from "./dedupe.js";
import { scoreResumeVsJds } from "./tfidf.js";
import { filterJobs } from "./filter.js";
import { enrichWithSalary } from "./salary.js";
import { enrichWithPresence } from "./presence.js";
import type { Job, ScoredJob } from "./types.js";

const sel = CONFIG.linkedinSelectors;

/** A location to search, as stored in CONFIG.locations.linkedin. */
export interface LinkedInLocation {
  label: string;
  geoId?: string;
  location?: string; // free-text fallback when no geoId
  remote?: boolean;
}

export interface FetchCardsOpts {
  hours: number;
  pages: number;
  maxApplicants?: number | null;
  /** Sort order: "DD" = date-descending (freshest first), "R" = relevance. */
  sortBy?: string;
  /** Override the query list (tuning scripts only — production uses TERMS). */
  terms?: string[];
  log?: (...a: unknown[]) => void;
}

/**
 * Every query run per location, in priority order: the tuned pure-title boolean
 * net first, then the anchored fullstack/stack queries, then the plain title
 * terms as a fallback. All three lists live in config (linkedinPriorityTerms /
 * linkedinStackTerms / linkedinSearchTerms) — see the notes there for why the
 * bare stack keywords ("React", "Next.js") were removed.
 *
 * Deduped because linkedinSearchTerms overlaps the other two.
 */
const TERMS = [...new Set([
  ...CONFIG.linkedinPriorityTerms,
  ...CONFIG.linkedinStackTerms,
  ...CONFIG.linkedinSearchTerms,
])];

/**
 * Build a guest jobs-API URL. This is where the LinkedIn search hacks are applied
 * (see config.linkedinParams): sortBy=DD for freshest-first, f_AL=Actively Hiring,
 * f_JT=Full-time/Contract, plus the experience levels and the time window.
 */
function buildUrl(loc: LinkedInLocation, keyword: string, start: number, opts: FetchCardsOpts): string {
  const lp = CONFIG.linkedinParams;
  const p = new URLSearchParams({
    keywords: keyword,
    f_TPR: `r${opts.hours * 3600}`,
    start: String(start),
  });
  if (loc.geoId) p.set("geoId", loc.geoId);
  else p.set("location", loc.location ?? `${loc.label}, India`);
  if (loc.remote) p.set("f_WT", lp.f_WT_remote);
  if (opts.sortBy ?? lp.sortBy) p.set("sortBy", opts.sortBy ?? lp.sortBy);
  if (lp.f_AL) p.set("f_AL", "true");
  if (lp.f_JT) p.set("f_JT", lp.f_JT);
  if (CONFIG.experience.linkedinLevels.length) p.set("f_E", CONFIG.experience.linkedinLevels.join(","));
  if (opts.maxApplicants != null) p.set("f_SB2", String(opts.maxApplicants));
  return `${CONFIG.endpoints.linkedin}?${p.toString()}`;
}

function parseCards(html: string, loc: LinkedInLocation): Job[] {
  const $ = cheerio.load(html);
  const jobs: Job[] = [];
  $(sel.card).each((_, el) => {
    const title = $(el).find(sel.title!).text().trim();
    const company = $(el).find(sel.company!).text().trim();
    const location = $(el).find(sel.location!).text().trim();
    const href = $(el).find(sel.link!).attr("href") ?? "";
    const urn = $(el).find(sel.entityUrn!).attr("data-entity-urn") ?? "";
    const idM = urn.match(/(\d{6,})/) ?? href.match(/-(\d{6,})(?:\?|$)/);
    if (!idM || !title) return;
    const id = idM[1]!;
    jobs.push({
      source: "linkedin",
      externalId: `linkedin:${id}`,
      title,
      company,
      location: location || loc.label,
      url: `https://www.linkedin.com/jobs/view/${id}/`,
      description: "",
      postedAt: null,
      salary: null,
      experience: null,
      remote: !!loc.remote,
      tags: [],
    });
  });
  return jobs;
}

/**
 * Fetch guest cards for ONE location across every search term, deduped by
 * externalId within this location. Freshness is already exact server-side via
 * f_TPR, so no client-side time filtering is needed (unlike Naukri).
 */
export async function fetchLinkedInCards(loc: LinkedInLocation, opts: FetchCardsOpts): Promise<Job[]> {
  const log = opts.log ?? (() => {});
  const seen = new Set<string>();
  const out: Job[] = [];
  let first = true;
  for (const kw of opts.terms ?? TERMS) {
    for (let pg = 0; pg < opts.pages; pg++) {
      let cards: Job[];
      try {
        const html = await politeFetch(buildUrl(loc, kw, pg * 10, opts), {
          noDelay: first,
          label: `"${kw}" @ ${loc.label} p${pg + 1}`,
        });
        cards = parseCards(html, loc);
      } catch {
        cards = [];
      }
      first = false;
      if (!cards.length) { log(`  "${kw}" @ ${loc.label} p${pg + 1}: end of results`); break; }
      log(`  "${kw}" @ ${loc.label} p${pg + 1}: ${cards.length} cards`);
      for (const j of cards) {
        if (!seen.has(j.externalId)) { seen.add(j.externalId); out.push(j); }
      }
    }
  }
  return out;
}

/** A prior verdict on a card, as remembered by the caller's store. */
export interface SeenCard {
  externalId: string;
  description: string;
  decision: "shortlisted" | "dropped";
  decidedAt: Date;
}

/**
 * Optional "have we already read this card?" memory. Injected by the caller
 * rather than imported, so the on-demand CLI (src/search.ts) runs with no DB at
 * all while the collector wires in Neon (src/db.ts). See CONFIG.collect.skipSeenHours.
 */
export interface PipelineMemory {
  lookup(externalIds: string[]): Promise<Map<string, SeenCard>>;
  record(entries: {
    externalId: string; title: string; company?: string; description: string;
    decision: "shortlisted" | "dropped"; reason?: string; score?: number;
  }[]): Promise<void>;
}

export interface PipelineOpts {
  /** Enrich LinkedIn cards with full JDs (per-job detail fetch). Default true. */
  enrich?: boolean;
  /** Prior-verdict store; omit to re-read every card every run. */
  memory?: PipelineMemory;
  /** Attach AmbitionBox salary bands. Default from CONFIG.salary.enabled. */
  salary?: boolean;
  /** Attach online-presence signals for companies AmbitionBox lacks. Default from CONFIG.presence.enabled. */
  presence?: boolean;
  log?: (...a: unknown[]) => void;
}

export interface PipelineStats {
  fetched: number;
  prefiltered: number;
  prefilterDropped: number;
  /** Cards skipped because a previous run already read and rejected them. */
  skippedSeen: number;
  /** Cards scored from a cached JD instead of a fresh detail fetch. */
  reusedJd: number;
  enriched: number;
  final: number;
}

/**
 * The shared scoring pipeline: prefilter → enrich → keyword score → TF-IDF →
 * dedupe → filter → salary → presence. `cards` is the (already deduped) union
 * of guest cards; this runs the expensive per-job/per-company work ONCE over it.
 */
export async function runPipeline(
  cards: Job[],
  opts: PipelineOpts = {},
): Promise<{ jobs: ScoredJob[]; stats: PipelineStats }> {
  const log = opts.log ?? (() => {});
  const doEnrich = opts.enrich ?? true;
  const doSalary = opts.salary ?? CONFIG.salary.enabled;
  const doPresence = opts.presence ?? CONFIG.presence.enabled;

  // 1. Title pre-filter
  const { kept: prefiltered, dropped: preDropped } = prefilterByTitle(cards);
  log(`[pipeline] prefilter: ${cards.length} → ${prefiltered.length} kept, ${preDropped.length} dropped`);
  for (const d of preDropped.slice(0, 4)) log(`  drop: "${d.job.title}" (${d.reason})`);

  // 2. Prior-verdict gate: drop cards a recent run already READ and rejected,
  //    and reuse the stored JD for ones it kept. Both save an HTTP round-trip;
  //    the point is to hand the enrich budget to cards nobody has looked at yet.
  const skipMs = CONFIG.collect.skipSeenHours * 3600_000;
  let candidates = prefiltered;
  let nSkipped = 0;
  let nReused = 0;
  if (opts.memory && skipMs > 0) {
    const seen = await opts.memory.lookup(prefiltered.map((j) => j.externalId));
    const fresh = (s: SeenCard) => Date.now() - s.decidedAt.getTime() < skipMs;
    candidates = prefiltered.filter((j) => {
      const s = seen.get(j.externalId);
      if (!s || !fresh(s)) return true;
      if (s.decision === "dropped") { nSkipped++; return false; }
      // Previously shortlisted: keep it in the day's set, but score it off the
      // cached JD (re-scored from scratch, so scoring changes still apply).
      if (s.description) { j.description = s.description; nReused++; }
      return true;
    });
    log(`[pipeline] seen-cache: ${nSkipped} already-rejected skipped, ${nReused} JDs reused, ${candidates.length} to consider`);
  }

  // 3. Enrich whatever still has no JD, best-title-fit first. titleRelevance is
  //    class-banded now (frontend → fullstack → generic), so the budget goes to
  //    frontend titles first and generic ones only get the leftovers.
  let nEnriched = 0;
  if (doEnrich) {
    const needJd = candidates.filter((j) => !j.description);
    const byTitleFit = [...needJd].sort((a, b) => titleRelevance(b.title) - titleRelevance(a.title));
    const cap = CONFIG.linkedinEnrich.maxEnrich;
    const toEnrich = byTitleFit.slice(0, cap);
    if (needJd.length > cap)
      log(`[pipeline] NOTE: ${needJd.length} need a JD > enrich cap ${cap} — enriching the ${cap} best-title-fit; the rest score 0 and drop (they are NOT cached as rejected, so a later run retries them).`);
    const classes = toEnrich.reduce<Record<string, number>>((m, j) => {
      const c = classifyTitle(j.title); m[c] = (m[c] ?? 0) + 1; return m;
    }, {});
    log(`[pipeline] enriching ${toEnrich.length} jobs… (${Object.entries(classes).map(([k, v]) => `${v} ${k}`).join(", ")})`);
    nEnriched = await enrichLinkedInJobs(toEnrich);
    log(`[pipeline] enriched ${nEnriched}/${toEnrich.length}`);
  }

  // 4. Keyword score
  const keywords = loadKeywords();
  const scored = scoreAll(candidates, keywords);

  // 5. TF-IDF similarity vs resume
  const resumeText = loadResumeText();
  if (resumeText) {
    const jdTexts = scored.map((j) => j.description || j.title);
    const sims = scoreResumeVsJds(resumeText, jdTexts);
    scored.forEach((j, i) => { j.tfidfScore = sims[i]; });
    log(`[pipeline] TF-IDF scores attached`);
  }

  // 6. Dedupe, then the shortlist filter (off-target / over-experience / low-fit)
  const deduped = dedupe(scored);
  const { kept: filtered, dropped } = filterJobs(deduped);
  if (dropped.length) {
    log(`[pipeline] filter: ${deduped.length} → ${filtered.length} kept, ${dropped.length} dropped`);
    for (const d of dropped.slice(0, 6)) log(`  drop: "${d.job.title}" (${d.reason})`);
  }
  filtered.sort((a, b) => b.score - a.score);

  // 7. Remember the verdicts — but ONLY for cards we actually read. A card that
  //    fell off the far side of the enrich cap has an empty JD and a score of 0;
  //    caching that as "rejected" would blacklist a job nobody ever looked at.
  if (opts.memory) {
    const judged = [
      ...filtered.map((j) => ({ job: j, decision: "shortlisted" as const, reason: undefined })),
      ...dropped.map((d) => ({ job: d.job, decision: "dropped" as const, reason: d.reason })),
    ].filter((e) => e.job.description);
    await opts.memory.record(judged.map((e) => ({
      externalId: e.job.externalId,
      title: e.job.title,
      company: e.job.company,
      description: e.job.description,
      decision: e.decision,
      reason: e.reason,
      score: e.job.score,
    })));
    log(`[pipeline] seen-cache: recorded ${judged.length} verdicts`);
  }

  // 8. Salary bands, then presence for whatever AmbitionBox couldn't resolve.
  if (doSalary && filtered.length) {
    const uniq = new Set(filtered.map((j) => j.company.trim()).filter(Boolean)).size;
    log(`[pipeline] salary: looking up AmbitionBox bands for ${uniq} companies…`);
    const { matched, unresolved } = await enrichWithSalary(filtered);
    log(`[pipeline] salary: attached ${matched}/${filtered.length} jobs`);

    if (doPresence && unresolved.length) {
      log(`[pipeline] presence: no AmbitionBox page for ${unresolved.length} companies — checking footprint…`);
      const t = await enrichWithPresence(filtered, unresolved);
      log(`[pipeline] presence: ${t.operating} operating, ${t.thin} thin, ${t.unverified} unverified`);
    }
  }

  return {
    jobs: filtered,
    stats: {
      fetched: cards.length,
      prefiltered: prefiltered.length,
      prefilterDropped: preDropped.length,
      skippedSeen: nSkipped,
      reusedJd: nReused,
      enriched: nEnriched,
      final: filtered.length,
    },
  };
}

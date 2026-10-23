/**
 * Shared LinkedIn search pipeline — used by BOTH the on-demand CLI (src/search.ts,
 * one city) and the multi-city collector (src/collect.ts, every city every 30 min).
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
import { enrichLinkedInJobs, readWorkArrangement } from "./sources/linkedin.js";
import { loadKeywords, loadResumeText } from "./resume.js";
import { scoreAll, scoreJob, titleRelevance, classifyTitle } from "./scoring.js";
import { dedupe } from "./dedupe.js";
import { verdictFingerprint } from "./fingerprint.js";
import { scoreResumeVsJds } from "./tfidf.js";
import { rankJobs, enrichPriority, isBlockedCompany } from "./filter.js";
import { enrichWithSalary } from "./salary.js";
import { enrichWithPresence } from "./presence.js";
import { isReachableFromIndia } from "./geo.js";
import { markDirectApply, shouldAlertDirect } from "./direct-apply.js";
import type { Job, ScoredJob } from "./types.js";

const sel = CONFIG.linkedinSelectors;

/** A location to search, as stored in CONFIG.locations.linkedin. */
export interface LinkedInLocation {
  label: string;
  geoId?: string;
  location?: string; // free-text fallback when no geoId
  remote?: boolean;
  /**
   * Page depth for THIS location, overriding FetchCardsOpts.pages. Exists for
   * the national "India" sweep, which is the one query whose deeper pages still
   * come back full (the city queries hit end-of-results early); raising the
   * global page count to suit it would just buy duplicates everywhere else.
   */
  pages?: number;
}

export interface FetchCardsOpts {
  hours: number;
  pages: number;
  maxApplicants?: number | null;
  /** Sort order: "DD" = date-descending (freshest first), "R" = relevance. */
  sortBy?: string;
  /** Override the query list (tuning scripts only — production uses TERMS). */
  terms?: string[];
  /** Gate priority (see politeFetch): 0 = hot checker jumps the queue, 1 = sweep. */
  priority?: number;
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

function parseCards(html: string, loc: LinkedInLocation, log?: (...a: unknown[]) => void): Job[] {
  const $ = cheerio.load(html);
  const jobs: Job[] = [];
  $(sel.card).each((_, el) => {
    const title = $(el).find(sel.title!).text().trim();
    const company = $(el).find(sel.company!).text().trim();
    // WORK-ARRANGEMENT GATE. Same rule as the geo gate below: the CARD is the
    // authority, never the query. `f_WT=2` on the "Remote (India)" sweep is
    // advisory on the guest endpoint and gets padded out with ordinary office
    // jobs once the remote pool runs dry, so inheriting `loc.remote` here
    // stamped those Remote (Hudle, Delhi-only, 2026-09-18). Unknown = not
    // remote; the dashboard shows those as "Remote?" instead.
    const wa = readWorkArrangement($(el).find(sel.location!).text());
    const location = wa.location;
    const href = $(el).find(sel.link!).attr("href") ?? "";
    const urn = $(el).find(sel.entityUrn!).attr("data-entity-urn") ?? "";
    const idM = urn.match(/(\d{6,})/) ?? href.match(/-(\d{6,})(?:\?|$)/);
    if (!idM || !title) return;
    // GEO GATE. The card, not the query, is the authority on where a job is:
    // geoId is advisory on the guest endpoint and gets dropped once the in-geo
    // pool runs dry (see src/geo.ts for the measurement). Logged, never silent.
    if (!isReachableFromIndia(location)) {
      log?.(`    geo-drop: ${title} @ ${location}`);
      return;
    }
    const id = idM[1]!;
    jobs.push({
      source: "linkedin",
      externalId: `linkedin:${id}`,
      title,
      company,
      location: location || loc.label,
      url: `https://www.linkedin.com/jobs/view/${id}/`,
      description: "",
      // Deliberately null, and NOT the card's <time datetime> — that stamp is
      // DATE-only ("2026-08-11"), so parsing it pins every job to midnight UTC
      // and a role posted this morning reads as up to 30h old. first_seen_at is
      // strictly better here: the guest search is fenced server-side to
      // CONFIG.freshness.windowHours (2h), so a card we saw at 14:05 was posted
      // after 12:05, which the date stamp can never tell you. The dashboard's
      // Posted facet falls back to first_seen_at for exactly this reason and
      // marks it with a `*`.
      postedAt: null,
      salary: null,
      experience: null,
      remote: wa.arrangement === "remote",
      workArrangement: wa.arrangement,
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
  const pages = loc.pages ?? opts.pages;
  for (const kw of opts.terms ?? TERMS) {
    for (let pg = 0; pg < pages; pg++) {
      let cards: Job[];
      try {
        const html = await politeFetch(buildUrl(loc, kw, pg * 10, opts), {
          noDelay: first,
          priority: opts.priority,
          label: `"${kw}" @ ${loc.label} p${pg + 1}`,
        });
        cards = parseCards(html, loc, log);
      } catch {
        cards = [];
      }
      first = false;
      if (!cards.length) { log(`  "${kw}" @ ${loc.label} p${pg + 1}: no usable cards (end of results, or all geo-dropped)`); break; }
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
  /** Scoring/filter fingerprint the verdict was made under (null = pre-upgrade). */
  configHash?: string | null;
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
    decision: "shortlisted" | "dropped"; reason?: string; score?: number; configHash?: string;
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
  /**
   * STREAMING HOOK. Called mid-run with any job that scores at least
   * `CONFIG.notify.hotScore` the moment its JD is read — long before the batch
   * finishes. The caller decides what to do with it (persist it, alert on it).
   *
   * The score handed over is PROVISIONAL: scored alone, a job cannot receive the
   * bulk-posting penalty (which counts a company's roles across the batch) and
   * has no TF-IDF/salary/presence attached yet. The end-of-run result is
   * authoritative and overwrites it. This is the right trade — a banner 15
   * minutes earlier is worth more than a penalty that applies to a minority of
   * jobs, and the stored row is corrected before you act on it.
   */
  onScored?: (job: ScoredJob) => Promise<void> | void;
  /** Gate priority for every LinkedIn request this run makes (see politeFetch). */
  priority?: number;
  /** Override CONFIG.linkedinEnrich.maxEnrich — the hot checker caps each tick far lower. */
  maxEnrich?: number;
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

  // 0. Blocked companies — the one genuine DROP in this pipeline (see
  //    CONFIG.blockedCompanies / isBlockedCompany). Applied earliest, before
  //    the enrich budget is spent on a card that will never be shown.
  const blocked: string[] = [];
  cards = cards.filter((j) => {
    const hit = isBlockedCompany(j.company);
    if (hit) { blocked.push(`${j.title} @ ${j.company}`); return false; }
    return true;
  });
  if (blocked.length) {
    log(`[pipeline] blocked: ${blocked.length} jobs from excluded companies dropped`);
    for (const b of blocked.slice(0, 4)) log(`  blocked: "${b}"`);
  }

  // 1. Title triage — NOT a filter any more. Nothing is discarded here; the
  //    verdict only decides who gets the limited JD-fetch budget first (step 3)
  //    and later becomes a point penalty (filter.ts). Cards that would once have
  //    been deleted on title alone now just start at the back of the queue.
  const { dropped: preDropped } = prefilterByTitle(cards);
  const prefiltered = cards;
  log(`[pipeline] triage: ${cards.length} cards — ${preDropped.length} look off-target on title (penalised, not dropped)`);
  for (const d of preDropped.slice(0, 4)) log(`  low-priority: "${d.job.title}" (${d.reason})`);

  // 2. Prior-verdict gate: drop cards a recent run already READ and rejected,
  //    and reuse the stored JD for ones it kept. Both save an HTTP round-trip;
  //    the point is to hand the enrich budget to cards nobody has looked at yet.
  const skipMs = CONFIG.collect.skipSeenHours * 3600_000;
  let candidates = prefiltered;
  let nSkipped = 0;
  let nReused = 0;
  let nStale = 0;
  const fp = verdictFingerprint();
  if (opts.memory && skipMs > 0) {
    const seen = await opts.memory.lookup(prefiltered.map((j) => j.externalId));
    const fresh = (s: SeenCard) => Date.now() - s.decidedAt.getTime() < skipMs;
    candidates = prefiltered.filter((j) => {
      const s = seen.get(j.externalId);
      if (!s || !fresh(s)) return true;
      // A rejection is only reusable under the config that produced it. If any
      // scoring/filter knob has changed since, re-read the card instead of
      // silently honouring a verdict the current rules might reverse.
      if (s.decision === "dropped" && s.configHash !== fp) { nStale++; return true; }
      if (s.decision === "dropped") { nSkipped++; return false; }
      // Previously shortlisted: keep it in the day's set, but score it off the
      // cached JD (re-scored from scratch, so scoring changes still apply).
      if (s.description) { j.description = s.description; nReused++; }
      return true;
    });
    log(`[pipeline] seen-cache: ${nSkipped} already-rejected skipped, ${nReused} JDs reused, ${candidates.length} to consider` +
        (nStale ? ` — ${nStale} rejections re-opened (scoring config changed, fp ${fp})` : ""));
  }

  // 3. Enrich whatever still has no JD, best-title-fit first. titleRelevance is
  //    class-banded now (frontend → fullstack → generic), so the budget goes to
  //    frontend titles first and generic ones only get the leftovers.
  let nEnriched = 0;
  if (doEnrich) {
    const needJd = candidates.filter((j) => !j.description);
    // Priority = how promising the card looks before reading it: frontend titles
    // first, off-target/backend/agency titles last (enrichPriority), with
    // titleRelevance breaking ties inside a band.
    const byTitleFit = [...needJd].sort((a, b) =>
      (enrichPriority(b) - enrichPriority(a)) || (titleRelevance(b.title) - titleRelevance(a.title)));
    const cap = opts.maxEnrich ?? CONFIG.linkedinEnrich.maxEnrich;
    const toEnrich = byTitleFit.slice(0, cap);
    if (needJd.length > cap)
      log(`[pipeline] NOTE: ${needJd.length} need a JD > enrich cap ${cap} — enriching the ${cap} best-title-fit; the rest score 0 and drop (they are NOT cached as rejected, so a later run retries them).`);
    const classes = toEnrich.reduce<Record<string, number>>((m, j) => {
      const c = classifyTitle(j.title); m[c] = (m[c] ?? 0) + 1; return m;
    }, {});
    log(`[pipeline] enriching ${toEnrich.length} jobs… (${Object.entries(classes).map(([k, v]) => `${v} ${k}`).join(", ")})`);
    // Score each JD as it lands so a strong job can surface immediately. Note
    // scoreJob returns a NEW object, so the provisional pass cannot corrupt the
    // card that the batch pass below re-scores from scratch.
    const onEnriched = opts.onScored
      ? async (job: Job) => {
          const [provisional] = rankJobs([scoreJob(job, loadKeywords())]).kept;
          if (!provisional) return;
          // Scan the JD the instant it lands. This is the ONLY place a
          // direct-apply posting can be caught early, and it is deliberately
          // OR'd with the score gate rather than nested inside it: a "send your
          // CV to hr@…" job that scores 31% must still surface now, because the
          // value there is the open inbox, not the match.
          markDirectApply(provisional);
          const direct = shouldAlertDirect(provisional);
          if (provisional.score >= CONFIG.notify.hotScore || direct) {
            log(`[pipeline] ${direct ? "📩" : "⚡"} ${provisional.score}% "${provisional.title}" @ ${provisional.company} — surfacing now`);
            await opts.onScored!(provisional);
          }
        }
      : undefined;
    nEnriched = await enrichLinkedInJobs(toEnrich, { onEnriched, priority: opts.priority });
    log(`[pipeline] enriched ${nEnriched}/${toEnrich.length}`);
  }

  // 4. Keyword score
  const keywords = loadKeywords();
  const scored = scoreAll(candidates, keywords);

  // 4a. Direct-apply scan over the whole batch (src/direct-apply.ts). Runs here,
  //     after scoring and before persistence, so EVERY row that reaches the DB
  //     carries the flag — including ones the streaming hook never saw (JDs
  //     reused from seen_cards, and every job when onScored isn't wired up).
  //     Pure string matching over text already in memory: no network, no cost.
  const directHits = scored.filter((j) => markDirectApply(j));
  if (directHits.length) {
    log(`[pipeline] 📩 ${directHits.length} direct-apply posting(s) — contact details or "immediate joiner" in the JD:`);
    for (const j of directHits.slice(0, 6)) {
      log(`  📩 ${j.score}% "${j.title}" @ ${j.company} — ${j.directApply!.hits.map((h) => h.label).slice(0, 3).join(", ")}`);
    }
  }

  // 4b. Streaming surface for sources that skip enrichment (Naukri: cards
  // already carry the full JD, so step 3's onEnriched hook — the only other
  // place onScored fires — never runs and a hot Naukri job would otherwise
  // never get its instant alert). Every candidate is already scored here, so
  // just walk the ones that clear the bar.
  if (!doEnrich && opts.onScored) {
    for (const job of scored) {
      const direct = shouldAlertDirect(job);
      if (job.score >= CONFIG.notify.hotScore || direct) {
        log(`[pipeline] ${direct ? "📩" : "⚡"} ${job.score}% "${job.title}" @ ${job.company} — surfacing now`);
        await opts.onScored(job);
      }
    }
  }

  // 5. TF-IDF similarity vs resume
  const resumeText = loadResumeText();
  if (resumeText) {
    const jdTexts = scored.map((j) => j.description || j.title);
    const sims = scoreResumeVsJds(resumeText, jdTexts);
    scored.forEach((j, i) => { j.tfidfScore = sims[i]; });
    log(`[pipeline] TF-IDF scores attached`);
  }

  // 6. Dedupe, then RANK — penalties, not drops (src/filter.ts). Everything
  //    that was fetched comes back; weak jobs simply sort to the bottom.
  const deduped = dedupe(scored);
  const { kept: filtered } = rankJobs(deduped);
  const penalised = filtered.filter((j) => (j.penalties?.length ?? 0) > 0);
  log(`[pipeline] ranked ${filtered.length} jobs — ${penalised.length} carry a penalty, ` +
      `${filtered.filter((j) => j.score >= CONFIG.filter.lowRankBelow).length} above the fold ` +
      `(>= ${CONFIG.filter.lowRankBelow})`);
  for (const j of penalised.slice(-4)) log(`  low: "${j.title}" ${j.baseScore}→${j.score} (${j.penalties!.map((x) => x.label).join(", ")})`);

  // 7. Remember the verdicts — but ONLY for cards we actually read. A card that
  //    fell off the far side of the enrich cap has an empty JD and a score of 0;
  //    caching that as "rejected" would blacklist a job nobody ever looked at.
  if (opts.memory) {
    // Nothing is "dropped" any more, so the cache records what we READ and how
    // it ranked. Cards below the fold are marked `dropped` purely so a later run
    // can skip re-fetching them within the skip window — the row itself is still
    // in the dashboard either way.
    const judged = filtered
      .filter((j) => j.description)
      .map((j) => ({
        job: j,
        decision: (j.score >= CONFIG.filter.lowRankBelow ? "shortlisted" : "dropped") as "shortlisted" | "dropped",
        reason: j.penalties?.map((x) => x.label).join("; ") || undefined,
      }));
    await opts.memory.record(judged.map((e) => ({
      externalId: e.job.externalId,
      title: e.job.title,
      company: e.job.company,
      description: e.job.description,
      decision: e.decision,
      reason: e.reason,
      score: e.job.score,
      configHash: fp,
    })));
    log(`[pipeline] seen-cache: recorded ${judged.length} verdicts`);
  }

  // 8. Salary bands, then presence for whatever AmbitionBox couldn't resolve.
  //    ONLY for jobs above the fold: this costs one HTTP request per unique
  //    company, and now that nothing is filtered out, running it over the whole
  //    ranked list would mean hundreds of lookups per run for rows you will
  //    never scroll to. Low-ranked rows get their bands if a later run lifts them.
  const worthEnriching = filtered.filter((j) => j.score >= CONFIG.filter.lowRankBelow && j.description);
  if (doSalary && worthEnriching.length) {
    const uniq = new Set(worthEnriching.map((j) => j.company.trim()).filter(Boolean)).size;
    log(`[pipeline] salary: looking up AmbitionBox bands for ${uniq} companies (above-fold only)…`);
    const { matched, unresolved } = await enrichWithSalary(worthEnriching);
    log(`[pipeline] salary: attached ${matched}/${worthEnriching.length} jobs`);

    if (doPresence && unresolved.length) {
      log(`[pipeline] presence: no AmbitionBox page for ${unresolved.length} companies — checking footprint…`);
      const t = await enrichWithPresence(worthEnriching, unresolved);
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

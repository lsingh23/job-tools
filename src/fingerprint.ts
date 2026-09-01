import { createHash } from "node:crypto";
import { CONFIG, KEYWORDS } from "../config.js";

/**
 * A short hash of every knob that can change a job's VERDICT.
 *
 * The seen-cards cache exists to stop re-enriching a card a previous run already
 * read and rejected (see CONFIG.collect.skipSeenHours). The flaw: a rejection is
 * only valid under the config that produced it. Lower `minScore`, drop "angular"
 * from `rejectTitles`, add a keyword — and every job those changes would now
 * SAVE stays blacklisted for the rest of the skip window, invisibly. Tuning the
 * filters looked like it had done nothing.
 *
 * So the verdict is stored with this fingerprint, and a cached rejection is only
 * honoured when the fingerprint still matches. Change any scoring/filter knob and
 * the next run re-reads those cards from scratch; change nothing and the cache
 * keeps saving the enrich budget exactly as before.
 *
 * Deliberately NOT included: freshness windows, page counts, locations, salary /
 * presence settings — those change WHICH cards are fetched or what is attached
 * afterwards, never whether a given card passes the filter.
 */
export function verdictFingerprint(): string {
  const material = JSON.stringify({
    filter: CONFIG.filter,
    penalties: CONFIG.penalties,
    massRecruiters: CONFIG.massRecruiters,
    fakePosters: CONFIG.fakePosters,
    scoreWeights: CONFIG.scoreWeights,
    relevance: CONFIG.relevance,
    backendPenalty: CONFIG.backendPenalty,
    stackProfile: CONFIG.stackProfile,
    keywords: KEYWORDS.map((k) => [k.tier, k.label, k.weight, k.aliases]),
  });
  return createHash("sha1").update(material).digest("hex").slice(0, 12);
}

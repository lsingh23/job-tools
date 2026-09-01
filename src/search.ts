/**
 * Quick single-city job search — spawned by the dashboard /api/search endpoint.
 *
 *   tsx src/search.ts --source linkedin --city Bengaluru --hours 15 --pages 3
 *   tsx src/search.ts --source naukri   --city Bengaluru --hours 2  --pages 3
 *   tsx src/search.ts --source linkedin --terms "React, Next.js"   # override the query list
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

import { CONFIG } from "../config.js";
import { fetchLinkedInCards, runPipeline, type LinkedInLocation } from "./pipeline.js";
import { fetchNaukriCards } from "./naukri-cards.js";
import { writeCsv } from "./csv.js";

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

/**
 * Optional user-supplied query override. Comma-separated → one query per term
 * (so booleans/quotes inside a term survive: `"React Native", Next.js`).
 * Empty → the hardcoded per-source term lists are used, as before.
 */
const customTerms = getArg("terms", "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

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

// ── Naukri card fetching (shared with the hot checker — src/naukri-cards.ts) ────
const DEFAULT_NAUKRI_TERMS = [
  "Frontend Engineer",
  "Frontend Developer",
  "React Developer",
  "React",
  "React.js",
  "Next.js",
];

const TERMS = customTerms.length ? customTerms : DEFAULT_NAUKRI_TERMS;

/** Label only, for the log line below — the real decision lives in naukri-cards.ts. */
const naukriSort = hours >= 24 ? "r" : "f";

// ── Pipeline ──────────────────────────────────────────────────────────────────
async function main() {
  const loc = source === "linkedin" ? resolveLocation(city) : null;
  log(
    `[search] source=${source}  city="${city}"  hours=${hours}  pages/kw=${pages}` +
      (customTerms.length ? `  terms=${customTerms.map((t) => `"${t}"`).join(", ")}` : "  terms=default") +
      (source === "linkedin"
        ? `  geoId=${loc?.geoId ?? "text"}${maxApplicants !== null ? `  maxApplicants=${maxApplicants}` : ""}`
        : `  sort=${naukriSort}  exp=${CONFIG.experience.naukriYears === null ? "any" : `${CONFIG.experience.naukriYears}y`}` +
          `  jobAge=${Math.max(1, Math.ceil(hours / 24))}d→${hours}h client-side`),
  );

  // 1. Fetch cards
  const cards = source === "naukri"
    ? await fetchNaukriCards(city, { hours, pages, terms: TERMS, log })
    : await fetchLinkedInCards(loc!, {
        hours, pages, maxApplicants,
        sortBy: CONFIG.linkedinParams.sortBy,
        ...(customTerms.length ? { terms: customTerms } : {}),
        log,
      });
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

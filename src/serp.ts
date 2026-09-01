import { politeFetch } from "./http.js";

/**
 * SERP providers, behind one interface so the first run and the weekly cron can
 * use different ones without touching the harvester.
 *
 * WHY a paid-ish API at all, when we already dork by hand: Google serves `site:`
 * queries only ~300-400 deep no matter what result count it claims, and refuses
 * datacenter IPs outright. The long tail — the unglamorous companies nobody else
 * is applying to — lives at result 60-200, which is exactly the part a browser
 * session won't hand you reliably.
 *
 * Free-tier reality, checked 2026-08-11:
 *   brave   $5/mo credit that REFILLS → ~1,000 req/mo, 20/page, card on file
 *           (never charged). The weekly loop costs ~640 req → free forever.
 *   serper  2,500 queries ONE TIME, no card, and `num=100` returns 100 results
 *           in a single call (costs 2 credits) → ~10 full deep runs. Best for
 *           the first harvest.
 *   serpapi 250/mo, 50/hour → too tight for a 128-query matrix. Skipped.
 *   Google CSE — CLOSED TO NEW SIGNUPS, dies 2027-01-01. Do not build on it.
 */
export interface SerpResult {
  url: string;
  title: string;
}

export interface SerpProvider {
  name: string;
  /** Results per request — the harvester uses this to size its page loop. */
  pageSize: number;
  /** Hard cap on pages this provider will serve for one query. */
  maxPages: number;
  search(query: string, page: number): Promise<SerpResult[]>;
}

class BraveProvider implements SerpProvider {
  name = "brave";
  pageSize = 20; // Brave's `count` maximum
  maxPages = 10; // `offset` is capped at 9 → 200 results/query
  constructor(private key: string) {}

  async search(query: string, page: number): Promise<SerpResult[]> {
    const url =
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}` +
      `&count=${this.pageSize}&offset=${page}`;
    const body = await politeFetch(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": this.key },
      // Cache per (query, page): re-running the matrix while tuning must not
      // re-spend the monthly credit on identical requests.
      cacheKey: `brave:${query}:${page}`,
      ttlMinutes: 60 * 24,
      label: `brave p${page} ${query.slice(0, 48)}`,
    });
    const json = JSON.parse(body) as {
      web?: { results?: { url: string; title?: string }[] };
    };
    return (json.web?.results ?? []).map((r) => ({ url: r.url, title: r.title ?? "" }));
  }
}

class SerperProvider implements SerpProvider {
  name = "serper";
  pageSize = 100; // costs 2 credits instead of 1, and buys the whole tail in one call
  maxPages = 3;
  constructor(private key: string) {}

  async search(query: string, page: number): Promise<SerpResult[]> {
    const body = await politeFetch("https://google.serper.dev/search", {
      headers: { "X-API-KEY": this.key, "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify({ q: query, num: this.pageSize, page: page + 1 }),
      cacheKey: `serper:${query}:${page}`,
      ttlMinutes: 60 * 24,
      label: `serper p${page} ${query.slice(0, 48)}`,
    });
    const json = JSON.parse(body) as { organic?: { link: string; title?: string }[] };
    return (json.organic ?? []).map((r) => ({ url: r.link, title: r.title ?? "" }));
  }
}

/**
 * Pick a provider from the environment. Explicit `prefer` wins if its key exists;
 * otherwise whichever key is present. Throws with an actionable message rather
 * than silently harvesting nothing.
 */
export function getSerpProvider(prefer?: "brave" | "serper"): SerpProvider {
  const brave = process.env.BRAVE_SEARCH_API_KEY?.trim();
  const serper = process.env.SERPER_API_KEY?.trim();

  if (prefer === "serper" && serper) return new SerperProvider(serper);
  if (prefer === "brave" && brave) return new BraveProvider(brave);
  if (serper) return new SerperProvider(serper);
  if (brave) return new BraveProvider(brave);

  throw new Error(
    "No SERP key. Set BRAVE_SEARCH_API_KEY (free $5/mo, refills) or " +
      "SERPER_API_KEY (2,500 free, no card) in .env — see src/serp.ts for the tradeoff.",
  );
}

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG } from "../config.js";
import { getSerpProvider, type SerpResult } from "./serp.js";

/**
 * THE SLOW LOOP — "which companies exist?". Run weekly, NOT hourly.
 *
 * Harvests company SLUGS out of ATS URLs in search results and appends them to
 * data/companies.json. It deliberately throws every posting away: measured
 * 2026-08-11, 14 of 15 postings the dorks returned were already closed, and both
 * Greenhouse and Ashby hide that fact behind an HTTP 200 (Greenhouse 301s a dead
 * job to the company board with `?error=true`; Ashby serves an empty
 * `<title>Jobs</title>` SPA shell). Google's index is months stale for JOBS and
 * perfectly good for COMPANIES — a company indexed last year still has a board
 * today. src/sources/ats.ts then polls those boards, where every row is live by
 * construction because a closed job is simply absent.
 *
 *   npm run discover           # full matrix, appends to the registry
 *   npm run discover -- --dry  # print what it would add, write nothing
 */

export type Ats = "greenhouse" | "lever" | "ashby" | "workday";

export interface Company {
  ats: Ats;
  slug: string;
  /** Greenhouse only: the EU board is a separate host AND a separate API host. */
  region?: "us" | "eu";
  /** Workday only — the tenant's datacenter shard and career-site name. */
  wd?: string;
  site?: string;
  firstSeen: string;
  lastSeen: string;
  /** The dork that found it — kept for tuning which queries actually pay. */
  via?: string;
  /**
   * When the poller last called this board's API. Drives the rotating slice
   * (CONFIG.ats.poll.refreshMinutes) — absent means "never polled", which sorts
   * first so newly discovered companies are checked immediately.
   */
  lastPolledAt?: string;
  /** Consecutive failures. Boards that 404 forever get polled less often. */
  failures?: number;
}

export interface Registry {
  updatedAt: string;
  companies: Company[];
}

/** Path segments that are never a company slug. */
const RESERVED = new Set(["embed", "js", "api", "www", "jobs", "job", "search", "en-us"]);

/**
 * Pull a company identity out of one ATS URL.
 *
 * Every pattern here was read off real search results, not docs — including the
 * bare-board form (`job-boards.greenhouse.io/meltplan`, no /jobs/ segment) and
 * Workday's optional locale segment (`/en-US/External_Career/job/…` vs
 * `/alteryxcareers/job/…`, which has no locale at all).
 */
export function parseAtsUrl(raw: string): Omit<Company, "firstSeen" | "lastSeen"> | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  // Percent-DECODE the path: Ashby allows spaces in board slugs, so the URL
  // carries "Fermi%20AI" while the API wants the literal "Fermi AI". Left
  // encoded, those boards 404 forever and look like dead companies.
  const seg = u.pathname
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const first = seg[0];
  if (!first || RESERVED.has(first.toLowerCase())) return null;

  if (host.endsWith("greenhouse.io")) {
    // `boards.greenhouse.io` is the LEGACY host (301s to job-boards.*), but its
    // slugs are still valid — Google's index is full of them, which is free
    // coverage we would otherwise throw away.
    return { ats: "greenhouse", slug: first, region: host.includes(".eu.") ? "eu" : "us" };
  }
  if (host.endsWith("lever.co")) {
    return { ats: "lever", slug: first };
  }
  if (host.endsWith("ashbyhq.com")) {
    // Ashby slugs are case-sensitive in the API path (`GigaML` ≠ `gigaml`).
    return { ats: "ashby", slug: first };
  }
  if (host.endsWith("myworkdayjobs.com")) {
    const m = host.match(/^([a-z0-9-]+)\.(wd\d+)\./);
    if (!m) return null;
    // Skip the locale segment when present; the next one is the career site.
    const site = /^[a-z]{2}-[A-Z]{2}$/.test(first) ? seg[1] : first;
    if (!site || RESERVED.has(site.toLowerCase())) return null;
    return { ats: "workday", slug: m[1]!, wd: m[2]!, site };
  }
  return null;
}

/** Identity used for dedupe — Workday needs the site, one tenant can run several. */
function key(c: { ats: string; slug: string; site?: string; region?: string }): string {
  return `${c.ats}:${c.region ?? ""}:${c.slug.toLowerCase()}:${c.site ?? ""}`;
}

export function loadRegistry(path = CONFIG.ats.discovery.registry): Registry {
  if (!existsSync(path)) return { updatedAt: new Date().toISOString(), companies: [] };
  return JSON.parse(readFileSync(path, "utf8")) as Registry;
}

export function saveRegistry(reg: Registry, path = CONFIG.ats.discovery.registry): void {
  mkdirSync(dirname(path), { recursive: true });
  reg.companies.sort((a, b) => key(a).localeCompare(key(b)));
  writeFileSync(path, JSON.stringify(reg, null, 2) + "\n", "utf8");
}

/**
 * Shuffle so a run that hits its request budget doesn't always starve the same
 * tail of the matrix. Over a few weekly runs every query gets its turn.
 */
function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Build the dork matrix: title × host × geo. */
export function buildQueries(): string[] {
  const { titles, geos, hosts } = CONFIG.ats.discovery;
  const out: string[] = [];
  for (const host of hosts) {
    for (const title of titles) {
      for (const geo of geos) {
        // The quoted title is the only hard constraint; geo stays unquoted so it
        // acts as a ranking hint rather than a filter. An empty geo is on purpose
        // (see config: unqualified queries surface companies whose India roles
        // Google never tagged "India").
        out.push(`site:${host} "${title}"${geo ? ` ${geo}` : ""}`);
      }
    }
  }
  return out;
}

export async function discover(opts: { dry?: boolean } = {}): Promise<Registry> {
  const provider = getSerpProvider(CONFIG.ats.discovery.provider);
  const reg = loadRegistry();
  const index = new Map(reg.companies.map((c) => [key(c), c]));
  const before = index.size;

  const queries = shuffle(buildQueries());
  const pages = Math.min(CONFIG.ats.discovery.pagesPerQuery, provider.maxPages);
  const budget = CONFIG.ats.discovery.maxRequests;
  console.log(
    `\n▶ discover: ${queries.length} queries × ${pages} pages via ${provider.name} ` +
      `(${provider.pageSize}/page, budget ${budget} req) — registry has ${before} companies`,
  );

  const now = new Date().toISOString();
  let requests = 0;
  let urls = 0;

  for (const [qi, q] of queries.entries()) {
    if (requests >= budget) {
      console.log(`  … budget of ${budget} requests spent; ${queries.length - qi} queries deferred to the next run`);
      break;
    }
    let newHere = 0;
    for (let page = 0; page < pages; page++) {
      let results: SerpResult[];
      try {
        results = await provider.search(q, page);
        requests++;
      } catch (err) {
        // One dead query must not kill a 128-query run.
        console.error(`  ✗ ${q} p${page}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      if (!results.length) break; // no more pages for this query

      for (const r of results) {
        urls++;
        const parsed = parseAtsUrl(r.url);
        if (!parsed) continue;
        const k = key(parsed);
        const hit = index.get(k);
        if (hit) {
          hit.lastSeen = now;
        } else {
          index.set(k, { ...parsed, firstSeen: now, lastSeen: now, via: q });
          newHere++;
        }
      }
    }
    const tag = newHere ? `+${newHere}` : "  ·";
    console.log(`  ${tag}  [${qi + 1}/${queries.length}] ${q}`);
  }

  reg.companies = [...index.values()];
  reg.updatedAt = now;

  const added = index.size - before;
  console.log(
    `\n  ${requests} requests → ${urls} urls → ${added} NEW companies ` +
      `(registry: ${before} → ${index.size})`,
  );
  const byAts = reg.companies.reduce<Record<string, number>>((a, c) => {
    a[c.ats] = (a[c.ats] ?? 0) + 1;
    return a;
  }, {});
  console.log(`  ${Object.entries(byAts).map(([k2, v]) => `${k2}=${v}`).join("  ")}`);

  if (opts.dry) {
    console.log("  [dry] registry NOT written");
  } else {
    saveRegistry(reg);
    console.log(`  → ${CONFIG.ats.discovery.registry}`);
  }
  return reg;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  discover({ dry: process.argv.includes("--dry") }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

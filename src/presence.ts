import { promises as dns } from "node:dns";
import { politeFetch, HttpError } from "./http.js";
import { CONFIG } from "../config.js";
import type { ScoredJob, PresenceSignals } from "./types.js";

/**
 * Online-presence evidence for companies AmbitionBox has never heard of.
 *
 * AmbitionBox needs a critical mass of employee submissions, so a genuine
 * 15-person startup founded last year is simply invisible to it. Absence there
 * says nothing about whether the company is real — so this module answers a
 * different question: does a real operating entity exist behind the name?
 *
 * It deliberately does NOT score age or headcount. A 2025 startup with a product
 * has an `app.` and an `api.` on day one; that's the signal, and it's orthogonal
 * to size. What we look at, hardest-to-fake first:
 *
 *   1. Certificate Transparency (crt.sh) — every TLS cert ever issued is public.
 *      Infra-shaped subdomains (app/api/backend/staging/dev) mean a real
 *      engineering org: you cannot fake `backend.app.staging.x.com` without
 *      actually running it.
 *   2. Earliest cert — when they genuinely went live. Better than domain
 *      registration, which can be a years-old squat on a name they just bought.
 *   3. MX on Workspace/M365 — they pay for corporate email. Necessary, not
 *      sufficient: a motivated scammer buys a seat for $6/mo.
 *   4. Site live under a domain we could tie back to the company name.
 *
 * This produces EVIDENCE FOR A HUMAN, not a fraud verdict. Nothing is ever
 * dropped on its say-so, and "unverified" means we couldn't find the company's
 * domain — never that the company is fake.
 *
 * KNOWN LIMIT — same-name collisions. Domains are guessed from the company name
 * and confirmed by finding that name in the homepage <title>. That rejects an
 * unrelated site, but CANNOT tell two companies with the SAME name apart: "Level
 * AI" (voice AI, thelevel.ai) resolves to levelai.ai, a real edtech that is also
 * called Level.AI. The verdict is then correct evidence about the wrong company.
 * This is why `domain` is surfaced in the CSV — check it when a verdict matters —
 * and why CONFIG.presence.aliases exists to pin the right one.
 */

/** Legal-entity suffixes that never appear in a domain. */
const LEGAL_SUFFIX = /\b(pvt|private|ltd|limited|inc|llc|corp|corporation|gmbh|plc|co|technologies|technology|labs|solutions|systems|services|software|global|india)\b/g;

/**
 * Name tails that are themselves TLDs. "Recrew AI" is `recrew.ai`, not
 * `recrewai.com` — and the .ai startup naming convention makes this the single
 * highest-yield candidate for the companies that land here.
 */
const TLD_WORDS = new Set(["ai", "io", "app", "dev", "tech", "cloud", "xyz"]);

/**
 * Subdomains that only exist because someone is running software. A marketing
 * shell has an apex and a www; a company with a product has these.
 */
const INFRA_HOST = /^(app|api|backend|staging|dev|admin|dashboard|portal|console|auth|cdn|git|internal|qa|test|beta)\b/;

/** Providers you have to pay for. Anything here means real corporate email. */
function classifyMx(exchanges: string[]): string | null {
  const joined = exchanges.join(" ").toLowerCase();
  if (!joined.trim() || joined === ".") return null;
  if (/google|googlemail/.test(joined)) return "Google Workspace";
  if (/outlook|microsoft|office365/.test(joined)) return "Microsoft 365";
  if (/zoho/.test(joined)) return "Zoho Mail";
  if (/proofpoint|mimecast|barracuda/.test(joined)) return "enterprise gateway";
  return exchanges[0] ?? null;
}

/**
 * Domain guesses for a company name, best first. `Recrew AI` yields `recrew.ai`
 * ahead of `recrewai.com`, because the trailing token is usually the TLD.
 */
export function domainCandidates(company: string): string[] {
  const override = CONFIG.presence.aliases[company.trim()];
  if (override) return [override];

  const toks = company
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(LEGAL_SUFFIX, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!toks.length) return [];

  const out: string[] = [];
  const last = toks[toks.length - 1]!;
  const head = toks.slice(0, -1).join("");
  const all = toks.join("");

  if (TLD_WORDS.has(last) && head) out.push(`${head}.${last}`);
  for (const tld of CONFIG.presence.tlds) out.push(`${all}.${tld}`);
  if (head) for (const tld of CONFIG.presence.tlds) out.push(`${head}.${tld}`);

  return [...new Set(out)].slice(0, CONFIG.presence.maxCandidates);
}

/** The token we require on the homepage to accept a domain as this company's. */
function nameToken(company: string): string {
  const toks = company
    .toLowerCase()
    .replace(LEGAL_SUFFIX, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 2 && !TLD_WORDS.has(t));
  return toks[0] ?? "";
}

async function resolves(domain: string): Promise<boolean> {
  try {
    const a = await dns.resolve4(domain);
    return a.length > 0;
  } catch {
    try {
      return (await dns.resolve6(domain)).length > 0;
    } catch {
      return false;
    }
  }
}

async function mxOf(domain: string): Promise<string | null> {
  try {
    const recs = await dns.resolveMx(domain);
    return classifyMx(recs.map((r) => r.exchange).filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * Fetch a candidate's homepage and decide whether it's actually this company's.
 *
 * This gate is the whole reason we can guess domains at all. "Level AI" guesses
 * `level.ai` — which belongs to an unrelated company whose homepage says "Super
 * AI Agents Built for Work". Without this we'd attach that company's evidence to
 * Level AI's jobs, which is worse than reporting nothing.
 *
 * We require the name in <title> specifically, NOT anywhere in the page. Body
 * text matches almost anything for a common head token ("level" appears
 * somewhere on nearly every site); titles are where companies put their name.
 * Verified against the real pages: level.ai's title correctly fails, while
 * "Recrew | Build Your AI-Native Team" and "Wissen | Driving Digital
 * Transformation" both pass. The cost is false negatives for companies whose
 * title is a bare tagline — they come back `unverified`, and the fix is a
 * CONFIG.presence.aliases entry. Under-claiming is the right failure here.
 */
async function verifyHomepage(domain: string, token: string): Promise<"title" | null> {
  if (!token) return null;
  let html: string;
  try {
    html = await politeFetch(`https://${domain}/`, {
      cacheKey: `presence:home:${domain}`,
      ttlMinutes: CONFIG.presence.cacheTtlMinutes,
      label: `presence home ${domain}`,
      maxRetries: 1, // a dead guess shouldn't cost the full backoff ladder
    });
  } catch {
    return null;
  }
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return norm(title).includes(norm(token)) ? "title" : null;
}

interface CertFacts {
  names: string[];
  /** Only crt.sh can supply this — see certSpotter's truncation note. */
  firstCert: string | null;
}

/**
 * Certificate Transparency via Certspotter. Free and keyless, and reliable when
 * crt.sh is throwing 502s (which it does for minutes at a time).
 *
 * IMPORTANT: the keyless tier returns only the most RECENT issuances, so its
 * earliest `not_before` is not the earliest cert. We take hostnames from here
 * and deliberately return no date — a truncated "first live" would read as a
 * young company, which is exactly the wrong conclusion to hand someone.
 */
async function certSpotter(domain: string): Promise<CertFacts | null> {
  try {
    const body = await politeFetch(
      `https://api.certspotter.com/v1/issuances?domain=${domain}&include_subdomains=true&expand=dns_names`,
      {
        cacheKey: `presence:cs:${domain}`,
        ttlMinutes: CONFIG.presence.cacheTtlMinutes,
        label: `presence certspotter ${domain}`,
      },
    );
    const rows = JSON.parse(body);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return { names: [...new Set(rows.flatMap((r: any) => r.dns_names ?? []))] as string[], firstCert: null };
  } catch {
    return null;
  }
}

/**
 * Certificate Transparency via crt.sh. Richer than Certspotter (full history, so
 * it alone can date "first live", and it sees subdomains Certspotter's truncated
 * tier misses) but genuinely unreliable. Short retry budget: it has a fallback,
 * so burning the full ladder just delays the source that would have worked.
 */
async function crtSh(domain: string): Promise<CertFacts | null> {
  try {
    const body = await politeFetch(`https://crt.sh/?q=%25.${domain}&output=json`, {
      cacheKey: `presence:crt:${domain}`,
      ttlMinutes: CONFIG.presence.cacheTtlMinutes,
      label: `presence crt.sh ${domain}`,
      maxRetries: 1,
    });
    const rows = JSON.parse(body);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const dates = rows.map((r: any) => r.not_before).filter(Boolean).sort();
    return {
      names: [...new Set(rows.flatMap((r: any) => String(r.name_value ?? "").split("\n")))].filter(Boolean) as string[],
      firstCert: dates[0]?.slice(0, 10) ?? null,
    };
  } catch {
    return null; // 502, or an HTML error page where JSON was promised
  }
}

interface CertFootprint {
  hostnames: number;
  infraHosts: string[];
  wildcardOnly: boolean;
  firstCert: string | null;
}

/**
 * Merged CT footprint from both logs. Null means we genuinely could not look —
 * which `judge` treats as UNKNOWN, never as "no footprint". Conflating the two
 * would turn a crt.sh outage into evidence against every company in the run.
 */
async function certFootprint(domain: string): Promise<CertFootprint | null> {
  const [cs, crt] = await Promise.all([certSpotter(domain), crtSh(domain)]);
  if (!cs && !crt) return null;

  const names = [...new Set([...(cs?.names ?? []), ...(crt?.names ?? [])])];
  const concrete = names.filter((n) => !n.startsWith("*"));
  const subs = concrete
    .filter((n) => n.endsWith(`.${domain}`))
    .map((n) => n.slice(0, -(domain.length + 1)));

  return {
    hostnames: concrete.length,
    // Infra-shaped if ANY label is — catches backend.app.staging.new.recrew.ai.
    infraHosts: subs.filter((s) => s.split(".").some((label) => INFRA_HOST.test(label))),
    // Only wildcards → we genuinely cannot see their subdomains. Unknown, not absent.
    wildcardOnly: concrete.length <= 1 && names.some((n) => n.startsWith("*")),
    firstCert: crt?.firstCert ?? null,
  };
}

/** Domain registration date via RDAP — free, keyless, and covers .ai (whois does not). */
async function registeredOn(domain: string): Promise<string | null> {
  let body: string;
  try {
    body = await politeFetch(`https://rdap.org/domain/${domain}`, {
      cacheKey: `presence:rdap:${domain}`,
      ttlMinutes: CONFIG.presence.cacheTtlMinutes,
      label: `presence rdap ${domain}`,
    });
  } catch (err) {
    if (err instanceof HttpError) return null; // 404 = registry has no such domain
    return null;
  }
  try {
    const events: Array<{ eventAction?: string; eventDate?: string }> = JSON.parse(body).events ?? [];
    const reg = events.find((e) => e.eventAction === "registration")?.eventDate;
    return reg ? reg.slice(0, 10) : null;
  } catch {
    return null;
  }
}

const daysSince = (iso: string | null): number | null =>
  iso ? Math.floor((Date.now() - Date.parse(iso)) / 86400000) : null;

/**
 * Weigh the evidence. Tuned so a genuine brand-new startup clears `operating` on
 * footprint alone: live+verified site (30) + two infra subdomains (25) + paid
 * email (20) = 75, with zero credit for age. Age only ever ADDS, so being
 * founded in 2025 can't drag a real company down — which was the whole point.
 */
function judge(p: PresenceSignals): void {
  const reasons: string[] = [];
  let score = 0;

  if (p.siteLive) {
    score += 30;
    reasons.push(`site live at ${p.domain} (name in page title)`);
  }

  if (p.infraHosts.length >= 2) {
    score += 25;
    reasons.push(`${p.infraHosts.length} infra subdomains (${p.infraHosts.slice(0, 3).join(", ")})`);
  } else if (p.infraHosts.length === 1) {
    score += 15;
    reasons.push(`1 infra subdomain (${p.infraHosts[0]})`);
  } else if (p.certsUnknown) {
    reasons.push("CT logs unreachable — footprint unknown, not absent");
  } else if (p.wildcardOnly) {
    reasons.push("wildcard cert hides subdomains — footprint unknown, not absent");
  } else if (p.hostnames > 0) {
    reasons.push(`${p.hostnames} hostname(s), none infra-shaped`);
  }

  if (p.mxProvider) {
    score += 20;
    reasons.push(`paid email (${p.mxProvider})`);
  } else {
    reasons.push("no MX — domain receives no mail");
  }

  const certDays = daysSince(p.firstCert);
  if (certDays !== null && certDays >= 365) {
    score += 15;
    reasons.push(`certs since ${p.firstCert}`);
  } else if (certDays !== null && certDays >= 180) {
    score += 8;
    reasons.push(`certs since ${p.firstCert}`);
  }

  const regDays = daysSince(p.domainRegistered);
  if (regDays !== null && regDays >= 365) score += 10;
  if (p.domainRegistered) reasons.push(`domain registered ${p.domainRegistered}`);

  p.score = score;
  p.reasons = reasons;

  if (!p.domain) {
    p.verdict = "unverified";
    return;
  }
  // With no CT data the only evidence left is "a site exists and gets mail",
  // which a one-afternoon shell also satisfies. Cap at `thin` rather than let a
  // crt.sh outage silently promote every company in the run to `operating`.
  const ceiling = p.certsUnknown ? "thin" : "operating";
  const verdict = score >= 60 ? "operating" : score >= 30 ? "thin" : "unverified";
  p.verdict = verdict === "operating" && ceiling === "thin" ? "thin" : verdict;
}

/** Gather every signal for one company. Never throws. */
async function probe(company: string): Promise<PresenceSignals> {
  const p: PresenceSignals = {
    company,
    domain: null,
    verdict: "unverified",
    reasons: [],
    siteLive: false,
    nameMatch: null,
    mxProvider: null,
    hostnames: 0,
    infraHosts: [],
    wildcardOnly: false,
    certsUnknown: true,
    firstCert: null,
    domainRegistered: null,
    score: 0,
  };

  const token = nameToken(company);
  for (const cand of domainCandidates(company)) {
    // DNS first: it's free and instant, and skips the polite delay on the ~80%
    // of guesses that don't exist at all.
    if (!(await resolves(cand))) continue;
    const match = await verifyHomepage(cand, token);
    if (!match) continue; // resolves, but it's not this company's site
    p.domain = cand;
    p.siteLive = true;
    p.nameMatch = match;
    break;
  }

  if (!p.domain) {
    p.reasons = [`no domain found for "${company}" (tried ${domainCandidates(company).length} guesses)`];
    return p;
  }

  const [mx, certs, reg] = await Promise.all([
    mxOf(p.domain),
    certFootprint(p.domain),
    registeredOn(p.domain),
  ]);

  p.mxProvider = mx;
  p.domainRegistered = reg;
  p.certsUnknown = !certs;
  if (certs) {
    p.hostnames = certs.hostnames;
    p.infraHosts = certs.infraHosts;
    p.wildcardOnly = certs.wildcardOnly;
    p.firstCert = certs.firstCert;
  }

  judge(p);
  return p;
}

/**
 * Attaches `presence` to jobs in place, for the given companies only.
 *
 * Callers pass the AmbitionBox `unresolved` list: this runs ONLY where salary
 * enrichment found nothing, because for companies AmbitionBox does cover, its
 * founded-year / headcount / isClosed fields already answer this better.
 * One probe per company, cached 30 days — CT history and registration dates
 * barely move.
 */
export async function enrichWithPresence(
  jobs: ScoredJob[],
  companies: string[],
): Promise<{ probed: number; operating: number; thin: number; unverified: number }> {
  const byCompany = new Map<string, ScoredJob[]>();
  for (const j of jobs) {
    const key = j.company.trim();
    if (!key) continue;
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key)!.push(j);
  }

  // Most jobs first — if we hit the cap, spend it where it covers the most rows.
  const targets = companies
    .filter((c) => byCompany.has(c))
    .sort((a, b) => byCompany.get(b)!.length - byCompany.get(a)!.length)
    .slice(0, CONFIG.presence.maxCompanies);

  const tally = { probed: 0, operating: 0, thin: 0, unverified: 0 };

  for (const company of targets) {
    let p: PresenceSignals;
    try {
      p = await probe(company);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  [presence] ${company}: probe failed — ${msg}\n`);
      continue;
    }
    tally.probed++;
    tally[p.verdict]++;
    for (const j of byCompany.get(company)!) j.presence = p;
  }

  return tally;
}

/** One-line console rendering: "operating (85): site live at recrew.ai; 6 infra subdomains…". */
export function formatPresence(p: PresenceSignals | undefined): string {
  if (!p) return "";
  return `${p.verdict} (${p.score}): ${p.reasons.join("; ")}`;
}

/**
 * Single source of truth for the job hunter.
 * Everything brittle (endpoints, params, headers, selectors, geoIds, delays)
 * lives here so that when a source breaks you fix ONE file.
 */

/** Scoring tier. Drives the normalized match %: see CONFIG.scoreWeights. */
export type KeywordTier = "core" | "strong" | "bonus" | "ignore";

export interface KeywordSpec {
  /** Canonical label shown in CSV output. */
  label: string;
  /** All spellings that count as a match (case-insensitive, word-boundary). */
  aliases: string[];
  /** Relative importance WITHIN its tier. core > strong > bonus. */
  weight: number;
  /**
   * Which tier this skill belongs to. The match % is computed as a weighted
   * blend of per-tier coverage (CONFIG.scoreWeights), NOT a flat sum — so a job
   * that hits all your CORE skills already scores high even if it omits the
   * long tail of bonus skills. `ignore` = present on résumé but never scores.
   */
  tier: KeywordTier;
}

/**
 * 2026 market-validated, frontend-focused keyword set (tiered).
 * Weights are RELATIVE WITHIN A TIER; the tier itself decides how much it can
 * move the score. Niche backend tokens (Java/Scala/Python) are `ignore` so they
 * never inflate a frontend score.
 */
export const KEYWORDS: KeywordSpec[] = [
  // ── core: the must-haves. Full core coverage alone = scoreWeights.core. ──
  { label: "React", aliases: ["react", "react.js", "reactjs"], weight: 5, tier: "core" },
  { label: "Next.js", aliases: ["next.js", "nextjs", "next js"], weight: 5, tier: "core" },
  { label: "TypeScript", aliases: ["typescript", "ts"], weight: 5, tier: "core" },
  { label: "JavaScript", aliases: ["javascript", "js", "es6", "ecmascript"], weight: 4, tier: "core" },

  // ── strong: the 2026 differentiators hiring managers screen for ──
  { label: "App Router", aliases: ["app router", "app-router"], weight: 3, tier: "strong" },
  { label: "RSC / Server Components", aliases: ["rsc", "server components", "react server components"], weight: 2, tier: "strong" },
  { label: "Accessibility (a11y)", aliases: ["accessibility", "a11y", "wcag", "aria", "semantic html"], weight: 3, tier: "strong" },
  { label: "Core Web Vitals / Performance", aliases: ["core web vitals", "web vitals", "lighthouse", "performance optimization", "performance"], weight: 3, tier: "strong" },
  { label: "Testing", aliases: ["jest", "cypress", "playwright", "react testing library", "rtl", "unit testing", "vitest", "testing"], weight: 3, tier: "strong" },
  { label: "TailwindCSS", aliases: ["tailwind", "tailwindcss", "sass", "scss"], weight: 2, tier: "strong" },
  { label: "Node.js", aliases: ["node.js", "nodejs", "node"], weight: 3, tier: "strong" },
  { label: "REST APIs", aliases: ["rest", "rest api", "restful", "oauth", "jwt", "web api"], weight: 2, tier: "strong" },
  { label: "CI/CD", aliases: ["ci/cd", "cicd", "github actions", "jenkins", "docker", "webpack", "vite"], weight: 2, tier: "strong" },
  { label: "Responsive Design", aliases: ["responsive design", "responsive", "mobile-first"], weight: 2, tier: "strong" },

  // ── bonus: valued, lower weight (some not on résumé yet) ──
  { label: "State (Redux/Zustand/Query)", aliases: ["redux", "zustand", "context api", "tanstack", "react query", "react-query"], weight: 2, tier: "bonus" },
  { label: "GraphQL", aliases: ["graphql", "apollo"], weight: 1, tier: "bonus" },
  { label: "PostgreSQL", aliases: ["postgresql", "postgres", "sql"], weight: 1, tier: "bonus" },
  { label: "System Design", aliases: ["system design", "microservices", "agile"], weight: 1, tier: "bonus" },
  { label: "AI Engineering", aliases: ["rag", "llm", "multi-agent", "prompt engineering", "vercel ai sdk", "ai integration", "genai"], weight: 2, tier: "bonus" },
  { label: "WebSockets / Realtime", aliases: ["websocket", "websockets", "realtime", "webrtc"], weight: 1, tier: "bonus" },

  // ── present on résumé but intentionally non-scoring for FE roles ──
  { label: "Java", aliases: ["java"], weight: 0, tier: "ignore" },
  { label: "Scala", aliases: ["scala"], weight: 0, tier: "ignore" },
  { label: "Python", aliases: ["python"], weight: 0, tier: "ignore" },
];

export interface SourceToggle {
  enabled: boolean;
  /** Max listing pages to request per run. Keep LOW to stay polite. */
  maxPages: number;
}

export const CONFIG = {
  /** Target roles. Used to build per-source search queries. */
  titles: [
    "Frontend Engineer",
    "Frontend Developer",
    "React Developer",
    "React.js Developer",
    "Next.js Developer",
    "UI Engineer",
    "UI Developer",
    "Software Engineer Frontend",
    "Full Stack Developer React",
  ],

  /** Locations to search. Free-text label + platform-specific ids. */
  locations: {
    // LinkedIn needs a numeric geoId; India = 102713980, Worldwide = 92000000.
    linkedin: [
      { label: "India", geoId: "102713980", remote: false },
      { label: "Remote (India)", geoId: "102713980", remote: true },
    ],
    // "India" is a national search that already surfaces the metros, but with
    // sort=freshness + few pages it cuts off; adding metros as their own queries
    // pulls city-specific fresh roles the national pagination misses. Naukri
    // requests are cheap (full JD inline, no per-job enrich), so casting wide
    // here is the best coverage-per-request. dedupe collapses the overlap.
    naukri: ["India", "Remote", "Bengaluru", "Pune", "Hyderabad", "Gurgaon"],
    // Free APIs are remote-global; we filter India/remote client-side.
    keywordsForApis: ["frontend", "react", "next.js", "typescript"],
  },

  /**
   * Experience. `years` drives SOURCE-SIDE filtering so over-target jobs never
   * come back (no client-side dropping):
   *  - Naukri: `experience=<years>` query param → only bands that bracket it.
   *  - LinkedIn: `f_E` levels (guest filter) — 1=Intern 2=Entry 3=Associate
   *    4=Mid-Senior 5=Director 6=Exec. For ~4y IC, Associate+Mid-Senior fits.
   * favorMin/favorMax/stretchFrom still drive the "stretch" seniority label.
   */
  experience: {
    years: 4,
    linkedinLevels: ["2", "3", "4"],
    favorMin: 3,
    favorMax: 5,
    stretchFrom: 6,
  },

  /**
   * Title relevance: a job's keyword score is scaled by how much its TITLE
   * resembles YOUR target roles (`titles` + `linkedinSearchTerms` below) using
   * token-set (Jaccard) similarity — no hand-maintained blocklist. Off-target
   * titles ("Solution Architect", "Pre-Sales Lead Generation", ".NET Developer")
   * share few/no role tokens with your targets and get down-ranked; nothing is
   * dropped. `titleFitFloor` caps how far a weak title match can pull a score
   * down (0 = title can zero a score; 1 = title relevance is ignored). Widen
   * your `titles`/`linkedinSearchTerms` to recognise more on-target wordings.
   */
  relevance: { titleFitFloor: 0.18 },

  /**
   * How the match % is split across tiers (must sum to 1). Full coverage of a
   * tier earns its whole share. With core=0.6, a job mentioning React+Next+TS+JS
   * already scores 60% before any strong/bonus skills — so genuine frontend
   * roles land at 80-95% instead of compressing near 60%.
   */
  scoreWeights: { core: 0.6, strong: 0.3, bonus: 0.1 },

  /**
   * Post-scoring FILTER → produces a shortlist (drops, never just reorders).
   * Tune these freely; this is the main "make results genuinely better" knob.
   */
  filter: {
    enabled: true,
    /**
     * Drop anything scoring below this (after the tiered renormalization).
     * Sensitivity on the 2026-06-26 set: 50→5 jobs, 45→7, 40→12, 35→21, 30→29.
     * 40 keeps strong React-only roles (Bentley, Razorpay, AirBills) while still
     * cutting the long tail. Raise for a tighter list, lower to see more.
     */
    minScore: 40,
    /**
     * Drop if the role's REQUIRED MINIMUM experience is at least this many
     * years. You target 3-4y, so 5 means "needs ≥5y to even apply" → out.
     * Bands that bracket you ("3-8", "2-7", "4-9") have a min < 5 → kept.
     */
    maxRequiredYears: 5,
    /**
     * Titles that are always off-target regardless of keyword bleed. Matched
     * case-insensitively as substrings (spaces/dots/hyphens normalized first).
     */
    rejectTitles: [
      "vue", "angular", "svelte", "ember",
      "android", "ios", "flutter", "react native", "mobile",
      "\\.net", "asp.net", "php", "laravel", "c++", "c#", "golang", "go developer",
      "rust", "qt", "qml", "embedded",
      "wordpress", "drupal", "shopify", "salesforce", "servicenow", "sap", "sharepoint",
      "devops", "sre", "site reliability", "qa", "sdet", "tester", "automation engineer",
      "product manager", "project manager", "program manager", "scrum master",
      "business analyst", "recruit", "talent acquisition", "sales", "trainer",
      "data scientist", "data engineer", "data analyst",
    ],
    /**
     * Backend-leaning titles dropped ONLY when no frontend signal is present in
     * the title (so "React / Node.js Developer" survives, "Node.js Developer"
     * does not). Frontend signal = any of `frontendTitleTokens`.
     */
    backendTitles: ["backend", "back end", "node", "nodejs", "node.js", "java", "python", "ml engineer", "machine learning"],
    frontendTitleTokens: ["react", "next", "frontend", "front end", "front-end", "ui", "ux", "web", "javascript", "typescript"],
  },

  /** Freshness = last 24h. Server-side params per platform. */
  freshness: {
    linkedin_f_TPR: "r86400", // last 24h
    naukri_param: "jobAge", // value "1" = last 1 day (verified working logged-out, 2026-06-23)
    naukri_value: "1",
    // Free APIs lag (Remotive ~days). They are SUPPLEMENTARY, not strict-24h;
    // LinkedIn/Naukri provide the real last-24h freshness. Keep this window wide.
    apiMaxAgeHours: 120,
  },

  sources: {
    remotive: { enabled: true, maxPages: 1 } as SourceToggle,
    remoteok: { enabled: true, maxPages: 1 } as SourceToggle,
    linkedin: { enabled: true, maxPages: 1 } as SourceToggle, // kept at 1: enrich-bound + soft-block risk; widen via terms, not pages
    naukri: { enabled: true, maxPages: 3 } as SourceToggle, // LOCAL ONLY (residential India IP) — cheap per request, so widen here
  },

  endpoints: {
    remotive: "https://remotive.com/api/remote-jobs",
    remoteok: "https://remoteok.com/api",
    linkedin: "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search",
    linkedinDetail: "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/", // + jobId
    naukri: "https://www.naukri.com/jobapi/v3/search",
  },

  /**
   * Naukri's guest `jobapi/v3` rejects requests without these. The `nkparam`
   * header is minted per-request in `src/sources/naukri.ts` (see below).
   */
  naukriHeaders: {
    appid: "109",
    systemid: "Naukri",
    gid: "LOCATION,INDUSTRY,EDUCATION,FAREA_ROLE",
    clientid: "d3skt0p",
  } as Record<string, string>,

  /**
   * Naukri's RSA *public* key, embedded in their app JS. Used to mint the
   * `nkparam` header (RSA PKCS#1 v1.5 of `v0|<Date.now()>|121_srp`, base64'd).
   * If the 406 "recaptcha required" gate returns after a valid token, Naukri
   * likely rotated this key or the plaintext format — re-extract both from
   * their current app JS. See README → "Naukri — the nkparam unblock".
   */
  naukriPublicKey: `-----BEGIN PUBLIC KEY-----
MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBALrlQ+djR0RjJwBF1xuisHmdFv334MIm
K6LgzJhmLhN7B5yuEyaKoasgXQk3+OQglsOaBxEJ0j5PcTL3nbOvt80CAwEAAQ==
-----END PUBLIC KEY-----`,
  naukriNkparamSuffix: "121_srp",

  /**
   * Search terms used by BOTH LinkedIn and Naukri (naukri.ts iterates this same
   * list). Each term multiplies requests: terms × locations × maxPages × 2
   * sources. The post-scoring filter (filter.ts) now cleans up the extra noise
   * broad terms bring in, so we can afford a wider net than before.
   */
  linkedinSearchTerms: [
    "Frontend Engineer",
    "Frontend Developer",
    "React Developer",
    "Next.js Developer",
    "UI Developer",
  ],

  /**
   * CSS selectors for the logged-out guest job cards. If LinkedIn changes its
   * markup the source will fail loudly — fix these here, nowhere else.
   */
  linkedinSelectors: {
    card: "li",
    title: ".base-search-card__title",
    company: ".base-search-card__subtitle",
    location: ".job-search-card__location",
    link: "a.base-card__full-link",
    date: "time",
    entityUrn: "[data-entity-urn]",
  } as Record<string, string>,

  /** LinkedIn guest filter params (besides keywords/location/geoId). */
  linkedinParams: {
    f_WT_remote: "2", // work type = Remote
    pageStep: 10, // guest endpoint returns ~10 cards/page; step by 10 to avoid gaps
  },

  /**
   * Guest cards carry no description, so a card's title-only score is useless
   * for deciding *which* jobs to enrich (every card scores ~0-10%). So we
   * enrich the LinkedIn set UP FRONT — fetching each detail page for the full
   * JD (+ salary) — then score once on real text. `maxEnrich` caps the number
   * of polite detail fetches per run.
   */
  linkedinEnrich: { enabled: true, maxEnrich: 110 },
  linkedinDetailSelectors: {
    description: ".show-more-less-html__markup",
    salary: ".compensation__salary, .salary, .salary--main",
    criteria: ".description__job-criteria-text",
  } as Record<string, string>,

  /** Polite scraping knobs. */
  http: {
    minDelayMs: 2500,
    maxDelayMs: 5000,
    maxRetries: 4,
    backoffBaseMs: 1500,
    timeoutMs: 20000,
    cacheTtlMinutes: 30,
    userAgents: [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    ],
  },

  /** Attribution required by free-API terms (RemoteOK/Remotive). */
  attribution: true,

  output: { dir: "./output", topN: 25 },
  data: { dir: "./data", dbFile: "./data/jobs.db", cacheDir: "./.cache" },

  /** HARD RULE: never authenticate to LinkedIn/Naukri. */
  forbidLogin: true,
} as const;

export type Config = typeof CONFIG;

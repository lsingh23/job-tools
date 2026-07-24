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
 *
 * Weights are RELATIVE WITHIN A TIER; the tier itself decides how much it can
 * move the score (see scoreWeights below). A job that hits all CORE keywords
 * already scores high even if it omits the long tail of bonus keywords.
 *
 * Kept in sync with what actually appears in Indian frontend JDs right now:
 * recruiters screen hard for the core/strong set and treat bonus items as
 * differentiators. Backend tokens on the résumé are `ignore` so they never
 * inflate a frontend score.
 */
export const KEYWORDS: KeywordSpec[] = [

  // ── CORE ─────────────────────────────────────────────────────────────────
  // Non-negotiable — every legit frontend JD in 2026 mentions these.
  { label: "React",       aliases: ["react", "react.js", "reactjs"],              weight: 5, tier: "core" },
  { label: "Next.js",     aliases: ["next.js", "nextjs", "next js"],              weight: 5, tier: "core" },
  { label: "TypeScript",  aliases: ["typescript"],                                weight: 5, tier: "core" },
  { label: "JavaScript",  aliases: ["javascript", "js", "es6", "es2022", "ecmascript"], weight: 4, tier: "core" },

  // ── STRONG ───────────────────────────────────────────────────────────────
  // Things that appear in the majority of 2026 frontend JDs — broad enough
  // that missing one or two doesn't mean the job is a bad fit.

  // State management (at least one shows up in every serious React JD)
  { label: "Redux / Redux Toolkit",  aliases: ["redux", "redux toolkit", "rtk", "@reduxjs/toolkit"],      weight: 3, tier: "strong" },
  { label: "Zustand / Jotai",        aliases: ["zustand", "jotai", "context api"],                        weight: 2, tier: "strong" },
  { label: "TanStack Query",         aliases: ["tanstack", "react query", "react-query", "@tanstack"],    weight: 3, tier: "strong" },

  // Styling
  { label: "TailwindCSS",            aliases: ["tailwind", "tailwindcss"],                                weight: 3, tier: "strong" },
  { label: "CSS / Sass",             aliases: ["css", "scss", "sass", "css modules", "styled-components", "emotion"], weight: 2, tier: "strong" },

  // Testing
  { label: "Testing",                aliases: ["jest", "vitest", "playwright", "cypress", "react testing library", "rtl", "testing library", "unit testing", "e2e"], weight: 3, tier: "strong" },

  // Quality
  { label: "Accessibility (a11y)",   aliases: ["accessibility", "a11y", "wcag", "aria"],                 weight: 3, tier: "strong" },
  { label: "Performance / CWV",      aliases: ["core web vitals", "web vitals", "lighthouse", "performance optimization", "lcp", "cls", "inp"], weight: 3, tier: "strong" },
  { label: "Responsive Design",      aliases: ["responsive", "responsive design", "mobile-first"],        weight: 2, tier: "strong" },

  // Toolchain
  { label: "CI/CD",                  aliases: ["ci/cd", "cicd", "github actions", "gitlab ci", "jenkins"], weight: 2, tier: "strong" },
  { label: "Git",                    aliases: ["git", "github", "gitlab"],                                weight: 1, tier: "strong" },

  // APIs
  { label: "REST APIs",              aliases: ["rest", "rest api", "restful", "api integration"],         weight: 2, tier: "strong" },
  { label: "GraphQL",                aliases: ["graphql", "apollo", "apollo client"],                    weight: 2, tier: "strong" },

  // Fullstack / backend
  { label: "Node.js",                aliases: ["node.js", "nodejs", "node", "express"],                  weight: 2, tier: "strong" },

  // Deployment / infra
  { label: "Vercel / Netlify",       aliases: ["vercel", "netlify", "cloudflare workers", "edge functions"], weight: 2, tier: "strong" },
  { label: "Docker / Cloud",         aliases: ["docker", "aws", "gcp", "azure"],                         weight: 1, tier: "strong" },

  // Architecture
  { label: "Micro-frontends",        aliases: ["micro frontend", "microfrontend", "module federation", "turborepo", "monorepo", "nx"], weight: 2, tier: "strong" },

  // Data & auth
  { label: "PostgreSQL / SQL",       aliases: ["postgresql", "postgres", "sql", "prisma", "drizzle"],    weight: 1, tier: "strong" },
  { label: "Auth",                   aliases: ["oauth", "jwt", "nextauth", "auth.js", "clerk", "authentication"], weight: 1, tier: "strong" },

  // ── BONUS ────────────────────────────────────────────────────────────────
  // Role-specific extras — present in some JDs but not expected universally.

  // Next.js-specific features
  { label: "App Router",             aliases: ["app router", "app-router"],                               weight: 3, tier: "bonus" },
  { label: "Server Components",      aliases: ["server components", "rsc", "react server components"],   weight: 2, tier: "bonus" },
  { label: "Server Actions",         aliases: ["server actions"],                                         weight: 2, tier: "bonus" },

  // Mobile / cross-platform
  { label: "React Native",           aliases: ["react native"],                                           weight: 4, tier: "bonus" },
  { label: "Expo",                   aliases: ["expo", "expo router"],                                   weight: 2, tier: "bonus" },

  // Design system tooling
  { label: "shadcn/ui + Radix",      aliases: ["shadcn", "shadcn/ui", "radix", "radix-ui", "radix ui"],  weight: 2, tier: "bonus" },
  { label: "Design System",          aliases: ["design system", "component library", "storybook"],       weight: 2, tier: "bonus" },

  // Build tools
  { label: "Vite / Webpack",         aliases: ["vite", "webpack", "esbuild", "turbopack"],               weight: 1, tier: "bonus" },

  // AI / LLM
  { label: "AI / LLM Integration",   aliases: ["vercel ai sdk", "ai sdk", "openai", "langchain", "rag", "llm", "generative ai", "genai", "ai integration", "mcp"], weight: 3, tier: "bonus" },

  // Animation
  { label: "Framer Motion",          aliases: ["framer motion", "framer", "motion", "gsap", "lottie"],   weight: 1, tier: "bonus" },

  // Realtime
  { label: "WebSockets / SSE",       aliases: ["websocket", "websockets", "sse", "server-sent events", "realtime", "socket.io"], weight: 1, tier: "bonus" },

  // i18n, PWA, misc
  { label: "i18n",                   aliases: ["i18n", "internationalization", "next-intl", "react-i18next"], weight: 1, tier: "bonus" },
  { label: "PWA / Service Worker",   aliases: ["pwa", "progressive web app", "service worker"],          weight: 1, tier: "bonus" },
  { label: "Agile / Scrum",          aliases: ["agile", "scrum", "kanban"],                              weight: 1, tier: "bonus" },

  // ── IGNORE ───────────────────────────────────────────────────────────────
  // On résumé / in JDs but should never boost a frontend role's match score.
  { label: "Java",   aliases: ["java"],   weight: 0, tier: "ignore" },
  { label: "Scala",  aliases: ["scala"],  weight: 0, tier: "ignore" },
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
    // City-level searches have better precision than the national geoId.
    // Confirmed geoIds: Bengaluru=105214831, Hyderabad=105556991.
    // Other cities use the location= text param (guest API accepts both).
    linkedin: [
      { label: "Bengaluru",  geoId: "105214831",                              remote: false },
      { label: "Hyderabad",  geoId: "105556991",                              remote: false },
      { label: "Pune",       location: "Pune, Maharashtra, India",            remote: false },
      { label: "Mumbai",     location: "Mumbai, Maharashtra, India",          remote: false },
      { label: "Delhi",      location: "Delhi, India",                        remote: false },
      { label: "Chennai",    location: "Chennai, Tamil Nadu, India",          remote: false },
      { label: "Remote (India)", geoId: "102713980",                          remote: true  },
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
    // EMPTY on purpose: setting f_E makes LinkedIn return ONLY jobs the poster
    // explicitly tagged at these levels, so any UNTAGGED posting (common from
    // small consultancies/body-shops, e.g. a legit 3-yr Next.js role) is
    // silently excluded server-side. We let filter.ts drop over-senior roles
    // client-side instead (minRequiredYears ≥ maxRequiredYears + senior-title
    // gate), which keeps untagged jobs in play. Re-add ["2","3","4"] to restore
    // the server-side level filter.
    linkedinLevels: [] as string[],
    favorMin: 3,
    favorMax: 5,
    stretchFrom: 6,
  },

  /**
   * Title relevance: a job's keyword score is scaled by what KIND of role the
   * title describes. Three classes, checked in order (fullstack wins over
   * frontend, so "Full Stack React Developer" is fullstack):
   *
   *   frontend  — title carries a frontend token (react/next/frontend/ui/…)
   *   fullstack — title carries a fullstack token (full stack, MERN, …)
   *   generic   — everything else that survived prefilter ("Software Engineer",
   *               "Product Engineer", "Developer")
   *
   * WHY A CLASS AND NOT JACCARD: the old model was token-set similarity against
   * `titles`, squashed into [titleFitFloor, 1]. Jaccard punishes LONG titles
   * (every extra token shrinks the ratio), so "Software Engineer III - React,
   * TypeScript" scored WORSE than a bare "Software Engineer" — which forced the
   * floor up to 0.93 to stop the bleeding, and at 0.93 the title stopped
   * mattering at all: a fullstack JD that name-drops React+Next+TS+JS beat every
   * genuine frontend role by 20+ points on core coverage alone. Classes give the
   * title real weight (a 20% spread) without the length bias.
   *
   * `tiebreak` is the only Jaccard left: within a class, a title closer to your
   * `titles` wording ranks first (this also orders the enrich budget in
   * pipeline.ts). It is smaller than the gap between classes, so classes never
   * overlap — frontend ∈ [0.97, 1.0], fullstack ∈ [0.82, 0.85], generic ∈
   * [0.77, 0.80].
   */
  relevance: {
    titleClass: { frontend: 1.0, fullstack: 0.85, generic: 0.8 },
    tiebreak: 0.03,
    /** Fullstack markers, checked BEFORE the frontend tokens. Normalised like titles. */
    fullstackTitleTokens: ["fullstack", "full stack", "mern", "mean", "mevn"],
  },

  /**
   * Backend-mass penalty: how much BACKEND the JD actually asks for, as a
   * multiplier on the final score.
   *
   * The keyword scorer only ever ADDS credit, and backend tokens sit in the
   * `ignore` tier (weight 0) — so a Java+Spring+Kafka role that happens to name
   * React/Next/TS scored identically to a pure React role. That is how "Full
   * Stack Developer" ended up out-ranking every frontend posting. This measures
   * the other half of the JD and discounts for it.
   *
   * Counted by GROUP, not by token, so a JD repeating "Spring / Spring Boot /
   * Hibernate" is one hit, not three — the signal is "how many backend WORLDS
   * does this role live in", not vocabulary volume. Deliberately gentle
   * (`perGroup` 0.04, capped at `max` 0.25): a React+Node role with a database
   * loses ~8%, a genuine Java-shop fullstack role loses the full 25%.
   *
   * NOT listed here: aws/gcp/docker/postgres/node — those already earn positive
   * credit in the `strong` tier and appear in plenty of real frontend JDs.
   */
  backendPenalty: {
    enabled: true,
    perGroup: 0.04,
    max: 0.25,
    groups: [
      { label: "Java/JVM",      aliases: ["java", "spring", "spring boot", "springboot", "hibernate", "jpa", "kotlin", "scala", "maven", "j2ee"] },
      { label: "Python backend", aliases: ["python", "django", "flask", "fastapi", "celery"] },
      { label: ".NET",          aliases: [".net", "asp.net", "c#", "entity framework"] },
      { label: "PHP",           aliases: ["php", "laravel", "symfony", "codeigniter"] },
      { label: "Ruby",          aliases: ["ruby", "rails", "ruby on rails"] },
      { label: "Go",            aliases: ["golang", "go lang"] },
      { label: "Node backend",  aliases: ["nestjs", "nest.js", "koa", "hapi", "sequelize", "mongoose"] },
      { label: "NoSQL / other DB", aliases: ["mongodb", "mongo", "mysql", "cassandra", "dynamodb", "elasticsearch", "redis"] },
      { label: "Queues / orchestration", aliases: ["kafka", "rabbitmq", "kubernetes", "k8s", "terraform", "helm", "airflow"] },
      { label: "Backend architecture", aliases: ["microservices", "micro-services", "grpc", "message queue", "distributed systems", "system design"] },
    ],
  },

  /**
   * How the match % is split across tiers (must sum to 1). Full coverage of a
   * tier earns its whole share. Design decision: HAVING ALL FOUR CORE SKILLS
   * (React+Next+TS+JS) IS a top match, full stop — so core carries 0.92. The
   * strong (19 kw) and bonus (14 kw) tiers can never be fully covered by any one
   * JD, so weighting them heavily just capped good roles at ~70; they now act as
   * a light tiebreaker. Result on real jobs: all-4-core → 87-93, 3-core → 64-69,
   * 2-core → 47-48, off-target → <40. (Verify anytime: scripts/score-tune.ts.)
   */
  scoreWeights: { core: 0.92, strong: 0.06, bonus: 0.02 },

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
      // Competing frontend frameworks
      "vue", "angular", "svelte", "ember",
      // Definitively-mobile platforms (React Native is NOT here — it's a keep)
      "android", "ios", "flutter",
      // Stacks / platforms
      "\\.net", "asp.net", "php", "laravel", "c++", "c#", "golang", "go developer",
      "rust", "qt", "qml", "embedded",
      "wordpress", "drupal", "shopify", "salesforce", "servicenow", "sap", "sharepoint",
      // Ops / quality / non-engineering
      "devops", "sre", "site reliability", "qa", "sdet", "tester", "automation engineer",
      "product manager", "project manager", "program manager", "scrum master",
      "business analyst", "recruit", "talent acquisition", "sales", "trainer",
      "data scientist", "data engineer", "data analyst",
    ],
    /**
     * Backend-leaning titles dropped ONLY when no frontend signal is present.
     * "React + Node.js Developer" survives; "Node.js Developer" does not.
     * Frontend signal = any of `frontendTitleTokens`.
     */
    backendTitles: [
      "backend", "back end",
      "node", "nodejs", "node.js",
      "java",
      "python",
      "ruby", "rails",
      "django", "flask", "fastapi",
      "spring",
      "ml engineer", "machine learning",
    ],
    /**
     * Any one of these in the title is a strong enough frontend signal to keep
     * the job (even alongside backend tokens like "node" or "java").
     * After title normalisation all separators and concatenated forms are
     * collapsed, so a single token covers many written variants:
     *   "react" → React, ReactJS, React.js, React JS, React-JS, React/JS
     *   "next"  → Next.js, NextJS, Next JS, Next-JS
     *   "frontend" → Frontend, Front-End, Front End, Front end
     *   "ui"    → UI, UI/UX, UI-UX, UI UX
     */
    frontendTitleTokens: [
      "react",        // all React variants
      "next",         // all Next.js variants
      "frontend",     // all front-end variants
      "ui", "ux",     // UI/UX roles
      "javascript", "typescript",
      "web",
    ],
  },

  /** Freshness = last 2h. Server-side params per platform. */
  freshness: {
    linkedin_f_TPR: "r7200", // last 2h
    naukri_param: "jobAge", // value "1" = last 1 day (verified working logged-out, 2026-06-23)
    naukri_value: "1",
    // Free APIs lag (Remotive ~days). They are SUPPLEMENTARY, not strict-24h;
    // LinkedIn/Naukri provide the real last-24h freshness. Keep this window wide.
    apiMaxAgeHours: 120,
  },

  sources: {
    remotive: { enabled: true, maxPages: 1 } as SourceToggle,
    remoteok: { enabled: true, maxPages: 1 } as SourceToggle,
    linkedin: { enabled: true, maxPages: 20 } as SourceToggle, // embedding pre-filter handles noise; enrich only survivors
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
   * LinkedIn-ONLY priority search terms, run BEFORE `linkedinSearchTerms`.
   *
   * These use LinkedIn's boolean keyword syntax (AND / OR / quoted phrases),
   * which the guest `keywords` param honours. They run FIRST so their (higher-
   * signal) cards seed the dedupe set before the broad title queries. Kept
   * SEPARATE from `linkedinSearchTerms` on purpose: Naukri iterates that shared
   * list (src/sources/naukri.ts) and its guest API does NOT parse LinkedIn
   * boolean syntax — feeding it this string returns junk.
   *
   * PRIMARY = the "wide pure-title net". Empirically tuned 2026-07-22 against the
   * live guest endpoint (Bengaluru, r604800) across 3 measured rounds:
   *  - Every OR term is ITSELF a real frontend title spelling, so the net needs
   *    only a light NOT guard. Hit 100% title-precision (10/10 genuine frontend)
   *    on every run, even at 14 spellings — it swept up the exact roles the plain
   *    "Frontend Engineer" query was LOSING: "React.js Developer", "UI Specialist
   *    - ReactJS", "Web Developer", "Next.js Developer", "User Interface Engineer".
   *  - The winning pattern is pure-title OR + light NOT, NOT `title AND stack`:
   *    when the OR terms are already frontend titles the AND-anchor is redundant
   *    and only costs recall. (A tighter 5-term net actually scored WORSE, 80%.)
   *  - Two hard-won exclusions baked into the design (do not "simplify" away):
   *      • `"AI Engineer"` is TOXIC as a title token — it floods the GenAI/ML/
   *        Data-Science world (a query using it scored 0%). AI-frontend roles are
   *        caught via "Frontend" in the title instead, never via "AI Engineer".
   *      • `Angular`/`Vue`/`UI/UX` are too dirty for the bare OR net (drag in
   *        designers + generic SWE, ~60%); they belong only in an ANCHORED
   *        secondary query, so they're intentionally NOT in this net.
   *  - NOT (Java / .NET / immediate joiner / Salesforce / WordPress / QA) removes
   *    the Infosys/Capgemini body-shop + Java-React + WordPress leakage.
   *
   * Ceiling (proven twice): generic titles — "Product Engineer" / "Software
   * Engineer" / "AI Product Engineer" — are UNCRACKABLE by any title combination
   * (0–10% precision). Real frontend roles hide under those titles right next to
   * JPMorgan/Confluent-SRE false positives, and the title carries no signal to
   * separate them. That tier needs a downstream JD score, not another query here.
   */
  linkedinPriorityTerms: [
    '("Frontend Engineer" OR "Frontend Developer" OR "Front End Engineer" OR "Front End Developer" OR "Front-end Developer" OR "Frontend Software Engineer" OR "UI Developer" OR "UI Engineer" OR "User Interface Engineer" OR "React Developer" OR "React Engineer" OR "ReactJS Developer" OR "Next.js Developer" OR "Web Developer") NOT (Java OR ".NET" OR "immediate joiner" OR Salesforce OR WordPress OR QA)',
  ],

  /**
   * Stack-level queries, run AFTER the priority net. These exist to catch roles
   * whose TITLE doesn't say "frontend" but whose stack is unambiguously yours.
   *
   * WHAT WAS REMOVED AND WHY (2026-07-23): this used to be the bare stack names
   * "React" / "React.js" / "Next.js" (hardcoded in pipeline.ts). LinkedIn's
   * keyword search matches the DESCRIPTION too, so a bare "React" query returns
   * every Java/Python/DevOps posting that mentions React anywhere in its stack
   * paragraph. Measured on the 2026-07-23 run: those three queries contributed
   * the bulk of the "Full Stack Engineer" / "Software Engineer" / "Manager, Core
   * Technology" cards, which then ate the enrich budget and crowded the
   * shortlist. Stack alone is not a role signal.
   *
   * The fullstack boolean below is the deliberate replacement: fullstack roles
   * built on React/Next ARE valid targets, so they are now fetched ON PURPOSE by
   * an anchored query (fullstack title AND React/Next stack, minus the body-shop
   * stacks) instead of arriving as collateral from a bare stack keyword.
   */
  linkedinStackTerms: [
    '("Full Stack Developer" OR "Full Stack Engineer" OR "Fullstack Developer" OR "Fullstack Engineer" OR "Full-Stack Engineer" OR "Full Stack Web Developer") AND ("React" OR "React.js" OR "Next.js") NOT (Java OR ".NET" OR PHP OR Salesforce OR WordPress OR QA OR "immediate joiner")',
    "React.js Developer",
    "Next.js Developer",
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

  /**
   * LinkedIn guest filter params (besides keywords/location/geoId). These are the
   * "search hacks" applied in src/pipeline.ts buildUrl — one place to tune result
   * quality and freshness. Researched 2026-07-21 (trykondo, dev.to 2026 guide):
   *  - sortBy=DD  → date-descending (newest first). The guest endpoint defaults
   *    to Relevance; for hourly collection we want the freshest cards on top so
   *    each run surfaces genuinely new postings.
   *  - f_AL=true  → "Actively Hiring": companies actually reviewing applicants;
   *    cuts stale/ghost posts.
   *  - f_JT=F,C   → Full-time + Contract only; drops internships/part-time/volunteer.
   * (f_TPR time window and f_E experience come from CONFIG.freshness / .experience.)
   */
  linkedinParams: {
    f_WT_remote: "2", // work type = Remote
    pageStep: 10, // guest endpoint returns ~10 cards/page; step by 10 to avoid gaps
    sortBy: "DD", // DD = date descending (freshest first); "R" = relevance
    // f_AL OFF on purpose: "Actively Hiring" tracks companies reviewing applicants
    // ON LinkedIn, so postings whose "responses [are] managed off LinkedIn"
    // (external ATS / off-platform) get dropped server-side — that's how genuine
    // fresh roles like the Globalwave "Next JS Developer" go missing. f_TPR=2h
    // already guarantees freshness, so this gate mostly costs recall. Set true to restore.
    f_AL: false, // Actively Hiring filter (disabled — was silently cutting off-platform postings)
    f_JT: "F,C", // job type: Full-time + Contract (set "" to disable)
  },

  /**
   * Multi-city hourly collector (src/collect.ts + the in-process scheduler in
   * src/dashboard.ts). Runs the LinkedIn search across every CONFIG.locations.linkedin
   * entry, deduped, and upserts into Neon (DATABASE_URL), accumulating through the day.
   */
  collect: {
    /**
     * Time window per run. The scheduler fires hourly, so a 2h window with an
     * overlap buffer guarantees nothing slips between runs; the DB dedupe on
     * external_id collapses the overlap.
     */
    windowHours: 2,
    /** Listing pages per keyword per city. Kept low — sortBy=DD puts fresh on top. */
    pages: 2,
    /**
     * Local-clock hours the scheduler is allowed to auto-run, inclusive
     * [start, end]. [10, 19] = 10am–7pm. A manual "Run all cities now" ignores this.
     */
    activeHours: [10, 19] as [number, number],
    /**
     * Don't re-enrich a card we already JUDGED this recently (see `seen_cards`
     * in db.ts). The scheduler fires hourly over a 2h window, so ~80% of each
     * run's cards are the exact postings the previous run already fetched, read
     * and rejected — re-enriching them burned the whole `maxEnrich` budget on
     * known answers while genuinely new cards fell off the end of the cap and
     * scored 0. A cached DROP is skipped outright; a cached KEEP reuses its
     * stored JD text (still re-scored, so scoring changes apply) without an HTTP
     * call. Cards we never actually read are never cached — only decisions made
     * on real JD text count, so a job starved by the cap stays a candidate.
     *
     * Set to 0 to disable the cache and re-fetch everything every run.
     */
    skipSeenHours: 20,
  },

  /**
   * Guest cards carry no description, so a card's title-only score is useless
   * for deciding *which* jobs to enrich (every card scores ~0-10%). So we
   * enrich the LinkedIn set UP FRONT — fetching each detail page for the full
   * JD (+ salary) — then score once on real text. `maxEnrich` caps the number
   * of polite detail fetches per run.
   */
  linkedinEnrich: { enabled: true, maxEnrich: 60 }, // pre-filter reduces candidates; 60 enrich calls is safe

  /**
   * Salary enrichment via AmbitionBox (free, logged-out, no API key). The company
   * salary page embeds its top ~20 job profiles as JSON in __NEXT_DATA__, so we
   * fetch ONE page per unique company and match every job title against it —
   * cost scales with companies, not jobs.
   *
   * Bands are crowd-sourced and self-reported. `minDataPoints` is the honesty
   * gate: AmbitionBox happily serves a confident-looking band built from 2
   * submissions, which is noise. Below the gate we emit nothing rather than a
   * number you might quote at yourself in a negotiation.
   */
  salary: {
    enabled: false,       // disabled: AmbitionBox lookups are slow and inconsistent
    maxCompanies: 40,     // cap lookups per run; unique companies, not jobs
    minDataPoints: 10,    // drop bands thinner than this
    /**
     * Cosine floor for title → profile match (nomic-embed, loaded from
     * ./.model-cache). Matching itself is local CPU — no network — but salary is
     * currently the only thing that loads this model, so the first lookup of a
     * run pays the load. `embedPrefilter` below is configured but NOT wired:
     * prefilter.ts is pure regex.
     *
     * Calibrated on real pairs, NOT guessed. It has to sit below 0.786 to catch
     * the case that broke everything ("Full Stack Developer" → Capgemini's
     * "Software Developer", n=6319, which token overlap scored 0.40 and dropped)
     * while staying above the off-ladder noise ("Pentaho / Apache Hop" tops out
     * at 0.631 against every Capgemini profile). 0.75 sits in that gap.
     *
     * Do NOT read this as "75% confident it's the same job". Short titles embed
     * mushily: "Senior Fullstack Developer" scores 0.773 against "Senior 2D
     * Animator". The seniority + domain-token gates in matchProfile are what
     * reject those, and they must stay in force — the floor alone is not a gate.
     */
    minTitleSim: 0.75,
    /**
     * Floor for an `approx` match — the closest title below `minTitleSim` that
     * still shares a domain token with the posting. Exists because 0.75 is an
     * arbitrary cliff: "Java FSD with React or Node JS" → Capgemini's "Java
     * Developer" (n=1840) scores **0.745** and was being thrown away over 0.005.
     * The domain-token gate still applies, so this can only ever loosen matching
     * WITHIN a shared specialisation, never across one.
     */
    minApproxSim: 0.65,
    /**
     * Ladder fallback: when no title matches at all, use the company's generic
     * engineer rung at this posting's seniority + experience. The rung is real
     * signal — at Wissen, Software Engineer ≈13-14 LPA vs Senior Software
     * Engineer ≈23-25 LPA, a jump worth more than any stack keyword.
     *
     * It is gated on the TITLE CONTAINING A KNOWN TECH TOKEN, and that gate is
     * not optional. Measured against the ladder rungs, cosine CANNOT separate
     * on-target from off-target: "Business Analyst" scores 0.706 and "Network
     * Engineer" 0.823, while genuine "Java FSD…" scores 0.643 and "Pentaho /
     * Apache Hop" 0.609 — the ranges fully overlap, so no similarity floor works.
     * The domain gate can't help either: a ladder rung has no domain tokens, so
     * it never fires. Tech-vocabulary membership is the only thing that separates
     * them. Turning this off would put a Software Engineer band on Business
     * Analyst postings.
     */
    ladderFallback: true,
    /** Dice token-overlap floor, used ONLY when the embedding model is unavailable. */
    minTitleMatch: 0.5,
    cacheTtlMinutes: 10080, // 7 days — company salary aggregates move slowly

    /**
     * Fetch the per-role page to get salary split by experience bucket. Costs
     * one extra request per unique (company, role) — worth it: the headline band
     * blends all experience levels, so a 3-5 yr posting at Wissen reads 22.9-25.3
     * when the 3-6 yr reality is 21.0-23.2. `maxRoleLookups` caps the spend.
     */
    roleDetail: true,
    maxRoleLookups: 50,

    /**
     * Manual LinkedIn-name → AmbitionBox-slug overrides. Slug guessing resolves
     * ~89% of real company names; the rest are listed under a name you can't
     * derive (or aren't on AmbitionBox at all). When a company you care about
     * shows up in the run's "unresolved" list, find its AmbitionBox URL and add
     * the slug here — /salaries/<slug>-salaries.
     */
    aliases: {
      // "JPMorgan Chase & Co.": "jpmorgan-chase",
    } as Record<string, string>,
  },

  /**
   * Online-presence check — the FALLBACK for companies AmbitionBox has no page
   * for (i.e. the `unresolved` list a salary run prints). It never runs for a
   * company AmbitionBox covers, because there its founded-year / headcount /
   * isClosed fields already answer this better and cost nothing extra.
   *
   * Small and new does NOT mean less genuine: AmbitionBox needs a critical mass
   * of employee reviews, so a real 15-person startup founded in 2025 is simply
   * invisible to it. So this scores OPERATING FOOTPRINT, not age or headcount —
   * a company with a product has an `app.` and an `api.` on day one. Age can
   * only ever add to the score, never subtract.
   *
   * All free, keyless, no login: DNS (Node stdlib), Certificate Transparency via
   * crt.sh, and RDAP for registration dates (which covers .ai, unlike whois).
   *
   * Output is EVIDENCE FOR YOU TO READ, not a fraud verdict, and it never drops
   * a job. "unverified" means we couldn't find the company's domain — plenty of
   * real companies trade under a name you can't derive a domain from.
   */
  presence: {
    enabled: false,          // disabled: footprint probes are slow and unreliable
    maxCompanies: 15,        // cap probes per run; unique companies, not jobs
    maxCandidates: 8,        // domain guesses tried per company before giving up
    cacheTtlMinutes: 43200,  // 30 days — CT history and registration dates barely move
    /**
     * TLDs to try, in order. `.ai` leads because that's where the startups this
     * fallback exists for actually live; a trailing "AI" in the company name is
     * tried as the TLD first of all ("Recrew AI" → recrew.ai before recrewai.com).
     */
    tlds: ["ai", "com", "io", "co", "in", "tech"],
    /**
     * Manual company-name → domain overrides. Two cases need one:
     *
     *  1. `unverified` — we couldn't guess the domain. Plenty of real companies
     *     trade under a name you can't derive a domain from.
     *  2. A DIFFERENT company owns the obvious domain. The name-in-title gate
     *     can't tell two same-named companies apart, so always sanity-check the
     *     `presence_domain` CSV column against the employer you actually mean.
     *
     * Live example of (2): "Level AI" (voice AI, thelevel.ai) guesses `level.ai`
     * — a different company — and then `levelai.ai`, an unrelated edtech that
     * really is called Level.AI. Both pass a name check; neither is the employer.
     */
    aliases: {
      // "Level AI": "thelevel.ai",  // level.ai + levelai.ai are BOTH other companies
    } as Record<string, string>,
  },

  /**
   * Embedding-based pre-filter applied to LinkedIn title cards BEFORE enrich.
   * Computes cosine similarity between each job title and the full resume text
   * (Xenova/nomic-embed-text-v1, ~274 MB, cached in ./.model-cache after first run).
   * Only titles above `titleThreshold` get their JD fetched and scored.
   */
  embedPrefilter: {
    enabled: true,
    model: "Xenova/nomic-embed-text-v1",
    // Cosine floor for title-vs-resume. Intentionally loose: better to enrich
    // a few false positives than miss a genuine match with an unusual title.
    titleThreshold: 0.25,
  },
  linkedinDetailSelectors: {
    description: ".show-more-less-html__markup",
    salary: ".compensation__salary, .salary, .salary--main",
    criteria: ".description__job-criteria-text",
    criteriaItem: ".description__job-criteria-item",
    criteriaHeader: ".description__job-criteria-subheader",
    applicants: "figcaption.num-applicants__caption, .num-applicants__caption",
    // Apply button: tracking-control-name is "public_jobs_apply-link-onsite" (Easy
    // Apply, stays on LinkedIn) or "...-offsite_..." (redirects to company site/ATS).
    applyButton: "[data-tracking-control-name^='public_jobs_apply-link-']",
    // "Message the recruiter" block, present on postings with a named HR contact.
    recruiterLink: ".message-the-recruiter__cta",
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

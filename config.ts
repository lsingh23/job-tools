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
  // Non-negotiable — the three a legit frontend JD names in some form. Frameworks
  // ON TOP of these (Next.js and the rest) are strong-tier: valuable, not required.
  { label: "React",       aliases: ["react", "react.js", "reactjs"],              weight: 5, tier: "core" },
  { label: "TypeScript",  aliases: ["typescript"],                                weight: 5, tier: "core" },
  { label: "JavaScript",  aliases: ["javascript", "js", "es6", "es2022", "ecmascript"], weight: 4, tier: "core" },

  // ── STRONG ───────────────────────────────────────────────────────────────
  //
  // Next.js lives HERE, not in core. A JD that says React + TypeScript +
  // JavaScript and never names Next.js is still a full core match — Next is a
  // meta-framework you pick up, not a fourth non-negotiable — and while it sat
  // in core its weight-5 absence cost such a JD ~24 points, which is a quarter
  // of the scale for a tool the role may simply not use. It still pays well
  // (top of the strong tier, plus its own stackProfile item, plus the IMPLIES
  // rule in scoring.ts that credits React to a pure-Next.js posting), so a
  // Next.js role ranks above an otherwise identical one without it.
  { label: "Next.js",                aliases: ["next.js", "nextjs", "next js"],                           weight: 4, tier: "strong" },

  // Things that appear in the majority of 2026 frontend JDs — broad enough
  // that missing one or two doesn't mean the job is a bad fit.

  // State management (at least one shows up in every serious React JD)
  { label: "Redux / Redux Toolkit",  aliases: ["redux", "redux toolkit", "rtk", "@reduxjs/toolkit"],      weight: 3, tier: "strong" },
  { label: "Zustand / Jotai",        aliases: ["zustand", "jotai", "context api"],                        weight: 2, tier: "strong" },
  { label: "TanStack Query",         aliases: ["tanstack", "react query", "react-query", "@tanstack"],    weight: 3, tier: "strong" },

  // Styling
  { label: "TailwindCSS",            aliases: ["tailwind", "tailwindcss"],                                weight: 3, tier: "strong" },
  { label: "HTML / CSS / Sass",      aliases: ["html", "html5", "css", "css3", "scss", "sass", "css modules", "styled-components", "emotion"], weight: 2, tier: "strong" },
  { label: "Material UI",            aliases: ["material ui", "material-ui", "mui", "@mui"],              weight: 2, tier: "strong" },

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

  // Rendering strategy — the words a JD uses when it means Next.js without ever
  // naming it ("server-side rendering", "SSG/ISR"), so those roles stop reading
  // as plain client-side React.
  { label: "SSR / SSG",              aliases: ["server-side rendering", "server side rendering", "ssr", "ssg", "static site generation", "isr", "incremental static regeneration"], weight: 2, tier: "strong" },

  // Fullstack / backend
  { label: "Node.js",               aliases: ["node.js", "nodejs", "node", "express", "express.js", "expressjs"], weight: 2, tier: "strong" },

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
  { label: "App Router",           aliases: ["app router", "app-router"],                               weight: 3, tier: "bonus" },
  { label: "Server Components",      aliases: ["server components", "rsc", "react server components"],   weight: 2, tier: "bonus" },
  { label: "Server Actions",         aliases: ["server actions"],                                         weight: 2, tier: "bonus" },

  // Mobile / cross-platform
  { label: "React Native",           aliases: ["react native"],                                           weight: 4, tier: "bonus" },
  { label: "Expo",                   aliases: ["expo", "expo router"],                                   weight: 2, tier: "bonus" },

  // Design system tooling
  { label: "shadcn/ui + Radix",      aliases: ["shadcn", "shadcn/ui", "radix", "radix-ui", "radix ui", "headless ui"], weight: 2, tier: "bonus" },
  { label: "Design System",          aliases: ["design system", "component library", "storybook"],       weight: 2, tier: "bonus" },

  // Build tools
  { label: "Vite / Webpack",         aliases: ["vite", "webpack", "esbuild", "turbopack"],               weight: 1, tier: "bonus" },

  // AI / LLM
  { label: "AI / LLM Integration",   aliases: ["vercel ai sdk", "ai sdk", "openai", "langchain", "rag", "llm", "generative ai", "genai", "ai integration", "mcp"], weight: 3, tier: "bonus" },

  // AI-assisted development. "cursor" is bare on purpose: in a 2026 JD the word
  // is the editor, not the CSS property (JDs don't discuss `cursor: pointer`).
  { label: "AI coding tools",        aliases: ["cursor", "claude code", "github copilot", "copilot", "windsurf", "codeium", "ai pair programming", "ai-assisted development"], weight: 1, tier: "bonus" },

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
      /**
       * NATIONAL SWEEP. Runs first so its cards seed the dedupe set.
       *
       * NOT here for tier-2 coverage — that was the guess, and it was wrong.
       * Measured 2026-08-12 (scripts, since deleted): the national geoId paged 8
       * deep over a 24h window returned 65 cards the 8-city collector had NEVER
       * seen across its entire 7,990-card history, and only SEVEN of those were
       * outside the eight metros. The other 58 were Bengaluru/Hyderabad/Pune
       * jobs the city queries are supposed to cover and don't.
       *
       * The reason they don't is the point of this entry: ~19 of the 65 are
       * filed under a SUB-CITY OR REGIONAL geo entity — "Pune Division" (6 of
       * them), "Bengaluru East", "Bangalore Urban", "Greater Hyderabad Area",
       * "Mumbai Metropolitan Region", "Serilingampalli", "Kushalnagar". geoId
       * 105214831 is Bengaluru *proper* and location="Pune, Maharashtra, India"
       * is Pune *proper*, so a posting on one of those neighbouring entities is
       * unreachable by the city queries at ANY page depth. Only the national
       * geoId sees them. Among the misses: a Gartner "Lead Software Engineer -
       * Frontend (React JS + Next/NodeJS)" and a MethodTech "Frontend Engineer —
       * React / Next.js".
       *
       * WHY pages=3 AND NOT MORE. `pages` is a real cost here, not a self-
       * limiting cap: in the production 2h window, 5 of the 8 search terms were
       * still returning FULL 10-card pages at p8, so the loop's end-of-results
       * break never fires and every extra page is 8 more requests (~30s).
       *
       * And depth does not buy quality, because the guest endpoint is
       * RELEVANCE-ranked — `sortBy=DD` is a measured no-op, so the deep pages are
       * not "older jobs", they are LOWER-RELEVANCE ones, which is where LinkedIn
       * pads a thin result set with description-level matches. That shows in the
       * p7-p8 misses this sweep found: "Shopify Developer", "SR. IT Analyst",
       * "Web & Mobile Developer (IOS)". 3 pages buys the high-relevance head plus
       * the geo-entity misses for ~1.5 min/run; page 4+ is mostly padding.
       */
      { label: "India",      geoId: "102713980",     pages: 3,                remote: false },
      { label: "Bengaluru",  geoId: "105214831",                              remote: false },
      { label: "Hyderabad",  geoId: "105556991",                              remote: false },
      { label: "Pune",       location: "Pune, Maharashtra, India",            remote: false },
      { label: "Mumbai",     location: "Mumbai, Maharashtra, India",          remote: false },
      { label: "Delhi",      location: "Delhi, India",                        remote: false },
      // Gurugram/Noida are their own searches, not covered by "Delhi": the guest
      // endpoint matches the location string against the posting's own city text,
      // so a Gurugram posting simply doesn't come back under "Delhi, India".
      { label: "Gurugram",   location: "Gurugram, Haryana, India",            remote: false },
      { label: "Noida",      location: "Noida, Uttar Pradesh, India",         remote: false },
      { label: "Chennai",    location: "Chennai, Tamil Nadu, India",          remote: false },
      { label: "Remote (India)", geoId: "102713980",                          remote: true  },
    ],
    // "India" is a national search that already surfaces the metros, but with
    // sort=freshness + few pages it cuts off; adding metros as their own queries
    // pulls city-specific fresh roles the national pagination misses. Naukri
    // requests are cheap (full JD inline, no per-job enrich), so casting wide
    // here is the best coverage-per-request. dedupe collapses the overlap.
    naukri: ["India", "Remote", "Bengaluru", "Pune", "Hyderabad", "Gurgaon", "Noida"],
    // Free APIs are remote-global; we filter India/remote client-side.
    keywordsForApis: ["frontend", "react", "next.js", "typescript"],
  },

  /**
   * Experience. Naukri filters source-side at `naukriYears`; LinkedIn's `f_E` is
   * off (see below). filter.ts still does the client-side seniority cut on top.
   * favorMin/favorMax/stretchFrom still drive the "stretch" seniority label.
   */
  experience: {
    /**
     * Naukri's `experience=<years>` query param. NULL on purpose = don't send it.
     *
     * Naukri keeps only the bands that BRACKET this value, so it cuts far harder
     * than "roles near 3 years" suggests — a 5-7y or 6-9y posting is gone even
     * when it is the single most on-title result in the window. Measured
     * 2026-08-11, bare "frontend"/Bengaluru, sweeping the pool to exhaustion:
     *
     *              jobs in pool   cards in last 6h   FRONTEND TITLES in last 6h
     *   experience=3      94              26                    7
     *   (no param)       260              83                   21
     *
     * The 14 it removed were the good ones: "Frontend Developer (React +
     * TypeScript)" 5-7y, "Senior Frontend Developer" 6-9y, "Front-End Developer"
     * 7-8y, "Senior SWE - Frontend Focused" 6-11y, TCS "React / UI Developer"
     * 6-10y, "Lead - MERN Stack Developer" 5-8y.
     *
     * An earlier round of this measurement at pages=3 suggested turning it off was
     * only a reshuffle (a wider pool competing for the same 60-card cap). That was
     * an artifact of the cap binding: at pages=5 it does not bind, and the filter
     * is pure loss. Same failure mode as `linkedinLevels` below — let filter.ts
     * cut seniority client-side, where an over-senior role is penalised rather
     * than made invisible. Set to a number to restore the server-side filter.
     */
    naukriYears: null as number | null,
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

    /**
     * STACK PURITY — a fullstack/generic title whose JD asks for NOTHING outside
     * your stack is not the same job as one that wants Java or Python too, and
     * must not be taxed as if it were.
     *
     * The class multiplier above is a bet: "fullstack" in a title usually means
     * the other half is somebody else's language, so the class costs 15%. On a
     * JD like "TypeScript, React, Next.js, PostgreSQL, LLM APIs, Docker" that bet
     * is simply wrong — the fullstack half IS your stack, and the 15% is a pure
     * loss that pushed real AI-native product roles below thin "Frontend
     * Developer" posts riding the `titleBoost` floor.
     *
     * The gate is deliberately strict, and it is EVIDENCE, not vocabulary: the
     * JD must name React or TypeScript (`stackProfile.anchors`), must match ZERO
     * `backendPenalty` groups — no Java, Python, .NET, PHP, Go, Rails, Nest,
     * Mongo/MySQL, Kafka/K8s, microservices — and the title itself must carry no
     * `titleBoost.disqualifiers`. One foreign group and the normal class applies
     * again, so this can never quietly rehabilitate a Java-shop posting.
     *
     * Bands stay disjoint and ordered (tiebreak 0.03 wide):
     *   frontend [0.97,1.00] > fullstackClean [0.93,0.96] > genericClean
     *   [0.87,0.90] > fullstack [0.82,0.85] > generic [0.77,0.80]
     * so a clean fullstack role ranks just under a true frontend title and above
     * every mixed-stack one — which is exactly the judgement being encoded.
     */
    purity: {
      enabled: true,
      fullstackClean: 0.96,
      genericClean: 0.90,
    },

    /**
     * TITLE BOOST — a title that literally says React / Next.js / Frontend is
     * YOUR job, and must rank high whatever the JD's keyword coverage looks
     * like.
     *
     * Why a FLOOR and not points: the tiered score measures how many of your
     * keywords the JD happens to name, and a short, thin or badly-written JD
     * ("Frontend Developer — React. Apply within.") names almost none, so a role
     * that is unambiguously the right role scored in the 40s and folded away
     * under `lowRankBelow`. Adding points would instead inflate the JDs that are
     * already scoring well. A floor lifts only the ones the JD failed to
     * explain, and leaves every genuinely high score untouched.
     *
     * `disqualifiers` are the "low-score keywords" — a title that says Java or
     * Python is a backend/other-discipline role wearing a frontend word
     * ("Java Fullstack Developer with React"), and gets no floor at all. Matched
     * on the TITLE only: Java/Python inside a JD is already handled, gently and
     * proportionally, by `backendPenalty`.
     *
     * The floor is applied to the match % BEFORE `penalties` run, so it is a
     * floor on FIT, not immunity: a boosted title that is an internship, asks
     * for 10+ years or is posted by a mass recruiter still sinks by exactly the
     * points those rules take off. That is deliberate — "rank React titles high"
     * should not resurrect a React internship.
     */
    titleBoost: {
      enabled: true,
      /** Minimum match % for a boosted title (before penalties). */
      floor: 82,
      /**
       * Boost markers. Normalised the same way titles are (front end→frontend,
       * react js→react, next js→next), so "Front-End", "Front End", "Frontend",
       * "ReactJS", "React.js", "Next.js" and "Nextjs" are all one token each.
       */
      tokens: ["react", "next", "frontend"],
      /** Title words that cancel the boost outright. */
      disqualifiers: [
        "java", "python", "django", "flask", "spring", "kotlin", "scala",
        "php", "laravel", "ruby", "rails", "golang", ".net", "c#",
      ],
    },
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
   * tier earns its whole share. Design decision: HAVING THE CORE SKILLS
   * (React + TypeScript + JavaScript) IS a top match, full stop — so core
   * carries 0.92. The strong and bonus tiers can never be fully covered by any
   * one JD, so weighting them heavily just capped good roles at ~70; they now
   * act as a light tiebreaker (which is exactly the job Next.js does there now).
   * Result on real jobs: all-core → 89-97 with stack breadth, 77-82 without;
   * 2-of-3 core → ~60; off-target → <35. (Verify: scripts/score-tune.ts.)
   */
  scoreWeights: { core: 0.92, strong: 0.06, bonus: 0.02 },

  /**
   * STACK PROFILE — reward the OVERLAP WITH YOUR WHOLE STACK, as a set.
   *
   * The tiered score above asks "does this JD name my core skills?". It cannot
   * tell a React+TS job that also runs Next, Tailwind, TanStack, Playwright,
   * Docker and Vercel — i.e. your actual day job — apart from a React+TS job
   * that names nothing else, because both max out the core tier. This block adds
   * the missing axis: how MUCH of your stack, counted as distinct items, the JD
   * describes. Broad overlap is what "this is my stack" means, and it is what
   * should sit at the top of Today's jobs.
   *
   * Two rules make it a COLLECTION test rather than a bag of keywords:
   *
   *  1. ANCHOR GATE. Nothing here pays out unless the JD names React or
   *     TypeScript (`anchors`). Every item below is only yours *in that
   *     context* — the bonus measures overlap with a React/TS stack, so with no
   *     React and no TS there is no stack to overlap with, and the bonus is 0
   *     no matter how many items matched.
   *
   *  2. GATED ITEMS. The shared-with-everyone half of the list — MongoDB,
   *     Postgres, Node/Express, Docker, AWS, Git, REST — is marked `gated` and
   *     counts only once an anchor is present. This is the explicit ask: a
   *     MongoDB mention must not lift a job unless React/TypeScript are there
   *     too. A Java+Mongo+AWS+Docker+Git backend post matches four items and
   *     still earns exactly nothing. (Mongo also remains in `backendPenalty`
   *     above — it earns a little back inside a React stack, and still costs a
   *     little as backend mass. Both are true of a MERN role.)
   *
   * Sizing: `free` items are covered by the tier score already and pay nothing;
   * past that each item is worth `perItem` points, capped at `max`. The cap is
   * deliberately smaller than one core skill (~23 points) — this REORDERS jobs
   * that already look right, it can't promote a job that doesn't.
   *
   * `max` is also HEADROOM, not a clamp: scoring.ts compresses the tier score
   * into 0…(100 - max) and the bonus fills the top band, so the scale still ends
   * at 100 and full stack overlap still tops out, without a pile-up of ties at
   * the clamp. Consequence: every score is ~12% lower than before this block
   * existed unless the JD earns the overlap back — the old "all-4-core → 87-93"
   * calibration now reads 77-82 with no stack, 89-94 with it, and the
   * filter.minScore / lowRankBelow thresholds sit that much higher in practice.
   */
  stackProfile: {
    enabled: true,
    /** No anchor in the JD ⇒ no bonus at all, whatever else matched. */
    anchors: ["react", "react.js", "reactjs", "react hooks", "typescript"],
    /** Items this many and below are already priced into the tier score. */
    free: 6,
    perItem: 1.5,
    max: 12,
    /**
     * Your stack, one entry per DISTINCT thing (spellings are aliases, not
     * separate items — "React"/"React.js"/"React Hooks" is one item, so a JD
     * repeating a name three ways gains nothing).
     */
    items: [
      { label: "React",           aliases: ["react", "react.js", "reactjs", "react hooks"] },
      { label: "TypeScript",      aliases: ["typescript"] },
      { label: "Next.js / SSR",   aliases: ["next.js", "nextjs", "next js", "server-side rendering", "server side rendering", "ssr"] },
      { label: "JavaScript",      aliases: ["javascript", "es6", "es2022", "ecmascript"] },
      { label: "Context API",     aliases: ["context api", "usecontext", "usestate", "useeffect"] },
      { label: "Redux / Zustand", aliases: ["redux", "redux toolkit", "rtk", "zustand", "jotai"] },
      { label: "TanStack Query",  aliases: ["tanstack", "react query", "react-query", "@tanstack", "swr"] },
      { label: "Tailwind CSS",    aliases: ["tailwind", "tailwindcss"] },
      { label: "Material UI",     aliases: ["material ui", "material-ui", "mui", "@mui"] },
      { label: "HTML5 / CSS3",    aliases: ["html", "html5", "css", "css3", "scss", "sass"] },
      { label: "Responsive web",  aliases: ["responsive web design", "responsive web development", "responsive design", "responsive", "mobile-first"] },
      { label: "Testing",         aliases: ["jest", "vitest", "playwright", "cypress", "react testing library", "testing library", "rtl"] },
      { label: "Vite / Webpack",  aliases: ["vite", "webpack"] },
      { label: "GraphQL",         aliases: ["graphql", "apollo"] },
      { label: "Vercel",          aliases: ["vercel", "netlify"] },
      { label: "AI coding tools", aliases: ["cursor", "claude code", "codex", "github copilot", "copilot", "windsurf"] },

      // ── AI-native application work ────────────────────────────────────────
      // This block only lists what YOU have actually built with — the same
      // honesty rule the résumé tailoring runs under. A stackProfile item is a
      // claim of overlap, so an item you can't back is a lie that ranks jobs.
      //
      // Deliberately NOT here: RAG, vector databases and embeddings. They are
      // the obvious neighbours of this work and they are not yours, so a JD
      // built around them must not read as "my stack".
      //
      // `langchain` is not an alias either, for the same reason but sharper: a
      // LangChain JD is a Python-ecosystem JD, and its ABSENCE is part of what
      // makes a role like this one a fit. It cannot also be a thing that pays.
      //
      // Ungated, but the anchor rule still governs the payout — an LLM JD with
      // no React and no TypeScript earns nothing from these.
      // No bare "claude" alias: aliasPresent() treats a following space as a
      // boundary, so it fires inside "Claude Code" and a JD that only names the
      // CODING TOOL would also collect the LLM-API item. "anthropic"/"claude
      // api" are unambiguous, and a JD that really integrates Claude says LLM,
      // GenAI or names OpenAI/Gemini alongside it anyway.
      { label: "LLM APIs",        aliases: ["openai", "anthropic", "claude api", "gemini", "llm", "llms", "large language model", "large language models", "vercel ai sdk", "ai sdk", "generative ai", "genai"] },
      { label: "Agents / tools",  aliases: ["ai agent", "ai agents", "agentic", "function calling", "tool calling", "structured output", "structured outputs", "mcp", "model context protocol", "ai workflow", "ai workflows"] },

      // ── gated: generic infrastructure, only yours next to React/TypeScript ──
      { label: "Git / GitHub",    aliases: ["git", "github", "gitlab"],                        gated: true },
      { label: "REST APIs",       aliases: ["rest api", "rest apis", "restful api", "restful apis", "restful", "rest"], gated: true },
      { label: "Node / Express",  aliases: ["node.js", "nodejs", "node", "express", "express.js", "expressjs"], gated: true },
      { label: "PostgreSQL",      aliases: ["postgresql", "postgres", "prisma", "drizzle"],    gated: true },
      { label: "MongoDB",         aliases: ["mongodb", "mongo", "mongoose"],                   gated: true },
      { label: "Docker",          aliases: ["docker"],                                         gated: true },
      { label: "AWS",             aliases: ["aws", "amazon web services"],                     gated: true },
    ] as { label: string; aliases: string[]; gated?: boolean }[],
  },

  /**
   * PENALTIES — how a bad signal costs a job POINTS instead of deleting it.
   *
   * This replaced the old drop-based shortlist (2026-08-01). Every rule below
   * used to be a `continue` in filter.ts: the job vanished from the dashboard
   * and the only trace was a line in the run log. That is the wrong trade — a
   * filter is a guess about a job we have only partly read, and a wrong guess is
   * invisible and permanent, while a wrong RANKING costs one line of scrolling.
   *
   * So: nothing is dropped. Each signal subtracts points from the 0-100 match %,
   * the reasons ride along on the row as chips, and weak jobs sink to the bottom
   * where the dashboard folds them behind "show low-ranked". You decide.
   *
   * Sizing: a penalty of ~40 moves a strong job (90) below a mediocre one (55) —
   * that is what "almost certainly not for you" should cost. ~20 reorders within
   * a band. Values are POINTS on the same 0-100 scale as the score.
   */
  penalties: {
    enabled: true,
    /** Title names a different discipline entirely (Vue/Android/QA/PM/…). */
    offTargetTitle: 45,
    /** Backend-leaning title with no frontend signal ("Node.js Developer"). */
    backendTitle: 30,
    /** Per year the REQUIRED minimum exceeds filter.maxRequiredYears… */
    perYearOver: 12,
    /** …capped here, so a "10+ yrs" post is heavy but not auto-zero. */
    maxYearsOver: 40,
    /** Top-of-ladder title (staff/principal/architect/head/VP) stating no years. */
    topTitleNoYears: 15,
    /**
     * Title advertises an INTERNSHIP / traineeship (see filter.internTitles).
     * The other end of the ladder from `topTitleNoYears`, and it needs its own
     * rule because nothing else catches it: "Frontend Developer Intern" classes
     * as `frontend` (multiplier 1.0), names React/TS/JS in the JD like any real
     * frontend role, states no years, and so scored 81 — top of the list for a
     * role that pays a stipend and is closed to a 3-4y candidate.
     *
     * Sized like `offTargetTitle` (45): an internship is as unapplicable as a
     * Vue job, not merely a weaker fit. That puts a JD-perfect internship at ~36
     * — under `lowRankBelow`, so it folds away rather than vanishing, and a
     * genuine mislabel is still one toggle from view.
     */
    internTitle: 45,
    /** JD names none of your core skills (React/TypeScript/JavaScript). */
    noCoreSkill: 20,
    /**
     * Staffing agency / job marketplace rather than the actual employer — see
     * `massRecruiters`. These posts hide the real company, are often stale, and
     * one applies into a database rather than to a team.
     */
    massRecruiter: 25,
    /**
     * Known FAKE / lead-harvesting posters — see `fakePosters`. Heavier than
     * `massRecruiter` (25): a staffing firm is at least advertising a real
     * requirement it holds, while these are postings that exist to collect
     * resumes and profile data for a role that is not open to you at all.
     * Sized at 60 so even a JD-perfect 100 lands at 40 — under `lowRankBelow`,
     * folded out of the default view but still one toggle away and still
     * showing the reason, exactly like every other penalty here.
     */
    fakePoster: 60,
    /**
     * Bulk posting. A company placing many roles in a single 2h window is
     * almost always a consultancy shotgunning a bench requirement. Free up to
     * `floodFrom` postings, then `floodPer` points each, capped at `floodMax`.
     */
    floodFrom: 3,
    floodPer: 6,
    floodMax: 20,
    /**
     * STALENESS. Free for `staleFreeDays`, then `stalePerWeek` points for every
     * further week since `postedAt`, capped at `staleMax`.
     *
     * This is the ranking half of the freshness answer — the ATS collector is
     * still right not to DELETE an old posting (a job absent from a company's
     * own API is closed, so anything present is open), but "open" and "worth
     * your morning" are different claims. Measured 2026-08-11: of 616 ATS rows,
     * 440 were over 30 days old and the day's #11 result at 92% was a TripSuite
     * req posted 1,488 days ago. Nothing in the score knew that.
     *
     * A 4-year-old req now loses the cap; a 3-week-old one loses 12; anything
     * inside two weeks is untouched. Jobs with no postedAt (LinkedIn guest cards
     * before the fix in pipeline.ts) are never penalised — unknown ≠ old.
     */
    staleFreeDays: 14,
    stalePerWeek: 4,
    staleMax: 35,
  },

  /**
   * Staffing firms, body-shops and job marketplaces. Matched against the company
   * name: `names` are exact-ish (whole-word substring), `patterns` catch the long
   * tail of "… Staffing Solutions" / "… Manpower Services" outfits.
   *
   * Add freely — a name here only costs `penalties.massRecruiter` points, so a
   * false positive sinks a job a little, it never deletes one.
   */
  massRecruiters: {
    names: [
      "hired", "cutshort", "instahyre", "hirist", "naukri", "iimjobs", "foundit", "monster",
      "randstad", "adecco", "manpowergroup", "teamlease", "quess", "kelly services",
      "michael page", "hays", "robert half", "antal", "abc consultants", "ciel hr",
      "korn ferry", "aon", "gi group", "careernet", "xpheno", "scaleneworks",
      "black turtle", "crescendo global", "vsquare", "talentxo", "uplers",
    ],
    patterns: [
      "staffing", "recruit", "recruitment", "manpower", "placement", "resourcing",
      "workforce", "talent solutions", "talent acquisition", "hr services",
      "hr solutions", "consultancy", "consultants", "outsourc", "job portal",
    ],
  },

  /**
   * FAKE POSTERS — companies whose listings are lead-collection, not hiring.
   *
   * Distinct from `massRecruiters`: those are real intermediaries for real
   * requirements. These republish, invent or perpetually re-run postings to
   * harvest candidate profiles, so the "company" on the row is not the employer
   * and often no such opening exists. Matched against the company name with the
   * same whole-word rule (`Flexiple` hits "Flexiple Technologies", not
   * "flexipleX"), and costing `penalties.fakePoster`.
   *
   * jobgether is also blocked at the SOURCE (ats.excludeSlugs) because it holds
   * its own ATS account and would otherwise swamp a run; the penalty here is the
   * backstop for the same outfit arriving via LinkedIn or Naukri, where we
   * cannot refuse to fetch it.
   */
  fakePosters: {
    names: [
      "flexiple",
      "jobgether",
      "hire feed",
      "hirefeed",
      "quick hire staffing",
      "quick hire",
      "rocksync",
    ],
  },

  /**
   * BLOCKED COMPANIES — a genuine, deliberate exception to "penalize, don't
   * drop" (see filter.ts header). These are real employers with real
   * postings; they're excluded because the user has decided they never want
   * to see them, not because a heuristic judged the posting low-quality.
   *
   * Applied earliest of any filter, in runPipeline (src/pipeline.ts) — before
   * triage, before the enrich budget is spent — so a blocked company costs
   * nothing beyond the initial listing fetch and never reaches the DB.
   * Matched against company name with the same whole-word rule as
   * massRecruiters/fakePosters (`Infosys` hits "Infosys Limited", not
   * "Infosysx"). Add freely; case-insensitive.
   */
  blockedCompanies: [
    "infosys",
  ],

  /**
   * Post-scoring ranking knobs. Nothing here DROPS a job any more (see
   * `penalties`); the thresholds decide how the dashboard sorts and folds.
   */
  filter: {
    enabled: true,
    /**
     * Drop anything scoring below this (after the tiered renormalization).
     * Sensitivity on the 2026-06-26 set: 50→5 jobs, 45→7, 40→12, 35→21, 30→29.
     * Set to 30 (not 40) on purpose: 40 is roughly "3 of the 4 core skills", so
     * a genuine 2-core React+TS role — the kind worth a look — fell off the list
     * with no trace. The list is ranked by score anyway, so a wider floor costs
     * scrolling, not attention. Raise for a tighter list.
     *
     * Re-pegged 30 → 35 after two scale changes that pull opposite ways:
     * `stackProfile` took the top 12 points (everything ~12% lower), and moving
     * Next.js out of core raised every React+TS JD that never named it (a bigger
     * effect). Net, the scale sits HIGHER. Measured over the 5,746 stored JDs:
     * the old floor of 30 admitted 1,647 rows; on the new scale 30 admits 1,809
     * and 35 admits 1,702 — so 35 is the number that keeps the floor where it
     * was calibrated.
     */
    minScore: 35,
    /**
     * Dashboard fold line, NOT a filter. Jobs scoring under this are collected,
     * stored and shown — just tucked behind a "show N low-ranked jobs" toggle at
     * the bottom of Today's jobs, with their penalty chips visible so you can see
     * why they sank. Raise it for a tighter default view.
     *
     * Re-pegged 40 → 45 for the same reason as `minScore` above, and measured
     * the same way: over the 5,746 stored JDs the old line kept 1,208 jobs above
     * the fold; on the new scale 40 keeps 1,489 and 45 keeps 1,250 — so 45
     * leaves the default view the size it was calibrated to be.
     */
    lowRankBelow: 45,
    /**
     * Drop if the role's REQUIRED MINIMUM experience is at least this many
     * years. You target 3-4y, so 5 means "needs ≥5y to even apply" → out.
     * Bands that bracket you ("3-8", "2-7", "4-9") have a min < 5 → kept.
     */
    maxRequiredYears: 5,
    /**
     * Last-resort guard for TOP-OF-LADDER titles only (staff / principal /
     * architect / head of / director / VP) that state no years anywhere in the
     * JD. Such a role is dropped only if it ALSO scores under this; above it,
     * it is kept and merely marked `stretch`.
     *
     * "Senior" / "Sr" / "Lead" are NOT in that set: in the Indian market they
     * are routinely 3-4y postings, and dropping on the word alone was throwing
     * away applicable jobs. They are now judged purely on stated years.
     * Set to 101 to disable this rule entirely, 0 to make it always drop.
     */
    seniorTitleKeepScore: 55,
    /**
     * Titles that are always off-target regardless of keyword bleed. Matched
     * case-insensitively as substrings (spaces/dots/hyphens normalized first).
     */
    rejectTitles: [
      // Competing frontend frameworks.
      // "angular" is deliberately NOT here: Angular shops routinely post
      // "Angular / React Developer" and migration roles, and dropping on the
      // title alone cost real matches. It now only costs score (the JD has to
      // earn its 40 on React/Next/TS like everything else).
      "vue", "svelte", "ember",
      // Definitively-mobile platforms (React Native is NOT here — it's a keep)
      "android", "ios", "flutter",
      // Stacks / platforms
      "\\.net", "asp.net", "php", "laravel", "c++", "c#", "golang", "go developer",
      "rust", "qt", "qml", "embedded",
      "wordpress", "drupal", "shopify", "salesforce", "servicenow", "sap", "sharepoint",
      // Ops / quality / non-engineering
      // "test"/"testing" are separate patterns from "tester": patternPresent is
      // word-bounded, so "tester" does NOT match "Software Engineer - Test" (which
      // was scoring 35% on a frontend search) nor "Manual Testing Engineer".
      "devops", "sre", "site reliability", "qa", "sdet", "tester", "test", "testing",
      "quality assurance", "quality engineer", "automation engineer",
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
     * Internship / traineeship markers, matched as whole tokens in the TITLE
     * only. Deliberately not read from the JD: descriptions say "our internship
     * programme" / "interns work alongside…" in plenty of full-time postings,
     * and the title is where a company actually declares the rung.
     *
     * "fresher" and "graduate" are NOT here — in the Indian market they show up
     * on real salaried junior openings; only the intern/trainee/apprentice
     * family means "not a permanent role".
     */
    internTitles: [
      "intern", "interns", "internship", "summer intern", "winter intern",
      "trainee", "traineeship", "apprentice", "apprenticeship", "co-op",
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
     * Time window per run. The scheduler fires every `intervalMinutes`, so a 2h
     * window is a deliberate overlap buffer that guarantees nothing slips between
     * runs; the DB dedupe on external_id collapses the overlap. Kept at 2h even at
     * the 30-min cadence: LinkedIn's guest `f_TPR` is coarse and a card can surface
     * late, so the buffer is what makes a missed posting impossible rather than
     * unlikely.
     */
    windowHours: 2,
    /** Listing pages per keyword per city. Kept low — sortBy=DD puts fresh on top. */
    pages: 2,
    /**
     * Local-clock window the scheduler is allowed to auto-run, inclusive on both
     * ends, as "HH:MM" on the half-hour grid. "09:30"–"21:00" with
     * `intervalMinutes: 30` = 24 runs/day at 9:30, 10:00, 10:30 … 21:00.
     * A manual "Run all cities now" ignores this window entirely.
     */
    activeWindow: { start: "09:30", end: "21:00" } as { start: string; end: string },
    /**
     * Auto-run cadence in minutes. Must divide 60 (the scheduler walks the
     * top-of-hour grid: :00, :30 for 30). Halving this from 60 → 30 doubles the
     * listing fetches but NOT the enrich cost: `skipSeenHours` below means a card
     * the previous run already judged is reused from cache, so the extra runs pay
     * only for cards that are genuinely new since 30 minutes ago.
     */
    intervalMinutes: 30,
    /**
     * Don't re-enrich a card we already JUDGED this recently (see `seen_cards`
     * in db.ts). The scheduler fires every 30 min over a 2h window, so most of each
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
   * THE HOT CHECKER — a small, fast LinkedIn poll that runs between the wide
   * sweeps (src/hot.ts, armed by the dashboard).
   *
   * WHY IT IS NOT "the sweep, more often": a full sweep is 8 terms × 10 cities ×
   * 2-3 pages ≈ 170 listing requests at 2.5-5s each, so it takes ~16-19 min
   * (measured over 116 auto runs) inside a 30-min slot. There is no room to run
   * it more often, and no reason to: the guest API returns ~3 frontend jobs per
   * hour per query for Bengaluru, so a tighter cadence re-downloads the same
   * cards. What a tighter cadence CAN buy is LATENCY — noticing a posting ~1
   * minute after it appears instead of 30.
   *
   * So this runs ONE query (the tuned pure-title boolean net, measured at 100%
   * title precision) against the NATIONAL geo, one page, over a 30-min window.
   * Cost, MEASURED over 40 ticks on 2026-08-19: TWO requests and ~7.8s for a
   * tick that finds nothing, ~30s when it does enrich. (This used to claim "~8
   * requests"; that dates from when the net was 8 separate terms and was the
   * reason the cadence looked more expensive than it is.) `seen_cards` means
   * almost every card is already judged, so a typical tick enriches nothing.
   *
   * SAFETY: it shares CONFIG.http.gates["linkedin.com"] with the sweep, so the
   * two loops together still emit one request every 2.5-5s — LinkedIn sees no
   * more traffic than it does today. The hot tick just uses priority 0 to jump
   * the sweep's queue, which is what keeps it fast while costing the sweep only
   * ~30s per tick.
   */
  hot: {
    enabled: true,
    /**
     * Cadence. Fires on the wall-clock grid like the other schedulers.
     *
     * 5 → 2 (2026-08-19), on measurement: an empty tick is TWO requests and 7.8s
     * (40-tick sample), not the "~8 requests" the header above used to claim —
     * that figure predates the collapse of the priority net to a single boolean
     * query. Whole-day share of the LinkedIn gate: hot ~370 requests, wide sweep
     * ~8,900. Going to 2 minutes adds ~500 requests/day against a ~13,400/day
     * ceiling, i.e. hot moves from ~4% of the budget to ~6%.
     *
     * The expensive half — fetching JDs — does NOT scale with cadence: the same
     * new jobs get enriched either way, just sooner. Only the listing request
     * repeats, which is why this is nearly free.
     *
     * Average detection latency: ~2.5 min → ~1 min. NOT verified end-to-end:
     * LinkedIn's own posting→indexed delay is unknown (guest cards carry no
     * timestamp — 0 of 924 rows today had `posted_at`), so if that delay is
     * minutes, this gain is real but small beside it. Polling cannot beat the
     * source.
     */
    intervalMinutes: 2,
    /**
     * Search window per tick, in MINUTES (f_TPR = this × 60). Was sized at 6× the
     * interval; kept at 30 when the interval dropped to 2 (now 15×) because the
     * overlap is what makes a missed posting impossible rather than unlikely,
     * and it is FREE — the window is a query parameter, not a request count, and
     * re-seen cards are skipped by seen_cards without an HTTP call. The wider
     * ratio also covers the real gap in the record: process sleep. Three
     * laptop-sleep gaps on 2026-08-19 (35, 68 and 97 minutes) killed more ticks
     * than any cadence change can win back.
     */
    windowMinutes: 30,
    pages: 1,
    /** null = use `linkedinPriorityTerms` (the tuned pure-title net). */
    terms: null as string[] | null,
    /**
     * National geo only. Label is literally "India" so the dashboard's
     * VAGUE_SEARCH_LABELS already strips it and jobs show their own city
     * instead of "India (other)". The national sweep is also the one query
     * proven to reach sub-city entities ("Pune Division", "Bengaluru East")
     * that the per-city geoIds cannot.
     */
    location: { label: "India", geoId: "102713980" },
    /**
     * Hard ceiling on JD fetches per tick. A tick that finds many unseen cards
     * (first run of the day, or after a restart) would otherwise run for
     * minutes and collide with the next tick. Anything past the cap is left for
     * the wide sweep, which has the budget for it.
     */
    maxEnrichPerTick: 12,
    /**
     * Local-clock window, like collect.activeWindow. Wider: ticks are cheap.
     * null = run around the clock.
     *
     * >>> TEMPORARY, 2026-08-19 night only. Normal value is the commented line
     * >>> below — put it back to restore the 09:00-23:00 window.
     */
    // activeWindow: { start: "09:00", end: "23:00" } as { start: string; end: string } | null,
    activeWindow: null as { start: string; end: string } | null,
    /** Ticks kept in memory for the dashboard's /api/hot panel. */
    historySize: 40,
  },

  /**
   * NAUKRI HOT CHECKER (src/naukri-hot.ts) — the same idea as `hot` above, but
   * for Naukri instead of LinkedIn. Structurally simpler than the LinkedIn one:
   * Naukri cards carry a REAL `createdDate` timestamp and the full JD inline,
   * so there is no enrich step and no "posted_at is unknown" uncertainty — a
   * narrow `sort=f` + client-side time cut (see src/naukri-cards.ts) IS the
   * latency win, not a proxy for one.
   *
   * Query-term tuning was tested and abandoned (2026-08-22): `-java -python
   * -.net` exclusion syntax in `keyword` doesn't work — Naukri's guest API
   * doesn't parse it as NOT, it tokenizes the minus-prefixed words as
   * additional OR terms, so excluding backend stacks actually pulled in MORE
   * of them. Multi-word/quoted phrases (`react.js`, `frontend developer`)
   * returned literally 0 results — too narrow, not too sharp. `react` alone
   * and `react developer` scored the same ~20-30% on-target precision at
   * matched sample sizes; no query variant beats the noise floor. So this
   * reuses `linkedinSearchTerms` (bare title terms) and leans entirely on the
   * existing client-side scoring/filter pipeline to zero out the noise —
   * which it already does correctly regardless of query wording.
   */
  naukriHot: {
    enabled: true,
    /** Fires on the wall-clock grid like the other schedulers. */
    intervalMinutes: 5,
    /**
     * Search window per tick, in MINUTES. Wider than the interval on purpose
     * (like `hot.windowMinutes`) so overlap makes a missed posting impossible
     * rather than unlikely — re-seen cards cost nothing (seen_cards skips
     * them without a request), only the genuinely new ones do any work.
     */
    windowMinutes: 15,
    pages: 2,
    /** null = reuse CONFIG.linkedinSearchTerms (same terms the wide Naukri collector uses). */
    terms: null as string[] | null,
    /**
     * Locations polled each tick. Naukri's `location` param takes "India" as
     * a real nationwide search (used the same way by the wide collector), so
     * one query covers every city instead of iterating each one.
     *
     * UNLIKE LinkedIn, "India" does NOT also cover remote postings — verified
     * 2026-08-22: `location=India` and `location=Remote` return completely
     * disjoint pools (0 overlap on a 24h "react" sample). On LinkedIn the
     * national geoId doubles as the remote query (same geoId as the dedicated
     * "Remote (India)" entry, just without the f_WT=2 filter), so one query
     * covers both there. Naukri has no such shortcut — "Remote" must be
     * polled as its own bucket or that pool is invisible to this checker.
     */
    locations: ["India", "Remote"] as string[],
    /** Local-clock window, like hot.activeWindow. null = run around the clock. */
    activeWindow: null as { start: string; end: string } | null,
    /** Ticks kept in memory for the dashboard's /api/naukri-hot panel. */
    historySize: 40,
  },

  /**
   * Desktop alerts for the scheduler (macOS only; see src/notify.ts). Banner via
   * `osascript`, sound via `afplay` on a stock /System/Library/Sounds name —
   * Basso, Blow, Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr,
   * Sosumi, Submarine, Tink. Set `sound: ""` for a silent banner.
   */
  notify: {
    enabled: true,
    sound: "Glass",
    /**
     * Minimum genuinely-NEW jobs (DB inserts, not the day's running shortlist)
     * before a done-alert fires. The scheduler runs every 30 min from 09:30 to
     * 21:00, and most of those runs re-see jobs you've already been shown, so
     * alerting on every completion is 24 banners/day of mostly nothing — which
     * is how you learn to ignore the one that matters. Set 0 to alert on every
     * finished run regardless.
     */
    minNewJobs: 1,
    /** Also alert when a run throws (a silently dead collector looks like "no jobs today"). */
    onError: true,
    errorSound: "Basso",
    /**
     * INSTANT per-job alert threshold. A newly-discovered job scoring at least
     * this much fires its own banner the moment it is scored, without waiting
     * for the run to finish (see notifyHotJob).
     *
     * Only ever fires for genuinely new DB rows, so the ceiling on banners is
     * "how many strong jobs India posted today" — in practice a handful. Raise
     * to 80 if even that is too much; the run-level summary still covers the rest.
     */
    hotScore: 70,
    /** Distinct from the run-summary sound, so a real match is audibly different. */
    hotSound: "Hero",
  },

  /**
   * Guest cards carry no description, so a card's title-only score is useless
   * for deciding *which* jobs to enrich (every card scores ~0-10%). So we
   * enrich the LinkedIn set UP FRONT — fetching each detail page for the full
   * JD (+ salary) — then score once on real text. `maxEnrich` caps the number
   * of polite detail fetches per run.
   */
  // 90, not 60: this cap is a SILENT dropper — anything past it keeps an empty
  // JD, scores 0 and dies at minScore with no reason shown. Widening the filters
  // (angular kept, minScore 30) sends more candidates here, so the budget grew
  // with them. Watch for the "need a JD > enrich cap" NOTE in the run log; if it
  // fires regularly, raise this rather than assuming the scorer is at fault.
  linkedinEnrich: { enabled: true, maxEnrich: 90 },

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

  /**
   * ATS DISCOVERY + POLLING — the two-loop system.
   *
   * Measured 2026-08-11. LinkedIn/Naukri show you jobs that reached a job board.
   * Greenhouse/Lever/Ashby/Workday are the company's OWN board, and each exposes
   * an unauthenticated JSON endpoint that IS that board — not a mirror of it.
   * Newest rows observed: Razorpay 1.3h, Binance 1.9h, GitLab 3.9h. There is no
   * indexing step, so latency == our poll interval, nothing more.
   *
   * The catch that shapes this whole design: NONE of them has a global search or
   * sitemap (job-boards.greenhouse.io/sitemap.xml → 404, jobs.lever.co → 404,
   * jobs.ashbyhq.com → SPA shell, my.greenhouse.io → 406 sign-in). Every endpoint
   * requires a company slug you ALREADY have. So discovery and polling are two
   * separate loops running at completely different speeds:
   *
   *   SLOW (weekly)  Brave dorks → harvest SLUGS → data/companies.json
   *   FAST (hourly)  poll every known slug's API → jobs
   *
   * Why Google staleness doesn't poison this: 14 of 15 postings the dorks
   * returned were already DEAD (and Greenhouse hides that — a closed job 301s to
   * the company board with ?error=true, HTTP 200; Ashby serves an empty
   * <title>Jobs</title> shell). We therefore throw the POSTING away and keep only
   * the slug. A company indexed 8 months ago is still a company today.
   */
  ats: {
    discovery: {
      enabled: true,
      /**
       * Brave: $5/mo of free credit that REFILLS = ~1,000 req/month, 20 results
       * per page. The weekly matrix below costs ~640 req, so the recurring loop
       * is permanently free. Serper (2,500 one-time, no card) is the better
       * first-run driver — it returns 100 results in ONE call, and depth is where
       * the long-tail companies live. Set SERPER_API_KEY to use it.
       */
      provider: "brave" as "brave" | "serper",
      /** Brave caps `count` at 20 and `offset` at 9 (→ 200 results max/query). */
      pagesPerQuery: 3,
      /**
       * HARD request budget per run — the guard that stops one command from
       * eating a whole month of free credit. The full matrix below is
       * 6 hosts × 4 titles × 8 geos = 192 queries; at 3 pages each that is 576
       * requests against Brave's ~1,000/month. Deliberately budgeted at 300 so a
       * weekly cron fits comfortably (4 × 300 = 1,200 — and the 24h response
       * cache absorbs re-runs, so real usage lands well under that).
       *
       * Queries are consumed in matrix order, so raise this rather than trimming
       * the matrix when you want more coverage; unspent queries simply run next
       * time (they are shuffled per-run so the tail is not permanently starved).
       *
       * Set to 576 = the FULL matrix (192 queries × 3 pages) for the first deep
       * harvest. Drop back to ~300 for the weekly cron once the registry is
       * seeded, or the month's credit runs out mid-month.
       */
      maxRequests: 576,
      /**
       * Deliberately NOT all location-qualified. `site:jobs.ashbyhq.com "React"`
       * unqualified surfaced Tempo and Handshake, whose India roles Google never
       * associated with the word "India". We are harvesting COMPANIES, not jobs —
       * a US-only search result is still a valid slug whose board we then poll
       * for India roles directly.
       */
      titles: ["Frontend Engineer", "Frontend Developer", "React", "Next.js"],
      geos: ["India", "Bangalore", "Bengaluru", "Hyderabad", "Pune", "Gurgaon", "Remote", ""],
      hosts: [
        "job-boards.greenhouse.io",
        "job-boards.eu.greenhouse.io", // separate host; CurrenciesDirect surfaced only here
        "boards.greenhouse.io",        // legacy, 301s — but Google's index still holds slugs
        "jobs.lever.co",
        "jobs.ashbyhq.com",
        "myworkdayjobs.com",
      ],
      /** Slug registry. Grows, never shrinks — a closed board costs one 404/run. */
      registry: "./data/companies.json",
    },
    poll: {
      /**
       * MASTER SWITCH for the dashboard's background ATS timer (startAtsScheduler
       * in src/dashboard.ts). OFF: no ATS polling happens on its own.
       *
       * This only silences the automatic tick. `npm run ats` still runs the full
       * collection on demand, and the LinkedIn/Naukri auto-collector is a
       * separate timer that is unaffected.
       *
       * Previously the timer was armed off `ats.discovery.enabled`, which is the
       * wrong knob — discovery is the weekly SERP harvest that FINDS boards,
       * polling is what reads them — so there was no way to stop the polling
       * without also disabling harvesting.
       */
      enabled: false,
      greenhouse: { enabled: true, maxPages: 1 } as SourceToggle,
      lever: { enabled: true, maxPages: 1 } as SourceToggle,
      ashby: { enabled: true, maxPages: 1 } as SourceToggle,
      workday: { enabled: true, maxPages: 2 } as SourceToggle,
      /**
       * These boards are the company's ENTIRE org — Binance returns 298 postings,
       * jobgether 3,766. Almost all are irrelevant (finance, sales, backend, other
       * continents), so we cut to title+India BEFORE anything expensive runs. The
       * JD already ships inline in every one of these APIs, so unlike LinkedIn
       * there is no per-job enrich request to budget for.
       */
      /**
       * Age cut, in hours. 0 = OFF, and off is correct here — this is the one
       * knob that must NOT be copied from the LinkedIn/Naukri config.
       *
       * On a job board, an old posting is usually a dead or recycled one, so
       * freshness windows are how we avoid junk. On a company's OWN ATS the
       * opposite holds: a closed job is DELETED from the response, so anything
       * still in it is by definition still open, and age only tells you how long
       * they have been struggling to fill it.
       *
       * Measured across the 92-company seed registry (2026-08-11): 6,697
       * postings → 279 on title → 64 on India/remote. A 168h window cut those
       * 64 down to TWO. The distribution of the 64: >3mo 34, 7-30d 16, 1-3mo 12,
       * ≤7d 2. Filtering on age here deletes 97% of genuinely open roles.
       *
       * Age is still carried on every job (`postedAt`) so the dashboard can rank
       * and display it — it is a ranking signal, never a gate.
       */
      maxAgeHours: 0,
      indiaOnly: true,
      /**
       * A remote role that names NO country — bare "Remote", or Workday's empty
       * location — must name India (or IST) somewhere in its JD body to be kept.
       *
       * Measured 2026-08-11 on the day's 616 ATS rows: 279 of them stated no
       * location, every one was a US/LATAM/EU role, and ZERO of the 279
       * mentioned India anywhere in the JD. They were the single biggest source
       * of "why is this list full of remote US jobs". Requiring evidence costs
       * nothing measurable and deletes the entire class.
       *
       * Set false to go back to keeping unqualified remote roles on the theory
       * that some of them are secretly open to India.
       */
      requireIndiaEvidence: true,
      /**
       * ROTATING SLICE. The dashboard fires an ATS tick every `intervalMinutes`,
       * but a tick does NOT poll the whole registry — it polls only the boards
       * whose `lastPolledAt` is older than `refreshMinutes`, up to
       * `maxBoardsPerTick`. Every board still gets checked once an hour.
       *
       * Why not all 930 every 15 min: that is ~89,000 requests/day against free
       * first-party APIs, which is how you get blocked, and it buys nothing —
       * these postings stay open for WEEKS (measured age distribution of the 64
       * live India roles in the seed registry: >3mo 34, 7-30d 16, 1-3mo 12,
       * ≤7d 2). Rotating keeps load flat at ~1/4 of the registry per tick while
       * still surfacing a new posting within ~15 min of a tick reaching its board.
       *
       * Runs INDEPENDENTLY of the LinkedIn/Naukri collector — separate timer,
       * separate in-flight lock, different target hosts — so the two never block
       * each other (see startAtsScheduler in src/dashboard.ts).
       */
      intervalMinutes: 15,
      refreshMinutes: 60,
      maxBoardsPerTick: 300,
      /**
       * No active window: unlike the scraped sources there is no bot-detection
       * risk or human-hours pretence to maintain, and a board that opens a role
       * at 3am should be in the list at 9am.
       */
      activeWindow: null as { start: string; end: string } | null,
      /**
       * Slugs to never poll. These are RESELLERS, not employers: they hold an
       * ATS account and republish other companies' listings, so every row is
       * second-hand and the company name on it is wrong. jobgether alone is
       * 3,766 postings, all stamped "India, India", and it swamped every other
       * source in the first run (16 of 18 results). Same class of thing as
       * beBee — see README.
       */
      excludeSlugs: ["jobgether", "smart-working-solutions", "insiderone"],
    },
    endpoints: {
      /**
       * ONE host for every Greenhouse board, including the EU ones. There is no
       * `boards-api.eu.greenhouse.io` — it does not resolve (measured: DNS
       * failure, not a 404). The EU split exists only on the public frontend:
       * `job-boards.eu.greenhouse.io/currenciesdirect` renders in the EU while
       * its data comes back from this same US API host, which returns the EU
       * `absolute_url` in the payload. Registry `region` therefore records where
       * we FOUND the board, and never routes the request.
       */
      greenhouse: "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true",
      lever: "https://api.lever.co/v0/postings/{slug}?mode=json",
      ashby: "https://api.ashbyhq.com/posting-api/job-board/{slug}",
      /** POST. {tenant}/{wd}/{site} all come from the harvested URL. */
      workday: "https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs",
    },
  },

  /** Polite scraping knobs. */
  http: {
    minDelayMs: 2500,
    maxDelayMs: 5000,
    maxRetries: 4,
    backoffBaseMs: 1500,
    timeoutMs: 20000,
    cacheTtlMinutes: 30,
    /**
     * PER-HOST REQUEST GATE (see the gate section in src/http.ts).
     *
     * `minDelayMs`/`maxDelayMs` above space out requests WITHIN one call chain.
     * That is enough while a single loop runs, but not when two loops share a
     * host: each keeps its own promise and the host sees double the rate, with
     * requests landing simultaneously. A host listed here instead gets ONE
     * process-wide queue releasing a request every minGap-maxGap ms, no matter
     * how many loops are feeding it.
     *
     * Only LinkedIn is listed because it is the only host more than one loop
     * targets (the wide sweep + the hot checker). Naukri, AmbitionBox and the
     * ATS boards are each driven by exactly one loop and keep the per-call
     * delay; gating the ATS boards would be actively harmful, since that
     * collector deliberately runs 6-wide against first-party JSON APIs and
     * finishes 400 companies in ~2 min (see src/sources/ats.ts).
     *
     * The numbers match the old per-call delay on purpose: this is a
     * re-plumbing, not a slowdown. LinkedIn sees exactly what it saw before.
     *
     * `www.naukri.com` joined 2026-08-22 when the Naukri hot checker
     * (src/naukri-hot.ts) became a second loop hitting Naukri alongside the
     * wide collector — same reasoning as LinkedIn, same numbers as Naukri's
     * old per-call delay (this re-plumbs, doesn't add traffic).
     */
    gates: {
      "linkedin.com": { minGapMs: 2500, maxGapMs: 5000 },
      "www.naukri.com": { minGapMs: 2500, maxGapMs: 5000 },
    } as Record<string, { minGapMs: number; maxGapMs: number }>,
    /**
     * Circuit breaker. On a 429/403 from a gated host, EVERY loop's requests to
     * it pause this long. 10 min is chosen to be longer than one hot-checker
     * interval, so a block quiets the fast loop rather than letting it retry
     * into the block — the retry ladder alone would keep knocking.
     */
    blockCooldownMs: 600_000,
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

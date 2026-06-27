You are helping me build a personal, local-first job-hunting automation tool. I am a frontend engineer (4+ years, React/Next.js/TypeScript), currently job-hunting on a zero budget — no paid scraping services (Apify etc.) and no LinkedIn Premium. I will run this on my own laptop. Treat me as a competent JS/TS developer.

## What I want, ultimately
A tool I run each morning that:
1. Pulls jobs posted in the LAST 24 HOURS for my target titles/keywords from LinkedIn and Naukri (India + Remote), plus free no-block job APIs as supplementary sources.
2. Scores each posting against my résumé keywords and outputs matched keywords, unmatched keywords, and a match % (0–100), like an ATS in reverse.
3. Dedupes, ranks by match score, and writes a CSV (including any other details such as package LPA)
4. Tracks what I've seen/applied to in a local CSV/SQLite so each run only shows genuinely NEW jobs.


## CRITICAL: do this BEFORE writing any code
The hard part here is NOT the timeframe filtering (that's just a URL param the platforms apply server-side: LinkedIn `f_TPR=r86400`, Naukri `freshness=1`). The hard part is NOT getting blocked. So your FIRST task is research, not code.

Research (use web search / fetch docs) and then write me a short plan covering:
- LinkedIn's public **logged-out guest** job endpoint (`/jobs-guest/jobs/api/seeMoreJobPostings/search`): current behavior, response format, pagination, realistic rate limits, and known anti-bot triggers in 2026.
- Naukri's current anti-bot posture: whether its public listing API/endpoints are reachable without login, how aggressively it blocks **datacenter vs residential IPs**, and whether a locally-run script from my home IP is viable.
- Free job APIs that are explicitly OK to hit (e.g. RemoteOK, Remotive, Arbeitnow) as reliable supplementary sources.
- Polite/safe scraping practice: request pacing, randomized human-like delays, realistic + rotating User-Agent and headers, exponential backoff with jitter on 429/403, response caching, and keeping daily volume low.

Then present:
(a) A recommended architecture — which sources are safe to automate, which should be **local-only** (run from my residential IP), and which I should instead consume via the platform's **free email job alerts** rather than scrape at all.
(b) A clear, honest list of the RISKS (below), with how your design mitigates each.
(c) A proposed file/module layout.

STOP after this and wait for my approval before implementing.

## Risks you must surface and respect (do not gloss over these)
- **Terms of Service:** LinkedIn and Naukri both prohibit scraping. Use ONLY public logged-out/guest endpoints and free APIs. NEVER log in with my LinkedIn/Naukri account to scrape — I do not want my real accounts flagged or banned. Make this an absolute rule in the code.
- **IP blocking / CAPTCHA:** likely on Naukri from datacenter IPs; possible on LinkedIn if volume is high. Design for low volume (a few requests, once a day), single concurrency, polite delays, and graceful per-source failure (if one source blocks, the rest still work and the run doesn't crash).
- **Legal/ethical gray area:** personal, low-volume, logged-out use is lower-risk but not zero. Note this honestly; don't pretend it's fully sanctioned.
- **Privacy:** do NOT scrape or store recruiters' personal contact data. For outreach, the tool only surfaces the public "posted by"/company info; finding an email is a manual step I do via free tools (document the process in the README — Apollo free Chrome extension, Hunter free tier, email-pattern guessing + a free verifier). Keep humans in the loop.
- **Brittleness:** these endpoints/HTML change without notice. Build defensively, validate responses, fail loudly with clear logs, and keep selectors/params in one config file so they're easy to fix.

## My profile (use as the default config)
- Target titles: Frontend Engineer, Frontend Developer, React Developer, Next.js Developer, UI Engineer, Software Engineer (Frontend), Full Stack Developer (React) (More according to @my-resume.md)
- Locations: India, Remote
- Experience band to favor: 3-5 years; flag senior/staff (6+ yrs) as "stretch"
- Résumé keywords for scoring (with aliases):
  React (ReactJS, React.js), Next.js (NextJS), TypeScript (TS), JavaScript (JS),
  Redux (Context API, RSC), TailwindCSS (Tailwind, SASS, SCSS), Node.js (Node),
  PostgreSQL (Postgres, SQL), Testing (Jest, Cypress, Playwright, Unit Testing),
  Core Web Vitals (performance, SEO), REST APIs (REST, OAuth, JWT, Web API),
  CI/CD (Jenkins, GitHub Actions, Docker, Webpack), System design (Microservices, Agile),
  AI Engineering (RAG, LLM, multi-agent, prompt engineering)
- Also: read my résumé from `@my-resume.md` and extend the keyword set from it
- only use keywords which are in high demand in 2026 for frontend-focused engineering

## Technical preferences
- Config-driven: a single `config.ts`/`config.json` for titles, keywords, locations, sources, freshness.
- Local-first: a `npm run daily` command. Provide instructions for a local daily schedule (cron on Linux/mac, or launchd/Task Scheduler).
- Output: timestamped CSV in `./output/`, ranked by match %. Optional Gmail email of the top N.
- A clean `README.md`: setup, run, schedule, the manual email-finding workflow, troubleshooting blocks, and how to update selectors/params when a source breaks.

## Process
1. Research + plan + risks (then WAIT for my approval).
2. After approval, scaffold the project and implement ONE source end-to-end first (start with a free no-block API to prove the scoring + CSV pipeline), test it, show me output.
3. Then add LinkedIn guest, then Naukri (local-only), each with the safety measures, testing after each.
4. Finally the dedupe/tracker.
Build incrementally and let me review at each step.
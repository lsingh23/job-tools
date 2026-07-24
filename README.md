# job-tools — local-first daily job hunter

A zero-budget tool you run each morning. It pulls **last-24h** frontend/full-stack
roles from public, logged-out sources, scores each posting against your résumé
keywords (reverse-ATS), dedupes, and writes a ranked CSV of only the **new** jobs
since your last run.

> **No paid services. No LinkedIn/Naukri login — ever.** Only public logged-out
> endpoints and free APIs. This is personal, low-volume use; see **Risks**.

---

## What it does

1. Fetches jobs from enabled sources (see **Sources**).
2. Scores each against a tiered, 2026-market-validated keyword set → `matched`,
   `unmatched`, and a `0–100` match %.
3. Dedupes cross-posts (same role reposted across pages/locations/sources).
4. Filters out jobs you've already seen (local SQLite tracker).
5. Writes a timestamped, ranked CSV to `./output/`.

---

## Setup

Requires **Node 18+** (tested on Node 22).

```bash
npm install      # installs tsx, cheerio, better-sqlite3
npm run daily    # run it
```

Other commands:

```bash
npm run daily:dry                       # run sources + score + preview, no CSV/tracker write
npm run applied -- linkedin:4282211964  # mark a job applied (id = last CSV column)
npm run typecheck                       # tsc --noEmit
```

### Dashboard (local UI)

A minimal, zero-dependency web UI to run searches and browse the ranked CSVs:

```bash
npm run dashboard            # → http://localhost:5173  (PORT=xxxx to change)
```

One page (Tailwind via CDN): pick a city, a freshness window and pages/keyword,
then **Search LinkedIn** or **Search Naukri**. Both drive `src/search.ts` and the
same pipeline (prefilter → enrich → score → TF-IDF → dedupe → experience filter →
salary → presence), stream progress live, render the ranked results, and write a
CSV to `./output/`. Past searches are browsable from the dropdown below. Searches
are single-flight (it won't launch a second scrape while one is in progress).

The two sources differ in what they answer natively, so a couple of controls are
platform-specific:

| Control | LinkedIn | Naukri |
| --- | --- | --- |
| City | `geoId` (or `location=` text) | `location=` |
| Time window | server-side, exact (`f_TPR=r<sec>`) | server-side in **days** (`jobAge`), narrowed to the hour client-side off `createdDate` |
| Experience | `f_E` levels | `experience=<years>` (server-side band bracket) |
| Under X applicants | `f_SB2` | **n/a** — Naukri never discloses applicant counts |
| Salary / JD | needs a per-job detail fetch | inline in the search response (no enrich step) |

Because Naukri's `sort=f` is newest-first, an hours window stops paging a keyword
at the first card past the cutoff instead of walking a full day of results.

> The old **Daily Run** tab (`npm run daily` on a schedule, over all sources) is
> gone from the UI. The CLI entry point (`src/index.ts`) still exists.

### Today (multi-city hourly collector → Neon)

The top of the dashboard shows **Today's jobs** — the day's LinkedIn results across
**all** target cities (Bengaluru, Hyderabad, Pune, Mumbai, Delhi, Chennai, Remote-India),
persisted in **Neon Postgres** (`DATABASE_URL` in `.env`) so it **survives a refresh**
and **accumulates through the day**.

- **Automatic:** while `npm run dashboard` is running, an in-process scheduler runs a
  full multi-city collection **every hour between 10am–7pm** (local time, `CONFIG.collect.activeHours`).
- **Manual:** the **Run all cities now** button (or `npm run collect`) triggers one immediately.
- **Dedupe/accumulate:** results upsert by `external_id`. A repeat sighting refreshes
  `last_seen_at` and **unions the cities** it appeared under — it never duplicates a row,
  so each hourly run adds only the genuinely new postings to the same day's set.

```bash
npm run collect                                   # all cities, config defaults (2h window, 2 pages)
npm run collect -- --hours 6 --pages 3 --trigger manual
```

Efficiency: cards are fetched per city first, then the **union is deduped and the expensive
pipeline (enrich + salary + presence) runs once** — a job cross-listed in 3 cities is enriched
once, not three times.

**Neon schema** (auto-created on first `npm run dashboard` / `collect`):
- `jobs` — one row per posting for the day, keyed by `external_id`; carries the full scored
  record plus `cities text[]`, `first_seen_at`, `last_seen_at`, `run_date`.
- `runs` — one row per collection (`trigger` = `auto`/`manual`) with fetched/final/new counts,
  status and any error, so the dashboard's status strip and the scheduler are auditable.

> `DATABASE_URL` must be present — that's why `npm run dashboard`/`collect` use `node --env-file=.env`.
> If Neon is unreachable, the single-search + CSV browser still work; only the Today view and the
> hourly collector are disabled (with a console warning).

#### LinkedIn search hacks (in `CONFIG.linkedinParams`)

Applied in `src/pipeline.ts` `buildUrl()` — one place to tune result quality/freshness:

| Param | Value | Why |
| --- | --- | --- |
| `sortBy` | `DD` | Date-descending (freshest first). The guest endpoint defaults to *relevance*; for hourly collection we want the newest cards on top so each run surfaces genuinely new postings. |
| `f_AL` | `true` | **Actively Hiring** — companies actually reviewing applicants; cuts stale/ghost posts. |
| `f_JT` | `F,C` | Full-time + Contract only; drops internship/part-time/volunteer noise. |
| `f_TPR` | `r<sec>` | Time window; the collector uses a 2h window per hourly run (overlap buffer; DB dedupe collapses it). |
| `f_E` | `2,3,4` | Experience levels (Entry/Associate/Mid-Senior), from `CONFIG.experience`. |

Boolean keyword terms also help: `CONFIG.linkedinPriorityTerms` runs
`Frontend Engineer AND ("hiring" OR "requirement")` first (tighter, higher-signal set), seeding
the dedupe set before the broad title queries. LinkedIn's `keywords` honours `AND` / `OR` / `NOT`
/ quoted phrases / parentheses — add your own there. (Naukri's guest API does **not** parse this
syntax, which is why priority terms are LinkedIn-only.)

Output: `./output/YYYY-MM-DD-HHMM.csv`, columns:
`score, title, company, location, seniority, salary_lpa, matched_keywords,
unmatched_keywords, posted_at, remote, source, url`.

State: `./data/jobs.db` (SQLite tracker). `./.cache/` holds short-lived HTTP
response caches. Both are gitignored.

---

## Sources

| Source | How | Status | Notes |
|---|---|---|---|
| **LinkedIn** | Logged-out guest endpoint `seeMoreJobPostings` + per-job detail enrichment | ✅ on | True last-24h (`f_TPR=r86400`), India + remote. Best source. |
| **RemoteOK** | Free JSON API | ✅ on | Remote-global firehose, title-filtered to FE. Thin for India. |
| **Remotive** | Free JSON API | ✅ on | Remote-global, data lags ~days. Supplementary only. |
| **Naukri** | Guest `jobapi/v3` JSON + minted `nkparam` token | ✅ on (local-only) | **Wired up & verified working** — the 406 gate is a client-side RSA token we mint in pure code (no browser). Run from a residential India IP. See below. |

Toggle any source in `config.ts → CONFIG.sources`.

### LinkedIn enrichment
Guest listing cards have no description, so a card's title-only score is useless —
every card lands at ~0–10% (e.g. `"Frontend Engineer"` matches no keyword tokens →
0%; `"React Developer"` matches only React → 10%). That makes title-only score a
**bad gate** for deciding which jobs to enrich: a perfect-fit JD behind a generic
title would score 0% and be skipped.

So the tool enriches the LinkedIn set **up front, before scoring** — it fetches the
full JD (+ salary when shown) for every LinkedIn card (capped at
`CONFIG.linkedinEnrich.maxEnrich`, default 80) and then scores everything **once**
on the real text. This turns flat ~10% title scores into an accurate spread.

> Trade-off: up to `maxEnrich` polite detail fetches per run (~2.5–5s each). Fine
> for a daily run; lower `maxEnrich` if a run feels slow, raise
> `CONFIG.sources.linkedin.maxPages` for more card volume.

### Naukri — the `nkparam` unblock (verified 2026-06-23)
The earlier "Naukri needs reCAPTCHA" story was **wrong**. That `406
{"message":"recaptcha required"}` is a red herring: the guest `jobapi/v3/search`
endpoint just wants **one extra header — `nkparam`** — and that token is generated
**entirely client-side**, so we can mint it ourselves. **No headless browser, no
CAPTCHA solver, no proxy, no login.**

**How `nkparam` is built.** It's an RSA-encrypted (PKCS#1 v1.5), base64'd blob of a
trivial plaintext:

```
plaintext = "v0|" + Date.now() + "|121_srp"          // e.g. "v0|1750691400000|121_srp"
nkparam   = base64( RSA_publicEncrypt( NAUKRI_PUBLIC_KEY, plaintext ) )
```

The RSA **public** key is embedded in Naukri's own JS bundle. Node's built-in
`crypto.publicEncrypt({ key, padding: RSA_PKCS1_PADDING }, …)` does it in one line —
no dependency. PKCS#1 v1.5 uses random padding, so every token looks unique and
"one-time" (this is what made people reach for Selenium), but you can mint
**unlimited** fresh tokens locally in microseconds.

Naukri's public key (re-extract from their app JS if it ever rotates):

```
-----BEGIN PUBLIC KEY-----
MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBALrlQ+djR0RjJwBF1xuisHmdFv334MIm
K6LgzJhmLhN7B5yuEyaKoasgXQk3+OQglsOaBxEJ0j5PcTL3nbOvt80CAwEAAQ==
-----END PUBLIC KEY-----
```

**The working request** (verified live, logged-out → `HTTP 200`, 2,625 jobs,
last-1-day filter):

```
GET https://www.naukri.com/jobapi/v3/search?<params>
headers:
  appid: 109
  systemid: Naukri
  gid: LOCATION,INDUSTRY,EDUCATION,FAREA_ROLE
  clientid: d3skt0p
  nkparam: <freshly minted, one per request>
  accept: application/json
  user-agent: <a real browser UA>
```

Filters are just query params (the same knobs Apify sells):

| Filter | Param | Example |
|---|---|---|
| keyword | `keyword` + `k` | `frontend developer` |
| SEO key | `seoKey` | `frontend-developer-jobs-in-pune-1` |
| location | `location` + `l` | `pune` |
| experience (years) | `experience` | `3` |
| **last-24h freshness** | `jobAge` | `1` |
| pagination | `pageNo`, `noOfResults` | `1`, `20` |
| sort | `sort` | `f` (freshness) |

Response is rich JSON `jobDetails[]`: `title`, `companyName`,
`placeholders[type=location|salary|experience]`, `jdURL`, `footerPlaceholderLabel`
("1 Day Ago"), `tagsAndSkills`, `jobDescription`. Maps cleanly onto the existing
`Job` shape in `src/sources/naukri.ts` (which already parses this structure).

**Implemented** in `src/sources/naukri.ts`: it mints a fresh `nkparam` per request
(`mintNkparam()`), sends the headers above, uses the `jobAge=1` freshness param, and
is enabled via `CONFIG.sources.naukri.enabled = true`. Note: when a query has fewer
pages than `maxPages`, Naukri returns `400 "Requested page number doesn't exists"`
for the overflow page (not an empty list) — the source treats that specific 400 as
end-of-pagination and moves on, rather than failing.

**Caveats — read before enabling.**
- **Fragility.** Breaks if Naukri rotates the RSA key or changes the plaintext format
  (`v0|…|121_srp`). Fix = re-extract both from their current app JS. Lower-maintenance
  than the LinkedIn HTML-selector dependency, not zero.
- **Still a ToS violation.** This is automated access Naukri prohibits — *same* gray
  area as the LinkedIn source, arguably cleaner (no login, no human-verification
  bypass; we just replicate their request signing). Keep it **logged-out, low-volume,
  once a day, residential IP** — never a cloud VM. `CONFIG.forbidLogin` stays on.
- **Scope.** Only the logged-out *search* is in scope. Token-gen was reverse-engineered
  from a community client whose login / resume-upload / auto-apply features cross
  `forbidLogin` — those are **out of scope** here.

Prefer the zero-risk path? Naukri **email job alerts** ↓ still work and need no code.

#### Zero-risk fallback: Naukri (and LinkedIn) free email alerts
1. On naukri.com (logged in, manually — that's fine, you're a real user), search
   your roles with the **freshness = last 1 day** filter.
2. Click **"Create Job Alert"** → daily email. Do the same for each target title.
3. LinkedIn: on a jobs search with "Past 24 hours", toggle **Set alert**.
4. These daily emails are the sanctioned, block-free feed. Triage them by hand
   alongside this tool's CSV. (A future enhancement could parse these via Gmail.)

---

## Schedule it (run every morning)

### macOS — launchd (recommended on this machine)
Create `~/Library/LaunchAgents/com.jobtools.daily.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.jobtools.daily</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd /Users/lakhveer/Desktop/job-tools && /usr/local/bin/npm run daily >> ./data/run.log 2>&1</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><false/>
</dict></plist>
```
```bash
launchctl load ~/Library/LaunchAgents/com.jobtools.daily.plist   # 9:00 AM daily
# Adjust the npm path: run `which npm`. Unload with `launchctl unload <plist>`.
```

### Linux/macOS — cron
```bash
crontab -e
# 9 AM daily:
0 9 * * * cd /Users/lakhveer/Desktop/job-tools && /usr/local/bin/npm run daily >> ./data/run.log 2>&1
```

### Windows — Task Scheduler
Create a Basic Task → Daily 9:00 AM → Action "Start a program":
`cmd /c "cd /d C:\path\to\job-tools && npm run daily >> data\run.log 2>&1"`.

> Run Naukri-adjacent scraping **only from your home (residential) IP** — never a
> cloud VM. Keep it once a day.

---

## Manual email-finding workflow (recruiter outreach)

The tool surfaces only **public** company / posting info — no recruiter personal
data is scraped or stored. Finding a contact email is a manual, human-in-the-loop
step:

1. From the CSV, note the **company** and the role.
2. Find the recruiter / hiring manager on the company site or LinkedIn (manually).
3. Guess the email pattern (`first.last@company.com`, `first@company.com`) — or:
   - **Apollo.io** free Chrome extension (limited free lookups),
   - **Hunter.io** free tier (email finder + pattern),
4. **Verify** before sending with a free verifier (Hunter's verifier, or
   `mailtester`-style tools) to avoid bounces.
5. Send a short, tailored note. Keep volume sane and personal.

---

## Troubleshooting

**A source got blocked (429/403)** — the run logs it per-source and continues;
other sources still produce a CSV. Wait, then rerun later. The tool already paces
requests (2.5–5s jittered), rotates User-Agents, backs off exponentially, and
caches responses. To be gentler: raise `CONFIG.http.minDelayMs/maxDelayMs`, lower
`maxPages`, or trim `linkedinSearchTerms`.

**LinkedIn returns 0 jobs / "likely a soft block or markup changed"** — either you
were rate-limited (wait and retry, raise delays) or LinkedIn changed its card
HTML. Fix the selectors in `CONFIG.linkedinSelectors` /
`CONFIG.linkedinDetailSelectors` (inspect the page, update the CSS classes).

**Naukri fails with "recaptcha required" / 406 / 403** — you're missing the
`nkparam` header, or it's stale/malformed. Mint a fresh one per request (see
"Naukri — the `nkparam` unblock" above). If it persists after a valid token,
Naukri may have rotated the RSA public key or the `v0|…|121_srp` plaintext format —
re-extract both from their current app JS. As a no-code fallback, use email alerts.

**Scores look low across the board** — check `matched`/`unmatched` columns. If a
keyword you expect isn't matching, adjust its `aliases` in `CONFIG.KEYWORDS`.

**Too many / too few results** — tune `CONFIG.sources.*.maxPages`,
`linkedinSearchTerms`, `freshness.apiMaxAgeHours`, and `output.topN`.

**Reset the "seen" history** — delete `./data/jobs.db` (every job becomes new
again). Clear HTTP cache with `rm -rf ./.cache`.

---

## How to update when a source breaks

Everything brittle lives in **`config.ts`**:
- `endpoints` — base URLs.
- `linkedinSelectors` / `linkedinDetailSelectors` — CSS for guest cards / detail.
- `linkedinParams`, `freshness` — query params (`f_TPR`, `f_WT`, `pageStep`, Naukri freshness).
- `naukriHeaders` — `appid` / `systemid`.
- `KEYWORDS` — scoring keywords, aliases, weights (weight 0 = ignored).
- `http` — delays, retries, backoff, User-Agents, cache TTL.

Per-source parsing is isolated in `src/sources/*.ts`; a thrown error there never
crashes the run (see `src/sources/base.ts`).

---

## Risks (read this)

- **Terms of Service** — LinkedIn & Naukri prohibit scraping. This tool uses only
  public **logged-out** endpoints and free APIs, and has **no login path** at all
  (`CONFIG.forbidLogin`). Don't add one.
- **IP blocking / CAPTCHA** — possible on LinkedIn at volume; Naukri's guest API is
  reachable via the minted `nkparam` token (above) but is still rate-sensitive.
  Mitigated by low daily volume, single concurrency, jittered delays, backoff, and
  caching. Run from your **residential IP**, not a cloud VM.
- **Legal/ethical gray area** — personal, low-volume, logged-out use is
  lower-risk, **not** sanctioned. Use your judgment.
- **Privacy** — no recruiter personal data is scraped or stored. Email-finding is
  a manual step you do.
- **Brittleness** — these endpoints/HTML change without notice. The tool validates
  responses and fails loudly; fixes live in `config.ts`.

## Attribution
Job data via **RemoteOK** (remoteok.com) and **Remotive** (remotive.com), per
their API terms (attribution + link back to the listing).

! node --env-file=.env applier/server.mjs
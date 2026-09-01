/** A normalized job posting, common shape across all sources. */
export interface Job {
  source: string;
  externalId: string; // stable id within the source, for dedupe/tracking
  title: string;
  company: string;
  location: string;
  url: string;
  description: string; // text used for keyword scoring (may be short for some sources)
  postedAt: string | null; // ISO date if known
  salary: string | null; // raw salary / LPA text if disclosed
  applicants?: string | null; // raw applicant count text from detail page (e.g. "Over 200 applicants")
  experience?: string | null; // required-experience band if disclosed (e.g. "3-7 Yrs")
  remote: boolean;
  tags: string[];
  applyType?: "easy_apply" | "external" | null; // easy_apply = applies on LinkedIn; external = redirects to company site/ATS
  hrName?: string | null; // recruiter name from "message the recruiter" block, if shown
  hrProfileUrl?: string | null; // recruiter's LinkedIn profile URL, if shown
  employmentType?: string | null; // e.g. "Full-time", "Contract"
  jobFunction?: string | null; // e.g. "Engineering and Information Technology"
  industries?: string | null; // e.g. "IT Services and IT Consulting"
}

export interface KeywordHit {
  label: string;
  weight: number;
}

/**
 * One reason a job lost points, e.g. { label: "needs 8+ yrs", points: 40 }.
 * Nothing is filtered out of the results any more — see src/filter.ts.
 */
export interface Penalty {
  label: string;
  points: number;
}

export interface ScoredJob extends Job {
  matched: KeywordHit[];
  unmatched: string[]; // labels of weighted keywords NOT found
  score: number; // 0–100 weighted match %
  seniority: "favored" | "stretch" | "unknown";
  /** What kind of role the TITLE describes — sets the score's title multiplier. */
  titleClass?: "frontend" | "fullstack" | "generic";
  /** Title itself says React/Next.js/Frontend — score was floored (relevance.titleBoost). */
  titleBoosted?: boolean;
  /** JD names React/TS and asks for NO foreign backend stack (relevance.purity). */
  stackPure?: boolean;
  /** Backend technology groups the JD asks for; each one discounts the score. */
  backendGroups?: string[];
  /**
   * True when this job was surfaced WITHOUT its JD ever being fetched (past the
   * enrich cap, or the detail request failed). Its score is meaningless — judge
   * it from the link. A later run fetches and scores it properly.
   */
  jdMissing?: boolean;
  /** Match % BEFORE penalties, so the UI can show "78 → 33" and why. */
  baseScore?: number;
  /** Items of YOUR stack this JD names (CONFIG.stackProfile), as a set. */
  stackHits?: string[];
  /** Points the stack overlap added to the score. 0 when the anchor gate is shut. */
  stackBonus?: number;
  /** Did the JD name React or TypeScript? False ⇒ stackBonus is 0 by rule. */
  stackAnchored?: boolean;
  /** Why this job lost points. Empty = nothing held against it. */
  penalties?: Penalty[];
  tfidfScore?: number; // 0–1 TF-IDF cosine similarity vs resume (set after enrichment)
  salaryBand?: SalaryBand; // crowd-sourced market band (AmbitionBox), absent if unresolved
  presence?: PresenceSignals; // online-footprint evidence; ONLY set when AmbitionBox had no page
}

/**
 * Evidence that a real operating company exists behind a name, for the ones
 * AmbitionBox has never heard of. Deliberately measures footprint, not age or
 * headcount: a genuine 15-person startup founded last year is invisible to
 * AmbitionBox and still lights every signal here up.
 *
 * This is evidence for a human to read, NOT a fraud verdict. `unverified` means
 * we could not find the company's domain — never that the company is fake.
 */
export interface PresenceSignals {
  company: string;
  /** The domain we tied back to this company, or null if no guess was confirmed. */
  domain: string | null;
  verdict: "operating" | "thin" | "unverified";
  /** Human-readable evidence behind the verdict, best signal first. */
  reasons: string[];
  siteLive: boolean;
  /** Set when the company name was found in the homepage <title> — the gate that ties domain to company. */
  nameMatch: "title" | null;
  /** Paid-mail provider from MX records, e.g. "Google Workspace". Null = receives no mail. */
  mxProvider: string | null;
  /** Distinct hostnames in Certificate Transparency logs. */
  hostnames: number;
  /** Infra-shaped subdomains (app/api/backend/staging/…) — the hardest signal to fake. */
  infraHosts: string[];
  /** Wildcard-only certs hide subdomains: infra is UNKNOWN here, not absent. */
  wildcardOnly: boolean;
  /**
   * Both CT logs were unreachable, so footprint is UNKNOWN rather than absent.
   * Caps the verdict at `thin`: without CT the only evidence left is "a site
   * exists and gets mail", which a one-afternoon shell also satisfies.
   */
  certsUnknown: boolean;
  /** Earliest cert (YYYY-MM-DD) — when they actually went live. */
  firstCert: string | null;
  /** Domain registration date (YYYY-MM-DD) via RDAP. */
  domainRegistered: string | null;
  /** 0–100 weight of evidence. Age can only ever ADD, never subtract. */
  score: number;
}

/**
 * A market salary band for a (company, role) pair — what people report earning,
 * NOT what this posting pays. `job.salary` remains the posting's own disclosed
 * figure; the two are independent and must not be conflated.
 */
export interface SalaryBand {
  company: string;      // company name as AmbitionBox resolved it (may differ from LinkedIn's)
  profile: string;      // AmbitionBox job profile matched (e.g. "Senior Software Engineer")
  minLpa: number;       // outlier-trimmed low end (typicalMinCtc)
  maxLpa: number;       // outlier-trimmed high end (typicalMaxCtc)
  avgLpa: number;
  dataPoints: number;   // submissions behind the band — the trust signal
  expRange: string;     // experience the band spans, e.g. "3-8" (years)
  matchQuality: number; // 0–1 cosine between the job title and the profile name
  /**
   * HOW the profile was chosen — never conflate these:
   *  - `title`  — strong title match (cosine ≥ minTitleSim). Trust it.
   *  - `approx` — closest title, below the strong floor but sharing a domain
   *    token (e.g. "Java FSD with React or Node JS" → "Java Developer", 0.745).
   *  - `ladder` — NO title match; this is the company's generic engineer rung at
   *    this posting's seniority + experience. The rung, not the stack. Useful
   *    (at Wissen the SE→Senior SE jump is ~10 LPA, far more than the stack) but
   *    it is a proxy: it says what someone at this level earns here, not what
   *    someone doing THIS job earns.
   */
  matchType: "title" | "approx" | "ladder";
  url: string;
  companySlug: string;  // AmbitionBox slug that resolved — used to build role URLs
  roleSlug: string;
  /**
   * Salary split by experience bucket (needs the per-role page fetch). The
   * headline band blends every experience level together, so for a posting
   * asking 3-5 yrs the right number is the 3-6 bucket, not the headline.
   */
  expBuckets?: ExpBucket[];
  /** The bucket overlapping this posting's required experience, if both are known. */
  atExp?: ExpBucket;
  /** AmbitionBox's own confidence label, e.g. "VeryHigh" | "High" | "Low". */
  confidence?: string;
}

export interface ExpBucket {
  label: string;   // e.g. "3-6"
  minExp: number;
  maxExp: number;
  minLpa: number;
  maxLpa: number;
  avgLpa: number;
  n: number;
}

/** Each source returns its jobs plus a status so one failure can't crash the run. */
export interface SourceResult {
  source: string;
  ok: boolean;
  jobs: Job[];
  error?: string;
}

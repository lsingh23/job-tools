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
  experience?: string | null; // required-experience band if disclosed (e.g. "3-7 Yrs")
  remote: boolean;
  tags: string[];
}

export interface KeywordHit {
  label: string;
  weight: number;
}

export interface ScoredJob extends Job {
  matched: KeywordHit[];
  unmatched: string[]; // labels of weighted keywords NOT found
  score: number; // 0–100 weighted match %
  seniority: "favored" | "stretch" | "unknown";
}

/** Each source returns its jobs plus a status so one failure can't crash the run. */
export interface SourceResult {
  source: string;
  ok: boolean;
  jobs: Job[];
  error?: string;
}

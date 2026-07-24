import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../config.js";
import { formatBuckets } from "./salary.js";
import type { ScoredJob } from "./types.js";

function esc(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const HEADER = [
  "score",
  "tfidf_sim",
  "title",
  "company",
  "location",
  "experience",
  "seniority",
  "applicants",
  "salary_lpa",
  "market_salary_lpa",     // AmbitionBox band for (company, role) — NOT this posting's pay
  "market_salary_exp",     // experience the band spans, in years
  "market_salary_role",    // the AmbitionBox profile the title matched
  "market_salary_match",   // title | approx | ladder — ladder = level proxy, NOT this job's pay
  "market_salary_n",       // submissions behind the band; low n = don't trust it
  "market_salary_at_exp",  // band narrowed to THIS posting's required experience
  "market_salary_by_exp",  // full split by experience bucket
  "market_salary_url",
  "presence_verdict",      // operating | thin | unverified — only for companies AmbitionBox lacks
  "presence_domain",       // the domain tied back to the company; eyeball this if a verdict surprises you
  "presence_evidence",     // what was actually observed, best signal first
  "presence_first_live",   // earliest TLS cert — when they genuinely went live
  "apply_type",
  "employment_type",
  "job_function",
  "industries",
  "hr_name",
  "hr_profile_url",
  "matched_keywords",
  "unmatched_keywords",
  "posted_at",
  "remote",
  "source",
  "url",
];

/** Writes a timestamped CSV ranked by match %. Returns the file path. */
export function writeCsv(jobs: ScoredJob[], stamp: string): string {
  mkdirSync(CONFIG.output.dir, { recursive: true });
  const file = join(CONFIG.output.dir, `${stamp}.csv`);

  const rows = jobs.map((j) =>
    [
      j.score,
      j.tfidfScore !== undefined ? (j.tfidfScore * 100).toFixed(1) : "",
      j.title,
      j.company,
      j.location,
      j.experience ?? "",
      j.seniority,
      j.applicants ?? "",
      j.salary ?? "",
      j.salaryBand ? `${j.salaryBand.minLpa}–${j.salaryBand.maxLpa}` : "",
      j.salaryBand ? `${j.salaryBand.expRange} yrs` : "",
      j.salaryBand?.profile ?? "",
      j.salaryBand ? `${j.salaryBand.matchType} (${j.salaryBand.matchQuality})` : "",
      j.salaryBand?.dataPoints ?? "",
      j.salaryBand?.atExp ? `${j.salaryBand.atExp.minLpa}–${j.salaryBand.atExp.maxLpa} @ ${j.salaryBand.atExp.label} yrs (n=${j.salaryBand.atExp.n})` : "",
      formatBuckets(j.salaryBand),
      j.salaryBand?.url ?? "",
      j.presence ? `${j.presence.verdict} (${j.presence.score})` : "",
      j.presence?.domain ?? "",
      j.presence?.reasons.join("; ") ?? "",
      j.presence?.firstCert ?? "",
      j.applyType === "easy_apply" ? "Easy Apply" : j.applyType === "external" ? "Company Site" : "",
      j.employmentType ?? "",
      j.jobFunction ?? "",
      j.industries ?? "",
      j.hrName ?? "",
      j.hrProfileUrl ?? "",
      j.matched.map((m) => m.label).join("; "),
      j.unmatched.join("; "),
      j.postedAt ?? "",
      j.remote ? "yes" : "no",
      j.source,
      j.url,
    ]
      .map(esc)
      .join(","),
  );

  writeFileSync(file, [HEADER.join(","), ...rows].join("\n"), "utf8");
  return file;
}

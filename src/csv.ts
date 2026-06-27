import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../config.js";
import type { ScoredJob } from "./types.js";

function esc(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const HEADER = [
  "score",
  "title",
  "company",
  "location",
  "experience",
  "seniority",
  "salary_lpa",
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
      j.title,
      j.company,
      j.location,
      j.experience ?? "",
      j.seniority,
      j.salary ?? "",
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

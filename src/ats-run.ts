import { runSource } from "./sources/base.js";
import { greenhouseSource, leverSource, ashbySource, workdaySource } from "./sources/ats.js";
import { loadRegistry } from "./discover.js";

/**
 * Poll the ATS boards on their own, without the LinkedIn/Naukri pipeline.
 * Use this to sanity-check the registry and see raw freshness:
 *
 *   npm run ats              # all four
 *   npm run ats -- ashby     # one
 */
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const all = [greenhouseSource, leverSource, ashbySource, workdaySource];
const sources = only.length ? all.filter((s) => only.includes(s.name)) : all;

const reg = loadRegistry();
console.log(`registry: ${reg.companies.length} companies (updated ${reg.updatedAt})`);

const jobs = (await Promise.all(sources.map((s) => runSource(s)))).flatMap((r) => r.jobs);

jobs.sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""));
console.log(`\n${jobs.length} jobs, newest first:\n`);
for (const j of jobs.slice(0, 40)) {
  const age = j.postedAt
    ? `${((Date.now() - new Date(j.postedAt).getTime()) / 3_600_000).toFixed(0)}h`.padStart(5)
    : "    ?";
  console.log(`${age}  ${j.source.padEnd(10)} ${j.title.slice(0, 52).padEnd(53)} ${j.company.slice(0, 20).padEnd(21)} ${j.location.slice(0, 30)}`);
}

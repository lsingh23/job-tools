/**
 * Manual driver for the presence fallback: `npx tsx scripts/presence-check.ts "Recrew AI" ...`
 * Probes company names directly, bypassing a full scrape run. Use it to sanity-check
 * a verdict, or to find the right domain for a CONFIG.presence.aliases entry.
 */
import { enrichWithPresence, formatPresence, domainCandidates } from "../src/presence.js";
import type { ScoredJob } from "../src/types.js";

const names = process.argv.slice(2);
if (!names.length) {
  console.error('usage: npx tsx scripts/presence-check.ts "Recrew AI" "Some Startup"');
  process.exit(1);
}

const jobs = names.map((company, i) => ({
  source: "manual",
  externalId: String(i),
  title: "Frontend Engineer",
  company,
  location: "",
  url: "",
  description: "",
  postedAt: null,
  salary: null,
  remote: false,
  tags: [],
  matched: [],
  unmatched: [],
  score: 0,
  seniority: "unknown",
})) as ScoredJob[];

for (const n of names) console.log(`${n} → guesses: ${domainCandidates(n).join(", ")}`);

const tally = await enrichWithPresence(jobs, names);
console.log(`\nprobed ${tally.probed}: ${tally.operating} operating, ${tally.thin} thin, ${tally.unverified} unverified\n`);
for (const j of jobs) console.log(`${j.company.padEnd(24)} ${formatPresence(j.presence)}`);

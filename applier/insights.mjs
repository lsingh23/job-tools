// What-to-learn-next report from the application log (blueprint Part 8).
//   node applier/insights.mjs
// Prints callback stats and the ranked missing-keyword table so you can see, at a glance, which
// skills the JDs keep asking for that your résumé can't honestly back.

import { insights } from "./feedback.mjs";

const i = insights();
const pct = i.callback_rate === null ? "—" : `${(i.callback_rate * 100).toFixed(0)}%`;

console.log(`\nApplications: ${i.total_applications}  ·  outcomes recorded: ${i.with_outcome}  ·  callbacks: ${i.callbacks} (${pct})\n`);

if (!i.learn.length) {
  console.log("No gap keywords yet — tailor a few applications, then check back.\n");
} else {
  console.log("LEARN NEXT — JD keywords your résumé can't back (ranked by cost):");
  console.log("  no-callback  missed  keyword");
  for (const r of i.learn.slice(0, 25)) {
    console.log(`  ${String(r.no_callback).padStart(11)}  ${String(r.missed).padStart(6)}  ${r.keyword}`);
  }
  console.log("");
}

if (i.no_room.length) {
  console.log("HAVE IT, NO ROOM — defensible but dropped for one-page fit (free space to include):");
  for (const r of i.no_room.slice(0, 15)) console.log(`  ${String(r.count).padStart(4)}  ${r.keyword}`);
  console.log("");
}

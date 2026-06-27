import { markApplied, stats } from "./tracker.js";

/** Usage: npm run applied -- <externalId> [<externalId> ...]
 *  e.g.   npm run applied -- linkedin:4282211964
 *  The externalId is the last CSV column's id form (source:id). */
const ids = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (ids.length === 0) {
  console.error("Usage: npm run applied -- <externalId> [more ids]");
  process.exit(1);
}
for (const id of ids) {
  console.log(markApplied(id) ? `✓ marked applied: ${id}` : `✗ not found: ${id}`);
}
const s = stats();
console.log(`Tracker: ${s.total} jobs known, ${s.applied} marked applied.`);

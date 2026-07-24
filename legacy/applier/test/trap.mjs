// Planted-trap acceptance test for the proposer + verifier + cache (blueprint Part 8 step 4).
// LIVE — makes real DeepSeek calls, so it is NOT part of `node --test`. Run manually:
//   node --env-file=.env applier/test/trap.mjs
//
// Traps (given this master: has Docker, Jest, Redux, Cypress, REST APIs; no K8s/Vitest/Zustand):
//   Kubernetes ⟵ Docker  → verifier MUST REJECT  (different layer, "same ecosystem" is not enough)
//   Vitest     ⟵ Jest    → verifier SHOULD ACCEPT (sibling test runner, same job-to-be-done)
//   Zustand    ⟵ Redux   → verifier SHOULD ACCEPT (sibling state manager)
// Then: re-run the SAME set and require ZERO new verifier calls (everything from cache).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDocumentXml } from "../docx.mjs";
import { extractUnits, unitsToText } from "../extract.mjs";
import { loadVerdicts } from "../verdicts.mjs";
import { resolveAdditions } from "../additions.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MASTER = process.env.MASTER_RESUME ?? path.join(HERE, "..", "master-resume.docx");

const masterText = unitsToText(extractUnits(readDocumentXml(MASTER)).units);
const jd = {
  exact_title: "Frontend Engineer",
  must_haves: ["Kubernetes", "Vitest"],
  keywords: ["Kubernetes", "Vitest", "Zustand"],
  nice_to_haves: [], seniority: "mid", domain: "web",
};

const tmp = path.join(mkdtempSync(path.join(tmpdir(), "trap-")), "verdicts.json");
let pass = true;
const check = (label, cond) => { console.log(`  ${cond ? "✅" : "❌"} ${label}`); if (!cond) pass = false; };

console.log("\n── Run 1: cold cache (real verifier calls) ──");
const cache1 = loadVerdicts(masterText, tmp);
const r1 = await resolveAdditions({ masterText, jd, cache: cache1, samples: 2, onLog: (l) => console.log("   ·", l) });
cache1.save();

const approved = new Set(r1.approved.map((a) => a.keyword.toLowerCase()));
const missing = new Set(r1.missing.map((m) => m.keyword.toLowerCase()));
console.log("  approved:", [...approved].join(", ") || "(none)");
console.log("  missing :", r1.missing.map((m) => `${m.keyword}[${m.reason}]`).join(", ") || "(none)");

check("Kubernetes REJECTED (not approved, reported missing)", !approved.has("kubernetes") && missing.has("kubernetes"));
check("Vitest ACCEPTED", approved.has("vitest"));
check("Zustand ACCEPTED", approved.has("zustand"));
check("every approved addition has verbatim evidence", r1.approved.every((a) => a.evidence && masterText.includes(a.evidence)));
check("verifier actually ran on run 1", r1.verifierCalls > 0);

console.log("\n── Run 2: warm cache (same master, same pairs) ──");
const cache2 = loadVerdicts(masterText, tmp);
const r2 = await resolveAdditions({ masterText, jd, cache: cache2, samples: 2, onLog: (l) => console.log("   ·", l) });
check("ZERO new verifier calls on run 2 (all cache hits)", r2.verifierCalls === 0);
check("run 2 approvals identical to run 1", new Set(r2.approved.map((a) => a.keyword.toLowerCase())).size === approved.size
  && r2.approved.every((a) => approved.has(a.keyword.toLowerCase())));

rmSync(path.dirname(tmp), { recursive: true, force: true });
console.log(`\n${pass ? "✅ ALL TRAPS PASSED" : "❌ SOME TRAPS FAILED"}\n`);
process.exit(pass ? 0 : 1);

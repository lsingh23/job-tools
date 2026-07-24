// Foundation tests for the tailoring pipeline's deterministic, code-enforced half.
//   node --test applier/test/
// Covers: extractor round-trip (build step 1), verdict cache (Part 4 Move 3), edit validators
// (Part 4 Move 2), and the monotonic score gate (Part 6 step 12). No API key required.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readDocumentXml } from "../docx.mjs";
import { extractUnits, editableUnits, unitsToText, applyEdits, applyBulletOrder } from "../extract.mjs";
import { tailorResume } from "../tailor.mjs";
import { loadVerdicts, masterHash, verdictKey } from "../verdicts.mjs";
import {
  isVerbatimEvidence, checkBudget, numbersPreserved, makeNounGuard, isAllowedTitle, validateEdit,
} from "../validate.mjs";
import { mentions, coverageScore, scoreGate } from "../score.mjs";
import { atomize } from "../llm.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MASTER = process.env.MASTER_RESUME ?? path.join(HERE, "..", "master-resume.docx");
const hasMaster = existsSync(MASTER);

// ── extractor ─────────────────────────────────────────────────────────────────────
test("extract: round-trip with zero edits is byte-identical", { skip: !hasMaster }, () => {
  const xml = readDocumentXml(MASTER);
  const { byId } = extractUnits(xml);
  assert.equal(applyEdits(xml, [], byId), xml, "empty edit set must be the identity");
});

test("extract: units have stable ids, positive char counts, and matching text lengths", { skip: !hasMaster }, () => {
  const xml = readDocumentXml(MASTER);
  const { units } = extractUnits(xml);
  assert.ok(units.length > 5, "expected several units");
  const ids = units.map((u) => u.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  for (const u of units) assert.equal(u.chars, u.text.length, `chars must equal text length for ${u.id}`);
  assert.ok(units.some((u) => u.id === "sum"), "a summary unit must exist");
  assert.ok(units.some((u) => u.id.startsWith("skills.")), "at least one skills line");
  assert.ok(units.some((u) => /^exp\d+\.b\d+$/.test(u.id)), "at least one experience bullet");
});

test("extract: editableUnits exposes only editable units and only id/section/text/chars", { skip: !hasMaster }, () => {
  const xml = readDocumentXml(MASTER);
  const { units } = extractUnits(xml);
  const ed = editableUnits(units);
  assert.ok(ed.length > 0);
  for (const u of ed) assert.deepEqual(Object.keys(u).sort(), ["chars", "id", "section", "text"]);
  // role headers / stack lines are not editable → excluded
  assert.ok(!ed.some((u) => /\.h$/.test(u.id) || /\.stack$/.test(u.id)));
});

test("extract: a single edit changes exactly one paragraph's text", { skip: !hasMaster }, () => {
  const xml = readDocumentXml(MASTER);
  const { units, byId } = extractUnits(xml);
  const bullet = units.find((u) => u.kind === "bullet");
  const shorter = bullet.text.slice(0, Math.max(1, bullet.text.length - 5)); // length-safe edit
  const out = applyEdits(xml, [{ id: bullet.id, new_text: shorter }], byId);
  assert.notEqual(out, xml, "editing a bullet must change the document");
  const after = extractUnits(out).byId.get(bullet.id);
  assert.equal(after.text, shorter, "only the target unit's text should change");
  // every OTHER unit is untouched
  for (const [id, u] of extractUnits(out).byId) {
    if (id !== bullet.id) assert.equal(u.text, byId.get(id).text, `unit ${id} must be unchanged`);
  }
});

test("extract: bullet reordering is length-neutral and permutes only within a role", { skip: !hasMaster }, () => {
  const xml = readDocumentXml(MASTER);
  const { roles, byId } = extractUnits(xml);
  const role = roles.find((r) => r.bulletIds.length >= 2);
  if (!role) return; // no multi-bullet role to test
  const reversed = [...role.bulletIds].reverse();
  const out = applyBulletOrder(xml, { [role.headerId]: reversed }, roles, byId);
  assert.equal(out.length, xml.length, "reordering must not change document length");
  const afterUnits = extractUnits(out);
  const afterBulletIds = afterUnits.roles.find((r) => r.n === role.n).bulletIds;
  // text content of that role's bullets, in new document order, equals the reversed originals
  const origText = role.bulletIds.map((id) => byId.get(id).text);
  const newText = afterBulletIds.map((id) => afterUnits.byId.get(id).text);
  assert.deepEqual(newText, [...origText].reverse());
});

// ── verdict cache ───────────────────────────────────────────────────────────────
test("verdicts: key is the normalized keyword (evidence-independent, so caching is stable)", () => {
  assert.equal(verdictKey("Playwright"), verdictKey(" playwright "));
  assert.notEqual(verdictKey("Playwright"), verdictKey("Selenium"));
});

test("verdicts: set/get/partition and permanent user veto", () => {
  const tmp = path.join(mkdtempSync(path.join(tmpdir(), "verdicts-")), "v.json");
  const master = "resume text with Cypress and Docker";
  const cache = loadVerdicts(master, tmp);
  cache.set("Playwright", "ACCEPT", { evidence: "Cypress", by: "ai" });
  cache.set("Kubernetes", "REJECT", { evidence: "Docker", by: "ai" });
  assert.equal(cache.get("Playwright").verdict, "ACCEPT");
  assert.equal(cache.get("Playwright").evidence, "Cypress");

  // A cache hit must not depend on the proposer re-quoting the same evidence string.
  const claims = [
    { keyword: "Playwright", evidence_quote: "e2e tests with Cypress" }, // different quote, still ACCEPT
    { keyword: "Kubernetes", evidence_quote: "Docker" },                 // cached REJECT
    { keyword: "Vitest", evidence_quote: "Jest" },                       // novel
  ];
  const { cachedAccept, cachedReject, uncached } = cache.partition(claims);
  assert.equal(cachedAccept.length, 1);
  assert.equal(cachedReject.length, 1);
  assert.equal(uncached.length, 1);
  assert.equal(uncached[0].keyword, "Vitest");

  // veto flips a wrong ACCEPT to a permanent REJECT, survives reload
  cache.veto("Playwright", { evidence: "Cypress" }).save();
  const reloaded = loadVerdicts(master, tmp);
  assert.equal(reloaded.get("Playwright").verdict, "REJECT");
  assert.equal(reloaded.get("Playwright").by, "user-veto");
  rmSync(path.dirname(tmp), { recursive: true, force: true });
});

test("verdicts: a changed master invalidates the cache (hash-keyed)", () => {
  const tmp = path.join(mkdtempSync(path.join(tmpdir(), "verdicts-")), "v.json");
  loadVerdicts("MASTER ONE", tmp).set("X", "ACCEPT").save();
  assert.equal(loadVerdicts("MASTER ONE", tmp).get("X").verdict, "ACCEPT");
  assert.equal(loadVerdicts("MASTER TWO", tmp).get("X"), null, "different master → clean cache");
  assert.notEqual(masterHash("MASTER ONE"), masterHash("MASTER TWO"));
  rmSync(path.dirname(tmp), { recursive: true, force: true });
});

// ── validators ────────────────────────────────────────────────────────────────────
test("validate: verbatim evidence check kills paraphrase, tolerates typography", () => {
  const master = "Built E2E tests with Cypress and Playwright — cut flakiness 40%.";
  assert.ok(isVerbatimEvidence("E2E tests with Cypress", master));
  assert.ok(isVerbatimEvidence("cut flakiness 40%", master));
  assert.ok(isVerbatimEvidence("tests with Cypress and Playwright — cut", master), "em-dash normalizes");
  assert.ok(!isVerbatimEvidence("wrote end-to-end tests using Cypress", master), "paraphrase must fail");
});

test("validate: char budget is 90%–100%", () => {
  assert.equal(checkBudget(100, "x".repeat(100)), "ok");
  assert.equal(checkBudget(100, "x".repeat(95)), "ok");
  assert.equal(checkBudget(100, "x".repeat(90)), "ok");
  assert.equal(checkBudget(100, "x".repeat(101)), "over");
  assert.equal(checkBudget(100, "x".repeat(80)), "short");
});

test("validate: numbers/metrics must be preserved exactly", () => {
  assert.ok(numbersPreserved("cut gen time 67% (15 → 5 min)", "reduced generation time 67% (15 → 5 min)"));
  assert.ok(numbersPreserved("40% to 70% accuracy", "accuracy 70% up from 40%"), "reorder ok");
  assert.ok(!numbersPreserved("cut API calls 60%", "cut API calls 65%"), "changed metric fails");
  assert.ok(!numbersPreserved("cut gen time 67%", "cut gen time"), "dropped metric fails");
});

test("validate: no new tech noun beyond approved respellings", () => {
  const master = "Built apps with React, Node.js, and PostgreSQL. Used Cypress for E2E.";
  const guard = makeNounGuard(master, ["React.js"]);
  assert.deepEqual(guard("Built apps with React.js and Node.js"), [], "respelling target allowed");
  assert.deepEqual(guard("Reordered Node.js and PostgreSQL work"), []);
  assert.deepEqual(guard("Deployed with Kubernetes and GraphQL"), ["kubernetes", "graphql"], "novel tech flagged");
  assert.deepEqual(guard("Improved the checkout flow"), [], "plain prose ok");
});

test("validate: headline must be an allowed title (case/space-insensitive)", () => {
  const titles = ["Frontend Engineer", "Full Stack Engineer"];
  assert.ok(isAllowedTitle("Frontend Engineer", titles));
  assert.ok(isAllowedTitle("frontend  engineer", titles));
  assert.ok(!isAllowedTitle("Staff Engineer", titles));
});

test("validate: validateEdit routes ok / retry / drop", () => {
  const master = "Cut app-generation time 67% by building a React pipeline";
  const guard = makeNounGuard(master, []);
  const unit = { text: master, chars: master.length };
  assert.equal(validateEdit(unit, "Cut app-gen time 67% building a React pipeline", guard).status, "ok");
  assert.equal(validateEdit(unit, "Cut app-generation time 67% by building a huge React pipeline overall now", guard).status, "retry");
  assert.equal(validateEdit(unit, "Cut app-generation time 80% by building a React pipeline", guard).status, "drop");
  assert.equal(validateEdit(unit, "Cut app-gen time 67% via a Kubernetes pipeline", guard).status, "drop");
});

// ── score gate ─────────────────────────────────────────────────────────────────────
test("score: mentions is token-complete and not fooled by dotted compounds", () => {
  assert.ok(mentions("experience with React and Redux", "React"));
  assert.ok(!mentions("experience with React.js only", "React"), "React must not match inside React.js");
  assert.ok(mentions("CI/CD pipelines with Docker", "CI/CD"));
});

test("score: weighted coverage weights title > must-have > other", () => {
  const jd = { exact_title: "Frontend Engineer", must_haves: ["React", "TypeScript"], keywords: ["React", "TypeScript", "Jest", "Redux"] };
  const none = coverageScore("unrelated text", jd);
  assert.equal(none.score, 0);
  assert.equal(none.max, 5 + 3 * 2 + 1 * 2); // title5 + 2 musts×3 + 2 others×1
  const titleOnly = coverageScore("Frontend Engineer", jd);
  assert.equal(titleOnly.score, 5);
  const withMust = coverageScore("Frontend Engineer using React", jd);
  assert.equal(withMust.score, 5 + 3);
});

test("score: gate is monotonic and never serves a worse resume", () => {
  const jd = { exact_title: "Frontend Engineer", must_haves: ["React"], keywords: ["React", "Playwright"] };
  const master = "Software developer skilled in React and Cypress.";
  const tailored = "Frontend Engineer skilled in React and Playwright.";
  const gate = scoreGate(master, tailored, jd);
  assert.equal(gate.serve, "tailored");
  assert.ok(gate.delta > 0);
  // if tailoring somehow lost coverage, master wins
  const worse = scoreGate(master, "Generic developer resume.", jd);
  assert.equal(worse.serve, "master");
});

// ── JD-analysis atomizer (CALL 1 safety net) ─────────────────────────────────────────
test("atomize: splits requirement sentences into atomic search terms", () => {
  assert.deepEqual(atomize(["React.js", "TypeScript"]), ["React.js", "TypeScript"], "clean terms pass through");
  assert.deepEqual(atomize(["4+ years with React.js and TypeScript"]), ["React.js", "TypeScript"]);
  assert.deepEqual(atomize(["CI/CD pipelines, Docker, and deployment on AWS"]), ["CI/CD pipelines", "Docker", "deployment on AWS"]);
  assert.deepEqual(atomize(["Strong experience with Next.js"]), ["Next.js"]);
  assert.deepEqual(atomize(["Redux or Zustand for state management"]), ["Redux", "Zustand"]);
  assert.deepEqual(atomize(["React", "react", "REACT"]), ["React"], "case-insensitive dedupe");
  assert.deepEqual(atomize(["Ability to work in a fast-paced cross-functional agile environment daily"]), [], "sentence-shaped residue dropped");
});

// ── orchestrator (replay: no API calls) ─────────────────────────────────────────────
test("tailorResume: applies valid edits, drops dishonest ones, places additions, inserts headline", { skip: !hasMaster }, async () => {
  const { units } = extractUnits(readDocumentXml(MASTER));
  const goodBullet = units.find((u) => u.kind === "bullet");                 // identity edit → valid
  const numBullet = units.find((u) => u.kind === "bullet" && /\d/.test(u.text)); // number-change → drop
  const badText = numBullet.text.replace(/\d+/, (d) => String(Number(d) + 5)); // mutate first number

  const jd = { exact_title: "Frontend Engineer", must_haves: ["React"], keywords: ["React", "Vitest"], nice_to_haves: [], seniority: "mid", domain: "web" };
  const replay = {
    analysis: jd,
    additions: {
      approved: [{ keyword: "Vitest", evidence: "Jest", tier: "T2" }], // "Jest" is verbatim on the testing line
      respellings: [],
      missing: [{ keyword: "GraphQL", reason: "no-evidence" }],
    },
    tailored: {
      headline: "Frontend Engineer",
      edits: [
        { id: goodBullet.id, new_text: goodBullet.text },  // valid (identity)
        { id: numBullet.id, new_text: badText },            // must be dropped (number changed)
      ],
      bullet_order: {},
      notes: "test",
    },
  };

  const tmpCache = path.join(mkdtempSync(path.join(tmpdir(), "orch-")), "v.json");
  const r = await tailorResume({ jd: "irrelevant (replay)", company: "T", title: "Frontend Engineer", replay, cacheFile: tmpCache });

  assert.equal(r.served, "tailored", "score should not regress");
  assert.equal(r.headline, "Frontend Engineer");
  assert.ok(r.additions.some((a) => a.keyword === "Vitest" && a.placedIn.startsWith("skills.")), "Vitest placed on a skills line");
  assert.ok(r.edits_dropped.some((d) => d.id === numBullet.id && /numbers-changed/.test(d.reason)), "number-changing edit dropped");
  assert.ok(r.keywords_missing.some((m) => m.keyword === "GraphQL"), "missing keywords reported");

  // Prove it on the produced document: headline present, Vitest on a skills line, metric intact.
  const out = extractUnits(readDocumentXml(r.docxPath));
  assert.ok(out.units.some((u) => u.text.trim() === "Frontend Engineer"), "headline paragraph inserted");
  assert.ok(out.units.some((u) => u.kind === "skills" && /Vitest/.test(u.text)), "Vitest written to skills");
  const outNum = out.units.find((u) => u.id === numBullet.id);
  assert.equal(outNum.text, numBullet.text, "dishonest bullet left untouched (original metric preserved)");
  rmSync(path.dirname(tmpCache), { recursive: true, force: true });
});

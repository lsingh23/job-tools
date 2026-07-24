// End-to-end tailoring run (blueprint Part 8 step 6). LIVE — real DeepSeek calls.
//   node --env-file=.env applier/test/e2e.mjs
// Prints the full pipeline result, then re-extracts the produced .docx to prove: exactly one
// page's worth of edits landed, numbers survived, and the headline was inserted.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readDocumentXml, canRenderPdf, docxToPdf, pdfPageCount } from "../docx.mjs";
import { extractUnits } from "../extract.mjs";
import { tailorResume } from "../tailor.mjs";

const cacheFile = path.join(mkdtempSync(path.join(tmpdir(), "e2e-")), "verdicts.json");

const JD = `Senior Frontend Engineer — Fintech

We're hiring a Senior Frontend Engineer to build our trading dashboard. You will own the
React.js frontend end-to-end, working closely with backend and design.

Requirements:
- 4+ years with React.js and TypeScript
- Strong experience with Next.js (App Router) and Redux or Zustand for state management
- End-to-end testing with Playwright
- REST APIs and GraphQL
- CI/CD pipelines, Docker, and deployment on AWS
- Experience with Kubernetes is a plus
- Web accessibility (WCAG) and Core Web Vitals / performance optimization

Nice to have: Node.js, PostgreSQL, WebSockets, multi-tenant architecture, design systems.`;

const t0 = Date.now();
const r = await tailorResume({ jd: JD, company: "TradeCo", title: "Senior Frontend Engineer", cacheFile, onLog: (l) => console.log("  ·", l) });
console.log(`\n── result (${((Date.now() - t0) / 1000).toFixed(1)}s) ──`);
console.log("served      :", r.served);
console.log("headline    :", r.headline ?? (r.headlineOmittedForFit ? "(omitted for one-page fit)" : "(none)"), r.headlineMismatch?.jdTitle ? `[JD wanted "${r.headlineMismatch.jdTitle}"]` : "");
console.log("additions   :", r.additions.map((a) => `+${a.keyword}⟵"${a.evidence.slice(0, 22)}"→${a.placedIn}`).join("  ") || "(none)");
console.log("respellings :", r.respellings.map((s) => `${s.from}→${s.to}`).join("  ") || "(none)");
console.log("edits       :", r.edits_applied, "applied,", r.edits_dropped.length, "dropped", r.edits_dropped.length ? JSON.stringify(r.edits_dropped) : "");
console.log("missing     :", r.keywords_missing.map((m) => `${m.keyword}[${m.reason}]`).join("  ") || "(none)");
console.log("score       :", r.score_master, "→", r.score_tailored);
console.log("notes       :", r.notes);
console.log("file        :", r.filename);

// Post-conditions on the produced document.
const out = extractUnits(readDocumentXml(r.docxPath));
const master = extractUnits(readDocumentXml(process.env.MASTER_RESUME ?? "applier/master-resume.docx"));
console.log("\n── post-conditions ──");
console.log(`  ${out.units.length >= master.units.length ? "✅" : "❌"} no paragraphs lost (${master.units.length} → ${out.units.length})`);
// numbers preserved across every bullet
const num = (s) => (s.match(/\d[\d,.]*%?/g) ?? []).sort().join("|");
const masterNums = master.units.filter((u) => u.kind === "bullet").map((u) => num(u.text)).sort().join("¶");
const outNums = out.units.filter((u) => u.kind === "bullet").map((u) => num(u.text)).sort().join("¶");
console.log(`  ${masterNums === outNums ? "✅" : "❌"} all bullet metrics preserved`);
// hard one-page guarantee (the whole point of the page-fit repair loop)
if (canRenderPdf()) {
  const pages = pdfPageCount(docxToPdf(r.docxPath, path.dirname(r.docxPath)));
  console.log(`  ${pages === 1 ? "✅" : "❌"} rendered PDF is exactly one page (${pages})`);
} else {
  console.log("  ⚠ LibreOffice not found — one-page guarantee not verified");
}

// Gate-0 parseability audit for the MASTER résumé (run once, not per application):
//   node applier/audit-master.mjs
//
// A resume can have perfect keywords and still be invisible if an ATS can't parse it. This
// checks the format rules that actually decide whether the parser reads your resume at all —
// single column, standard headers, contact info in the body (not the ignored header/footer),
// no icons/emojis, and one consistent date format. Prints a pass/fix report and exits non-zero
// if anything fails, so it can gate a build.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MASTER = process.env.MASTER_RESUME ?? path.join(HERE, "master-resume.docx");

/** Unzip the whole docx to a temp dir and return { partName: xmlString }. */
function readParts(docxPath) {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-"));
  try {
    execFileSync("unzip", ["-o", docxPath, "-d", dir], { stdio: "ignore" });
    const wordDir = path.join(dir, "word");
    const parts = {};
    for (const f of existsSync(wordDir) ? readdirSync(wordDir) : []) {
      if (f.endsWith(".xml")) parts[f] = readFileSync(path.join(wordDir, f), "utf8");
    }
    return parts;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const plainText = (xml) =>
  (xml.match(/<w:t[^>]*>[\s\S]*?<\/w:t>/g) ?? [])
    .map((t) => t.replace(/<[^>]+>/g, ""))
    .join("")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

const paras = (xml) =>
  (xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? []).map(plainText).filter((t) => t.trim());

const MONTHS = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?";
const DATE_RANGE = new RegExp(`${MONTHS}\\s+\\d{4}\\s*[–—-]\\s*(${MONTHS}\\s+\\d{4}|Present)`, "i");

function audit(parts) {
  const doc = parts["document.xml"] ?? "";
  const body = paras(doc);
  const bodyText = body.join("\n");
  const findings = [];
  const ok = (name) => findings.push({ pass: true, name });
  const fail = (name, detail) => findings.push({ pass: false, name, detail });

  // 1. Single column / no tables.
  /<w:tbl>/.test(doc) ? fail("single-column", "found a <w:tbl> — tables scramble ATS parsing") : ok("single-column (no tables)");

  // 2. Standard section headers present.
  const upper = new Set(body.map((t) => t.trim().toUpperCase()));
  const need = ["SUMMARY", "SKILLS", "WORK EXPERIENCE", "EDUCATION"];
  const miss = need.filter((h) => ![...upper].some((u) => u.startsWith(h)));
  miss.length ? fail("standard-headers", `missing: ${miss.join(", ")}`) : ok("standard section headers");

  // 3. Contact info in the BODY, not the ignored header/footer.
  const hasEmail = (s) => /[\w.+-]+@[\w-]+\.[\w.-]+/.test(s);
  const hasPhone = (s) => /(\+?\d[\d\s().-]{7,}\d)/.test(s);
  const headerFooter = Object.entries(parts).filter(([n]) => /^(header|footer)\d*\.xml$/.test(n)).map(([, x]) => plainText(x)).join("\n");
  if (hasEmail(bodyText) && hasPhone(bodyText)) ok("contact info in body");
  else if (hasEmail(headerFooter) || hasPhone(headerFooter)) fail("contact-in-body", "contact info is in the header/footer, which most ATS ignore — move it into the body");
  else fail("contact-in-body", "no email+phone found in the document body");

  // 4. No icons / emoji / private-use glyphs in the contact area (first 3 lines).
  const top = body.slice(0, 3).join(" ");
  const bad = [...top].filter((c) => c.codePointAt(0) > 0x2000 && !/[–—’“”]/.test(c));
  bad.length ? fail("no-icons", `non-text glyphs near contact: ${bad.map((c) => "U+" + c.codePointAt(0).toString(16)).join(", ")}`) : ok("no icons/emoji in contact");

  // 5. Consistent Month-Year dates across every role header (a 2+ pipe line) INSIDE the
  //    work-experience section only — the contact line also has pipes but isn't a role.
  const iExp = body.findIndex((t) => /^WORK EXPERIENCE\b/i.test(t.trim()));
  const iEdu = body.findIndex((t) => /^EDUCATION\b/i.test(t.trim()));
  const expBody = iExp >= 0 ? body.slice(iExp + 1, iEdu > iExp ? iEdu : body.length) : [];
  const headers = expBody.filter((t) => (t.match(/\|/g) || []).length >= 2);
  const badDates = headers.filter((h) => !DATE_RANGE.test(h));
  badDates.length
    ? fail("consistent-dates", `role header(s) without a "Mon YYYY – Mon YYYY" range: ${badDates.map((h) => JSON.stringify(h.slice(0, 40))).join("; ")}`)
    : ok(`consistent Month-Year dates (${headers.length} roles)`);

  return findings;
}

if (!existsSync(MASTER)) { console.error(`master resume not found at ${MASTER}`); process.exit(2); }
const findings = audit(readParts(MASTER));
console.log(`\nGate-0 parseability audit — ${path.basename(MASTER)}\n`);
let failed = 0;
for (const f of findings) {
  console.log(`  ${f.pass ? "✅" : "❌"}  ${f.name}${f.pass ? "" : `\n        ↳ ${f.detail}`}`);
  if (!f.pass) failed++;
}
console.log(`\n${failed ? `❌ ${failed} issue(s) — fix before relying on ATS surfacing.` : "✅ All parseability checks passed."}\n`);
process.exit(failed ? 1 : 0);

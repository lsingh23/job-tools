// The losslessness contract of the WYSIWYG editor: a save that changes nothing must leave
// document.xml byte-identical, and a save that changes one span must touch exactly that one
// <w:t> — nothing else in the archive. If either breaks, every saved résumé silently drifts
// away from the master's styling, which is the one thing this editor exists to prevent.
import { renderEditable, applyTextEdits } from "./wysiwyg.mjs";
import { readDocumentXml } from "./docx.mjs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MASTER = process.env.MASTER_RESUME ?? path.join(HERE, "..", "Lakhveer Singh Resume.docx");

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
  if (!ok) { console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`); fail++; } else pass++;
};

if (!existsSync(MASTER)) {
  console.log(`  skip  master résumé not found at ${MASTER}`);
  process.exit(0);
}

const xml = readDocumentXml(MASTER);
const doc = renderEditable(MASTER);

console.log("RENDER");
check("page geometry comes from sectPr, not a guess", doc.page.width > 0 && doc.page.height > 0, true);
const ids = [...doc.html.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);
check("every id is positional p<n>r<n>t<n>", ids.every((i) => /^p\d+r\d+t\d+$/.test(i)), true);
check("ids are unique", new Set(ids).size, ids.length);
check("something is editable", ids.length > 20, true);
// Whitespace-only runs are rendered but not editable (an empty span is an untypeable target).
const editable = [...doc.html.matchAll(/data-id="([^"]+)" contenteditable/g)].length;
check("editable spans are a subset of all spans", editable > 0 && editable <= ids.length, true);
check("no private-use bullet glyph leaks into the HTML",
  [...doc.html].some((c) => c.codePointAt(0) >= 0xe000 && c.codePointAt(0) <= 0xf8ff), false);

console.log("\nROUND TRIP");
check("no edits → byte-identical document.xml", applyTextEdits(MASTER, {}).xml === xml, true);
check("unknown ids are ignored", applyTextEdits(MASTER, { p999r0t0: "x", junk: "y" }).xml === xml, true);

// Pick a real editable id and its current text straight out of the rendered HTML.
const m = /data-id="(p\d+r\d+t\d+)" contenteditable="true"[^>]*>([^<]{8,})</.exec(doc.html);
const id = m[1];
const oldText = m[2].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const one = applyTextEdits(MASTER, { [id]: "SENTINEL" });

console.log("\nONE EDIT");
check("exactly one <w:t> changed", one.changed, 1);
check("the new text is in the document", one.xml.includes("<w:t xml:space=\"preserve\">SENTINEL</w:t>"), true);
check("run and paragraph count are unchanged", [
  (one.xml.match(/<w:r(?:\s[^>]*)?>/g) ?? []).length,
  (one.xml.match(/<w:p(?:\s[^>]*)?>/g) ?? []).length,
], [
  (xml.match(/<w:r(?:\s[^>]*)?>/g) ?? []).length,
  (xml.match(/<w:p(?:\s[^>]*)?>/g) ?? []).length,
]);
// The only difference in the whole file must be that one text node.
const strip = (s) => s.replace(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g, "<T/>");
check("no formatting XML moved", strip(one.xml), strip(xml));
check("writing the same text back is a no-op", applyTextEdits(MASTER, { [id]: oldText }).changed, 0);

// XML-significant characters must survive the trip out to HTML and back in.
const tricky = applyTextEdits(MASTER, { [id]: "R&D <ops> \"quoted\" 'x'" });
check("special characters are escaped, not injected", tricky.xml.includes("R&amp;D &lt;ops&gt;"), true);
check("escaping keeps the document parseable (tag count unchanged)",
  (tricky.xml.match(/</g) ?? []).length, (xml.match(/</g) ?? []).length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

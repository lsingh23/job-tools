// labelFor on markup that is NOT Zoho — the generality check the other fixtures can't give,
// since they're built from one real dump. Guards two ways of inventing a wrong question:
// stealing a neighbour's label, and promoting a slot name ("input-field-2") to a label.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const SRC = new URL("./autofill.user.js", import.meta.url).pathname;

const HTML = `<!doctype html><html><body><form>
  <!-- Greenhouse/Lever shape: a proper <label for>. Nothing else may override it. -->
  <div data-testid="input-field-2"><label for="g1">Why do you want to work here?</label><input id="g1"></div>

  <!-- no label at all, and the data-* names a slot, not a question -->
  <div data-testid="input-field-7"><input id="g2"></div>
  <div data-qa="field_3"><input id="g3"></div>
  <div data-testid="first-name-input"><input id="g4"></div>

  <!-- aria-label wins over everything downstream -->
  <div data-testid="whatever"><input id="g5" aria-label="Expected CTC"></div>

  <!-- a real label in the field's own container is fine -->
  <div class="row"><label for="g6">Notice period</label><input id="g6"></div>

  <!-- placeholder is the last resort, and only when it reads like a question -->
  <div><input id="g7" placeholder="Current company"></div>
  <div><input id="g8" placeholder="MM/DD/YYYY"></div>
</form></body></html>`;

const dom = new JSDOM(HTML, { runScripts: "outside-only", url: "https://boards.greenhouse.io/acme/jobs/1" });
const { window } = dom;
window.Element.prototype.getBoundingClientRect = () => ({ width: 40, height: 20, top: 0, left: 0, right: 40, bottom: 20 });
window.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, (c) => "\\" + c) };
const GM = new Map();
window.GM_getValue = (k, d) => (GM.has(k) ? GM.get(k) : d);
window.GM_setValue = (k, v) => GM.set(k, v);
window.GM_xmlhttpRequest = () => {};

let src = readFileSync(SRC, "utf8");
const tail = src.lastIndexOf("})();");
src = src.slice(0, tail) + `\n  window.__t = { labelFor, dataLabel, meaningful, collectFields };\n` + src.slice(tail);
window.eval(src);
const t = window.__t, $ = (id) => window.document.getElementById(id);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
  if (!ok) { console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`); fail++; } else pass++;
};

console.log("\nLABEL STEALING (the climb must not reach a sibling's label)");
check("a real <label for> is used", t.labelFor($("g1")), "Why do you want to work here?");
check("an unlabelled field does NOT steal the first label in the form", t.labelFor($("g2")), "");
check("  → nor does the next one", t.labelFor($("g3")), "");

console.log("\nSLOT NAMES ARE NOT LABELS");
check('data-testid="input-field-7" yields nothing', t.dataLabel($("g2")), "");
check('data-qa="field_3" yields nothing', t.dataLabel($("g3")), "");
check('data-testid="first-name-input" IS a name', t.dataLabel($("g4")), "first name input");

console.log("\nPRECEDENCE");
check("aria-label beats data-*", t.labelFor($("g5")), "Expected CTC");
check("a label in the field's own container works", t.labelFor($("g6")), "Notice period");
check("placeholder is a last resort", t.labelFor($("g7")), "Current company");
check("a format-mask placeholder is not a label", t.labelFor($("g8")), "");

console.log("\nNET EFFECT");
const labels = t.collectFields().map((f) => f.label).sort();
check("only fields with a real question are collected", labels,
  ["Current company", "Expected CTC", "Notice period", "Why do you want to work here?", "first name input"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

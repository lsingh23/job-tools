// 🔍 Probe + the layout-thrash guard.
//
// Two unrelated-looking things, one cause: to support a flow we haven't seen (LinkedIn Easy
// Apply's modal) we need the REAL markup, and reading the page to get it must never lock the
// tab. grabJd() used to read `innerText` — a forced style+layout flush — once per <div>,
// which on a LinkedIn-sized SPA freezes the whole page. These pin both.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const SRC = new URL("./autofill.user.js", import.meta.url).pathname;

const PAGE = `<!doctype html><html><body>
  <div id="feed">
    <label for="search">Search</label><input id="search" name="q">
    <div class="post">${"feed noise ".repeat(60)}</div>
  </div>
  <div role="dialog" aria-label="Apply to Acme" class="artdeco-modal">
    <h2>Apply to Acme</h2>
    <label for="ph">Mobile phone number</label><input id="ph" name="phone">
    <label for="ex">How many years of React experience do you have?</label>
    <select id="ex" name="years"><option value="">Select an option</option><option value="a">2</option><option value="b">3</option></select>
    <span class="upload-btn">Upload resume</span>
    <input type="file" id="res" name="resume" accept=".pdf,.docx" style="opacity:0;width:1px;height:1px">
    <button aria-label="Continue to next step">Next</button>
    <button aria-label="Review your application" disabled>Review</button>
  </div>
</body></html>`;

const dom = new JSDOM(PAGE, { runScripts: "outside-only", url: "https://www.linkedin.com/jobs/view/123456789" });
const { window } = dom;
window.Element.prototype.getBoundingClientRect = function () {
  const s = this.getAttribute("style") || "";
  return /opacity:0|width:1px|display:none/.test(s) ? { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }
                                                    : { width: 40, height: 20, top: 0, left: 0, right: 40, bottom: 20 };
};
window.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, (c) => "\\" + c) };
const GM = new Map();
window.GM_getValue = (k, d) => (GM.has(k) ? GM.get(k) : d);
window.GM_setValue = (k, v) => GM.set(k, v);
window.GM_xmlhttpRequest = (o) => setTimeout(() => o.onerror && o.onerror({ error: "no server" }), 0);
window.DataTransfer = class { constructor() { const f = []; this.items = { add: (x) => f.push(x) }; this.files = f; } };
Object.defineProperty(window.HTMLInputElement.prototype, "files", {
  configurable: true, get() { return this.__files || []; }, set(v) { this.__files = v; },
});

// jsdom has no innerText (it isn't layout-aware). Model the real thing — including its COST,
// which is the whole point: every read here stands for one forced reflow in a browser.
let innerTextReads = 0;
Object.defineProperty(window.HTMLElement.prototype, "innerText", {
  configurable: true,
  get() { innerTextReads++; return this.textContent; },
});

let src = readFileSync(SRC, "utf8");
const tail = src.lastIndexOf("})();");
src = src.slice(0, tail) + `
  window.__t = { probeSnapshot, grabJd, collectFields, describeEl };
` + src.slice(tail);
window.eval(src);
const t = window.__t;

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
  if (!ok) { console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`); fail++; } else pass++;
};

console.log("\nNO LAYOUT THRASH (the LinkedIn freeze)");
{
  // ~65 elements match the "main, article, section, div" scan in this tiny page; a browser
  // charges one full reflow per innerText read, so the count IS the freeze.
  innerTextReads = 0;
  const jd = t.grabJd();
  check("grabJd reads innerText at most once (the winner), not per element", innerTextReads <= 1, true);
  check("  → and still returns the biggest text block", /feed noise/.test(jd), true);
}

console.log("\nPROBE — structure of the OPEN DIALOG");
const snap = t.probeSnapshot();
check("recognises the modal", snap.dialog && snap.dialog.aria, "Apply to Acme");
check("  → and its heading", snap.dialog.heading, "Apply to Acme");
check("scoped to the dialog — the feed's search box is not in it", snap.inputs.map((i) => i.id).includes("search"), false);
check("  → the modal's inputs are", snap.inputs.map((i) => i.id).sort(), ["ex", "ph", "res"]);
check("captures the select's real options", snap.inputs.find((i) => i.id === "ex").options, ["Select an option", "2", "3"]);
check("captures the step buttons a multi-step flow needs", snap.buttons.map((b) => b.aria), ["Continue to next step", "Review your application"]);
check("  → including which are disabled", snap.buttons.map((b) => !!b.disabled), [false, true]);
check("reports the hidden résumé upload it picked", snap.resume_slot && snap.resume_slot.id, "res");
check("  → with the context text that won it", /upload resume/.test(snap.files[0].context), true);
check("our field model is scoped to the modal too — the feed's search box is left alone",
  snap.fields.map((f) => f.label).sort(), ["How many years of React experience do you have?", "Mobile phone number"]);

console.log("\nPRIVACY — a probe is structure, never answers");
window.document.getElementById("ph").value = "9876500000";
window.document.getElementById("ex").value = "a";
const snap2 = t.probeSnapshot();
const dump = JSON.stringify(snap2);
check("no typed value is in the snapshot", dump.includes("9876500000"), false);
check("  → only the fact that the field is answered", snap2.inputs.find((i) => i.id === "ph").answered, true);
check("  → an empty one reports false", snap2.inputs.find((i) => i.id === "res").answered, false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

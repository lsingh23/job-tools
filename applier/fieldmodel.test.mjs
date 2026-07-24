// Drives the real autofill.user.js field model inside jsdom against an ATS-shaped form.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const SRC = new URL("./autofill.user.js", import.meta.url).pathname;

const FORM = `<!doctype html><html><body><form>
  <label for="fn">First Name</label><input id="fn">
  <label for="em">Email Address *</label><input id="em" type="email">

  <!-- select with a placeholder row, Zoho-style -->
  <label for="np">Notice Period</label>
  <select id="np">
    <option value="">-- Select --</option>
    <option value="o1">Immediate</option>
    <option value="o2">15 Days</option>
    <option value="o3">1 Month</option>
    <option value="o4">2 Months</option>
  </select>

  <!-- radio group: question lives on a legend, options have their own labels -->
  <fieldset>
    <legend>Are you willing to relocate to Bangalore?</legend>
    <label for="r1">Yes</label><input type="radio" id="r1" name="reloc">
    <label for="r2">No</label><input type="radio" id="r2" name="reloc">
  </fieldset>

  <label for="essay">Describe your most impressive project</label><textarea id="essay"></textarea>

  <!-- a lone checkbox and a lone radio: neither is a choice field -->
  <label for="consent">I agree to the terms</label><input type="checkbox" id="consent">
  <label for="solo">Subscribe</label><input type="radio" id="solo" name="sub">

  <button type="submit">Submit Application</button>
</form></body></html>`;

const dom = new JSDOM(FORM, { runScripts: "outside-only", url: "https://wissen.zohorecruit.in/" });
const { window } = dom;

// jsdom has no layout: every rect is 0x0, which visible() rejects. Give elements a size.
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 };
};
window.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, (c) => "\\" + c) };  // jsdom omits it
const GM = new Map();
window.GM_getValue = (k, d) => (GM.has(k) ? GM.get(k) : d);
window.GM_setValue = (k, v) => GM.set(k, v);
window.GM_xmlhttpRequest = () => {};

// The script is an IIFE that exports nothing — inject a test handle before its final `})();`
let src = readFileSync(SRC, "utf8");
const tail = src.lastIndexOf("})();");
src = src.slice(0, tail) + `
  window.__t = { collectFields, readValue, fillField, applyFill, learn, qaGet, factGet, keyFromPatterns, fieldFor, profile: () => profile };
` + src.slice(tail);

window.eval(src);
const t = window.__t;

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
  if (!ok) { console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`); fail++; } else pass++;
};

// ── field discovery ──────────────────────────────────────────────────────────
const fields = t.collectFields();
const byLabel = (s) => fields.find((f) => f.label.includes(s));

console.log("\nDISCOVERY");
check("finds text + textarea + select + radio group", fields.length, 5);
check("text field labelled", byLabel("First Name")?.kind, "text");
check("textarea is a text field", byLabel("impressive")?.kind, "text");
check("select detected as choice", byLabel("Notice Period")?.kind, "select");
check("select placeholder row excluded from options", byLabel("Notice Period")?.options, ["Immediate", "15 Days", "1 Month", "2 Months"]);
check("radio group label comes from the legend, not the option", byLabel("relocate")?.kind, "radio");
check("radio group options are the option labels", byLabel("relocate")?.options, ["Yes", "No"]);
check("lone radio is NOT a choice field", fields.some((f) => f.label === "Subscribe"), false);
check("checkbox is not collected", fields.some((f) => f.label.includes("agree")), false);

// ── reading ──────────────────────────────────────────────────────────────────
console.log("\nREAD");
check("unanswered select reads empty (placeholder selected)", t.readValue(byLabel("Notice Period")), "");
check("unanswered radio group reads empty", t.readValue(byLabel("relocate")), "");
check("unanswered text reads empty", t.readValue(byLabel("First Name")), "");

// ── filling ──────────────────────────────────────────────────────────────────
console.log("\nFILL");
check("select snaps exact option text", t.fillField(byLabel("Notice Period"), "1 Month"), true);
check("  → reads back as option TEXT not value", t.readValue(byLabel("Notice Period")), "1 Month");
check("select snaps a paraphrase ('30 days' → '1 Month' is NOT a match; '2 Month' is)", t.fillField(byLabel("Notice Period"), "2 Month"), true);
check("  → reads back", t.readValue(byLabel("Notice Period")), "2 Months");
check("select rejects an option that doesn't exist", t.fillField(byLabel("Notice Period"), "6 Months"), false);
check("radio picks by label", t.fillField(byLabel("relocate"), "Yes"), true);
check("  → reads back", t.readValue(byLabel("relocate")), "Yes");
check("  → underlying input actually checked", window.document.getElementById("r1").checked, true);
check("radio rejects an unlisted answer", t.fillField(byLabel("relocate"), "Maybe"), false);
check("text fills verbatim", t.fillField(byLabel("First Name"), "Lakhveer"), true);
check("  → reads back", t.readValue(byLabel("First Name")), "Lakhveer");

// The FILL calls above went through fillField directly — i.e. they dispatch input/change
// exactly like a human interacting with the widget, so the live change listener should have
// learned them. That is the "you filled it yourself" path.
console.log("\nLEARN-ON-CHANGE (you interacting with the page)");
check("text you typed was learned via the change event", t.qaGet("First Name"), "Lakhveer");
check("learned Q&A entries are tagged src:user", t.profile().qa.every((x) => x.src === "user"), true);
// Phase 4: a label the FACT_PATTERNS table recognises is stored under its canonical key,
// NOT under the site's wording — so these are deliberately absent from label-keyed Q&A.
check("select → canonical fact, as option TEXT not value id", t.factGet("notice_period"), "2 Months");
check("  → and NOT under the site's label", t.qaGet("Notice Period"), null);
check("radio → canonical fact, as its option label", t.factGet("willing_to_relocate"), "Yes");
check("unmapped label still goes to Q&A", t.keyFromPatterns("First Name"), null);

// ── the provenance gate ──────────────────────────────────────────────────────
// applyFill is what autofill() uses. Its writes must be invisible to the learn hooks.
console.log("\nPROVENANCE (the poisoning fix)");
const essay = byLabel("impressive");
check("applyFill writes the value", t.applyFill(essay, "An LLM guess I never reviewed."), true);
check("  → it landed in the DOM", t.readValue(essay), "An LLM guess I never reviewed.");
check("  → our own change event did NOT learn it", t.qaGet(essay.label), null);
check("  → and learn() refuses it explicitly", t.learn(essay), false);
check("  → nothing resembling it in Q&A", t.profile().qa.some((x) => x.a.includes("LLM guess")), false);

essay.el.value = "Actually, I built the nkparam token minter.";   // you correct it
check("a value YOU changed IS learned", t.learn(essay), true);
check("  → stored", t.qaGet(essay.label), "Actually, I built the nkparam token minter.");
check("re-learning the same value is a no-op", t.learn(essay), false);

// same gate on a choice field (now stored as the canonical fact)
const np = byLabel("Notice Period");
check("applyFill on a select is not learned", t.applyFill(np, "Immediate") && t.learn(np), false);
check("  → the fact still holds YOUR earlier answer", t.factGet("notice_period"), "2 Months");

// a field autofill filled, that you then correct, IS learned
np.el.value = np.el.options[3].value;                             // you pick "1 Month"
check("your correction of an autofilled select IS learned", t.learn(np), true);
check("  → the fact updates to your pick", t.factGet("notice_period"), "1 Month");

// ── fieldFor: blur/change routing ────────────────────────────────────────────
console.log("\nROUTING");
check("fieldFor(radio input) resolves to its GROUP", t.fieldFor(window.document.getElementById("r2"))?.kind, "radio");
check("  → with the group's question label", t.fieldFor(window.document.getElementById("r2"))?.label, "Are you willing to relocate to Bangalore?");
check("fieldFor(select) resolves", t.fieldFor(window.document.getElementById("np"))?.label, "Notice Period");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

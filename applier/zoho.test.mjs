// Zoho Recruit (Lyte). Markup copied verbatim from the live Wissen application form —
// opaque input names, a "₹" <label> on the salary fields, the real field name only in
// data-zcqa, and the required résumé input hidden behind a styled button.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const SRC = new URL("./autofill.user.js", import.meta.url).pathname;

// A Lyte field: wrapper carries data-zcqa; the input's name is a numeric id.
const field = (zcqa, name, label = "") => `
  <div class="cxElementValue">
    <lyte-input lt-prop-name="${name}" class="cxBoxInput lyteInputBox crc-form-textfield mandatoryField" data-zcqa="${zcqa}" lyte-rendered="">
      ${label ? `<label for="" class="lyteLabel ">${label}</label>` : ""}
      <div class="lyteField"><input type="text" value="" id="" name="${name}" maxlength="125" placeholder="" pattern=".+"></div>
    </lyte-input>
  </div>`;

const FORM = `<!doctype html><html><body><form>
  ${field("manual_First_Name", "rec-form_80238000000003149")}
  ${field("manual_Last_Name", "rec-form_80238000000003151")}
  ${field("manual_Email", "rec-form_80238000000003161")}
  ${field("manual_Experience_in_Years", "rec-form_80238000000003155")}
  ${field("manual_Current_Salary", "rec-form_80238000000003199", "₹")}
  ${field("manual_Expected_Salary", "rec-form_80238000000003197", "₹")}
  ${field("manual_Date_of_Birth", "rec-form_80238000000259326", "MM/DD/YYYY")}
  ${field("manual_Notice_Period", "rec-form_80238000031676001")}

  <!-- Zoho's "upload to autofill the form" widget: no label, name says easyresume -->
  <rec-file-upload-component id="rec-easyresume" data-zcqa="easy_apply" lyte-rendered="">
    <div class="cxElementValue crc-other-upload">
      <lyte-fileupload lt-prop-name="rec-easyresume_file" lt-prop-param-name="RESUME" lyte-rendered="">
        <span class="lyteFileUpdMsg">Autofill this form from your resume</span>
        <input type="file" name="rec-easyresume_file" accept="application/pdf,doc,docx,pdf" style="opacity:0;width:1px;height:1px">
      </lyte-fileupload>
    </div>
  </rec-file-upload-component>

  <!-- the REQUIRED résumé field: the one that must carry the submission -->
  <div class="cxElementValue">
    <label for="" class="cxElementLabel">Resume *</label>
    <lyte-fileupload lt-prop-name="rec-form_80238000000017197_file" data-zcqa="manual_Resume" lyte-rendered="">
      <input type="file" name="rec-form_80238000000017197_file" accept="pdf,docx" style="opacity:0;width:1px;height:1px">
    </lyte-fileupload>
  </div>

  <input type="text" name="captcha" placeholder="Type below image text">
</form></body></html>`;

const dom = new JSDOM(FORM, { runScripts: "outside-only", url: "https://wissen.zohorecruit.in/jobs/Careers/80238000198827105/x" });
const { window } = dom;
window.Element.prototype.getBoundingClientRect = function () {
  const s = this.getAttribute("style") || "";
  return /opacity:0|width:1px/.test(s) ? { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }
                                       : { width: 40, height: 20, top: 0, left: 0, right: 40, bottom: 20 };
};
window.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, (c) => "\\" + c) };
const GM = new Map();
window.GM_getValue = (k, d) => (GM.has(k) ? GM.get(k) : d);
window.GM_setValue = (k, v) => GM.set(k, v);
// No applier server in tests: fail the request rather than hanging the caller
// (a stub that never calls back leaves every await on it pending forever).
window.GM_xmlhttpRequest = (o) => setTimeout(() => o.onerror && o.onerror({ error: "no server" }), 0);
window.DataTransfer = class { constructor() { const f = []; this.items = { add: (x) => f.push(x) }; this.files = f; } };
Object.defineProperty(window.HTMLInputElement.prototype, "files", {
  configurable: true, get() { return this.__files || []; }, set(v) { this.__files = v; },
});

let src = readFileSync(SRC, "utf8");
const tail = src.lastIndexOf("})();");
src = src.slice(0, tail) + `
  window.__t = { labelFor, dataLabel, meaningful, collectFields, keyFromPatterns, resumeSlot, resumeScore, fileContext, attachResume, contactGet, looksLikeForm, learn, readValue, profile: () => profile };
` + src.slice(tail);
window.eval(src);
const t = window.__t;

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
  if (!ok) { console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`); fail++; } else pass++;
};
const byName = (n) => window.document.querySelector(`input[name="${n}"]`);

console.log("\nLABELS (was: 7 fields ❌ NONE, two labelled '₹')");
check("opaque-named field resolves via data-zcqa", t.labelFor(byName("rec-form_80238000000003149")), "First Name");
check("last name", t.labelFor(byName("rec-form_80238000000003151")), "Last Name");
check("email", t.labelFor(byName("rec-form_80238000000003161")), "Email");
check("experience", t.labelFor(byName("rec-form_80238000000003155")), "Experience in Years");
check("notice period", t.labelFor(byName("rec-form_80238000031676001")), "Notice Period");
check("'₹' is rejected → real name wins", t.labelFor(byName("rec-form_80238000000003199")), "Current Salary");
check("  → and the OTHER ₹ field is distinct, not a duplicate key", t.labelFor(byName("rec-form_80238000000003197")), "Expected Salary");
check("'MM/DD/YYYY' mask rejected → real name", t.labelFor(byName("rec-form_80238000000259326")), "Date of Birth");
check("'₹' alone is not meaningful", t.meaningful("₹"), false);
check("'None' is not meaningful", t.meaningful("None"), false);
check("'Resume *' IS meaningful", t.meaningful("Resume *"), true);

console.log("\nDISCOVERY");
const fields = t.collectFields();
check("all 8 text fields + captcha are now answerable", fields.length, 9);
check("none are unlabelled", fields.filter((f) => !f.label).length, 0);
check("looksLikeForm now fires (hasName via data-zcqa)", t.looksLikeForm(), true);

console.log("\nCANONICAL FACTS (the ₹ fields are the payoff)");
check("Current Salary → current_ctc", t.keyFromPatterns(t.labelFor(byName("rec-form_80238000000003199"))), "current_ctc");
check("Expected Salary → expected_ctc", t.keyFromPatterns(t.labelFor(byName("rec-form_80238000000003197"))), "expected_ctc");
check("Notice Period → notice_period", t.keyFromPatterns("Notice Period"), "notice_period");
check("Experience in Years → years_experience", t.keyFromPatterns("Experience in Years"), "years_experience");

console.log("\nCONTACT FAST PATH (no LLM)");
// contactGet reads hayOf, which now sees the data-zcqa name.
const prof = { first_name: "Lakhveer", last_name: "Singh", email: "lakhveersingh10599@gmail.com" };
t.profile().contact = prof;
check("first name fills from contact", t.contactGet(byName("rec-form_80238000000003149")), "Lakhveer");
check("last name fills from contact", t.contactGet(byName("rec-form_80238000000003151")), "Singh");
check("email fills from contact", t.contactGet(byName("rec-form_80238000000003161")), "lakhveersingh10599@gmail.com");

console.log("\nRÉSUMÉ SLOT (two file inputs: easyresume vs the required field)");
const easy = byName("rec-easyresume_file"), real = byName("rec-form_80238000000017197_file");
console.log(`       easyresume score=${t.resumeScore(easy)}  ctx=${JSON.stringify(t.fileContext(easy).slice(0, 70))}`);
console.log(`       required   score=${t.resumeScore(real)}  ctx=${JSON.stringify(t.fileContext(real).slice(0, 70))}`);
check("picks the REQUIRED résumé field, not the autofill widget", t.resumeSlot()?.name, "rec-form_80238000000017197_file");

GM.set("jobfill_resume", { name: "Lakhveer Singh - Wissen - 2026-07-16.pdf", type: "application/pdf", b64: btoa("%PDF fake") });
check("attaches", /attached/.test(await t.attachResume()), true);
check("  → onto the required field", real.files.length, 1);
check("  → easyresume widget untouched", easy.files.length, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

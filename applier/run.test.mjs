// The ⚡ Autofill RUN: tailor → review → name → attach → parser → fill.
//
// The order is the whole point. Before this, Autofill attached a stale résumé and filled
// the form; tailoring was a separate button you had to remember to press first. These
// tests pin the sequence: nothing is filled or uploaded until you've reviewed the tailored
// résumé AND given it a name, and the fill pass only starts once the file is on the form.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const SRC = new URL("./autofill.user.js", import.meta.url).pathname;

const FORM = `<!doctype html><html><body><form>
  <label for="fn">First Name</label><input id="fn" name="first_name">
  <label for="ln">Last Name</label><input id="ln" name="last_name">
  <label for="em">Email</label><input id="em" type="email" name="email">
  <label for="np">What is your notice period?</label><input id="np" name="notice">
  <div class="upload-row">
    <span class="btn-text">Attach Resume</span>
    <input type="file" id="resume_file" name="Resume" accept=".pdf,.docx" style="opacity:0;width:1px;height:1px">
  </div>
  <button type="submit">Submit Application</button>
</form></body></html>`;

const JD = "We are hiring a Frontend Engineer to build React interfaces. ".repeat(8);
const PDF_B64 = Buffer.from("%PDF-1.4 fake").toString("base64");

// The fake applier server: records every call so the test can assert what was sent.
const calls = [];
function route(path, body) {
  calls.push({ path, body });
  if (path === "/tailor" || path === "/tailor/preview")
    return {
      exact_title: "Frontend Engineer",
      keywords: [{ term: "React", weight: 3, onResume: true }],
      rows: [{ id: "p1", section: "exp", kind: "text", text: "Built web apps." }],
      edits: [{ id: "p1", old_text: "Built web apps.", new_text: "Built React web apps." }],
      rejected: [],
      pdf_base64: PDF_B64, pages: 1,
    };
  if (path === "/tailor/save")
    return { filename: `${body.filename}.docx`, docx_path: `/x/${body.filename}.docx`, pdf_base64: PDF_B64, pages: 1 };
  if (path === "/answer") return { answers: (body.questions || []).map((q) => `answer:${q.label}`) };
  return { error: `unrouted ${path}` };
}

const dom = new JSDOM(FORM, { runScripts: "outside-only", url: "https://jobs.acme.com/apply/1" });
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
window.GM_xmlhttpRequest = (o) => {
  const path = String(o.url).replace("http://127.0.0.1:8787", "");
  const body = o.data ? JSON.parse(o.data) : {};
  setTimeout(() => o.onload({ status: 200, responseText: JSON.stringify(route(path, body)) }), 0);
};
window.DataTransfer = class { constructor() { const f = []; this.items = { add: (x) => f.push(x) }; this.files = f; } };
Object.defineProperty(window.HTMLInputElement.prototype, "files", {
  configurable: true, get() { return this.__files || []; }, set(v) { this.__files = v; },
});
window.URL.createObjectURL = () => "blob:fake";
window.URL.revokeObjectURL = () => {};

GM.set("jobfill_profile_v4", {
  contact: { first_name: "Lakhveer", last_name: "Singh", full_name: "Lakhveer Singh", email: "l@example.com" },
  resume: "React engineer.", facts: {}, qa: [],
});
GM.set("jobfill_active_jd", { jd: JD, company: "Acme", title: "Frontend Engineer", at: Date.now(), source: "linkedin" });

let src = readFileSync(SRC, "utf8");
const tail = src.lastIndexOf("})();");
src = src.slice(0, tail) + `
  window.__t = { autofill, fillPass, resumeSlot, collectFields, readValue, waitForParser };
` + src.slice(tail);
window.eval(src);
const t = window.__t;

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
  if (!ok) { console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`); fail++; } else pass++;
};
const $ = (sel) => window.document.querySelector(sel);
const val = (id) => window.document.getElementById(id).value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for a condition the script reaches asynchronously (LLM round-trip, parser wait).
async function until(fn, ms = 20000) {
  for (let t = 0; t < ms; t += 50) { if (fn()) return true; await sleep(50); }
  return false;
}

console.log("\nTHE RUN — tailor first, fill last");
t.autofill();

check("review modal opens on the cached JD (no step-1 form)", await until(() => $("#jf-ename")), true);
check("  → nothing uploaded yet", window.document.getElementById("resume_file").files.length, 0);
check("  → and no field filled yet", [val("fn"), val("em"), val("np")], ["", "", ""]);
check("  → /tailor got the CACHED jd, not the page text", calls[0].body.jd.slice(0, 24), JD.slice(0, 24));
check("  → the AI edit is pre-applied for review", $(".jf-row").value, "Built React web apps.");

console.log("\nTHE NAME GATE");
const nameBox = $("#jf-ename"), saveBtn = $("#jf-esave");
check("name is pre-filled from the company", nameBox.value, "Lakhveer Singh Resume - Acme - " + new Date().toLocaleDateString("en-CA"));
check("attach button says what it will do", /continue autofill/.test(saveBtn.textContent), true);
nameBox.value = "";
nameBox.dispatchEvent(new window.Event("input", { bubbles: true }));
check("blank name disables attaching", saveBtn.disabled, true);
nameBox.value = "Lakhveer Singh - Acme - FE";
nameBox.dispatchEvent(new window.Event("input", { bubbles: true }));
check("  → typing one re-enables it", saveBtn.disabled, false);

console.log("\nATTACH → PARSER → FILL");
saveBtn.click();
const slot = window.document.getElementById("resume_file");
check("the résumé lands on the form's upload", await until(() => slot.files.length === 1), true);
check("  → named what YOU typed", slot.files[0] && slot.files[0].name, "Lakhveer Singh - Acme - FE.pdf");
check("  → saved under that name server-side", calls.find((c) => c.path === "/tailor/save").body.filename, "Lakhveer Singh - Acme - FE");
check("  → review modal closes itself", !$("#jf-ename"), true);
check("contact fields fill after the attach", await until(() => val("fn") === "Lakhveer" && val("em") === "l@example.com"), true);
check("  → and the open question goes to the LLM", await until(() => /answer:/.test(val("np"))), true);
check("  → only AFTER the résumé was attached", calls.findIndex((c) => c.path === "/answer") > calls.findIndex((c) => c.path === "/tailor/save"), true);

console.log("\nSECOND CLICK — no re-tailoring on a page already done");
const before = calls.length;
await t.autofill();
check("goes straight to the fill pass", calls.slice(before).some((c) => c.path === "/tailor"), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

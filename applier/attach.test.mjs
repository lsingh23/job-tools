// Phase 3: résumé slot detection + attach + per-site recipe memory.
// The whole point: the real <input type=file> is HIDDEN behind a styled button.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const SRC = new URL("./autofill.user.js", import.meta.url).pathname;

// Zoho-shaped: the input is opacity:0 + 1px, the words live in a sibling <span>,
// there's a second upload for a cover letter, and neither input has a <label for>.
const FORM = `<!doctype html><html><body><form>
  <label for="em">Email</label><input id="em" type="email">

  <div class="upload-row">
    <span class="btn-text">Attach Resume</span>
    <input type="file" id="resume_file" name="Resume" accept=".pdf,.doc,.docx" style="opacity:0;width:1px;height:1px">
  </div>

  <div class="upload-row">
    <span class="btn-text">Upload Cover Letter</span>
    <input type="file" id="cl_file" name="CoverLetter" accept=".pdf" style="opacity:0;width:1px;height:1px">
  </div>

  <button type="submit">Submit Application</button>
</form></body></html>`;

function boot(html, { hidden = [] } = {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://wissen.zohorecruit.in/jobs/Careers/1/x" });
  const { window } = dom;
  // jsdom has no layout. Model reality: elements styled opacity:0/1px report a 1x1 rect,
  // which is exactly what makes visible() reject the real résumé input in a browser.
  window.Element.prototype.getBoundingClientRect = function () {
    const s = this.getAttribute("style") || "";
    const invis = /opacity:0|display:none|width:1px/.test(s) || hidden.includes(this.id);
    return invis ? { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }
                 : { width: 40, height: 20, top: 0, left: 0, right: 40, bottom: 20 };
  };
  window.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, (c) => "\\" + c) };
  const GM = new Map();
  window.GM_getValue = (k, d) => (GM.has(k) ? GM.get(k) : d);
  window.GM_setValue = (k, v) => GM.set(k, v);
  window.GM_xmlhttpRequest = () => {};
  // jsdom has no DataTransfer, and its `files` setter demands a real FileList that can't be
  // constructed outside a browser. Both exist for real in Chrome/Firefox — `el.files =
  // dt.files` is the standard attach trick — so stub them to observe what we assign.
  window.DataTransfer = class { constructor() { const f = []; this.items = { add: (x) => f.push(x) }; this.files = f; } };
  Object.defineProperty(window.HTMLInputElement.prototype, "files", {
    configurable: true,
    get() { return this.__files || []; },
    set(v) { this.__files = v; },
  });

  let src = readFileSync(SRC, "utf8");
  const tail = src.lastIndexOf("})();");
  src = src.slice(0, tail) + `
  window.__t = { resumeSlot, resumeScore, fileContext, attachResume, fileInputs, recipeGet, recipeSetResume, autofill, visible };
` + src.slice(tail);
  window.eval(src);
  return { window, GM, t: window.__t };
}

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
  if (!ok) { console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`); fail++; } else pass++;
};

const RESUME = { name: "Lakhveer Singh - Wissen - 2026-07-16.pdf", type: "application/pdf", b64: btoa("%PDF-1.4 fake") };

// ── the regression that started all this ─────────────────────────────────────
console.log("\nTHE HIDDEN-INPUT REGRESSION");
{
  const { window, t } = boot(FORM);
  const input = window.document.getElementById("resume_file");
  check("the real résumé input IS invisible (visible() rejects it)", t.visible(input), false);
  check("...yet fileInputs() still finds both", t.fileInputs().length, 2);
  check("resumeSlot() picks the résumé input anyway", t.resumeSlot()?.id, "resume_file");
  check("cover-letter input is scored out", t.resumeScore(window.document.getElementById("cl_file")), -1);
  check("context comes from the sibling span, not a <label>", /attach resume/.test(t.fileContext(input)), true);
}

// ── attach ───────────────────────────────────────────────────────────────────
console.log("\nATTACH");
{
  const { window, GM, t } = boot(FORM);
  GM.set("jobfill_resume", RESUME);
  const msg = t.attachResume();
  check("reports the attach", /attached Lakhveer Singh - Wissen/.test(msg), true);
  check("file actually landed on the hidden input", window.document.getElementById("resume_file").files[0].name, RESUME.name);
  check("cover-letter input left alone", window.document.getElementById("cl_file").files.length, 0);
  check("second call is idempotent", t.attachResume(), "📎 already attached");
}
{
  const { t } = boot(FORM);
  check("no cached résumé → honest message, no crash", t.attachResume(), "no résumé cached");
}
{
  const { GM, t } = boot(`<!doctype html><html><body><form><label for="e">Email</label><input id="e"></form></body></html>`);
  GM.set("jobfill_resume", RESUME);
  check("page with no upload → honest message", t.attachResume(), "no upload on this page");
}

// ── the single-upload fallback ───────────────────────────────────────────────
console.log("\nSINGLE-UPLOAD FALLBACK (no 'resume' wording anywhere)");
{
  const { window, GM, t } = boot(`<!doctype html><html><body><form>
    <label for="e">Email</label><input id="e">
    <div><span>Upload your file</span><input type="file" id="only" style="opacity:0;width:1px;height:1px"></div>
  </form></body></html>`);
  GM.set("jobfill_resume", RESUME);
  check("lone unlabelled upload is assumed to be the résumé", t.resumeSlot()?.id, "only");
  check("  → and gets attached", /attached/.test(t.attachResume()), true);
  check("  → file landed", window.document.getElementById("only").files.length, 1);
}
{
  const { t } = boot(`<!doctype html><html><body><form>
    <div><span>Upload file A</span><input type="file" id="a"></div>
    <div><span>Upload file B</span><input type="file" id="b"></div>
  </form></body></html>`);
  check("two ambiguous uploads → refuses to guess", t.resumeSlot(), null);
}

// ── per-site recipe ──────────────────────────────────────────────────────────
console.log("\nPER-SITE RECIPE (learning from your manual attach)");
{
  const { window, GM, t } = boot(FORM);
  const cl = window.document.getElementById("cl_file");
  check("nothing remembered for this origin yet", t.recipeGet(), null);

  // You attach by hand to the control the scorer would NOT have picked.
  const odd = window.document.getElementById("resume_file");
  odd.setAttribute("name", "Attachment_1");            // rename so scoring can't find it
  t.recipeSetResume(odd);
  const rec = t.recipeGet();
  check("recipe stored under this origin", !!rec?.resume, true);
  check("  → fingerprinted by name", rec.resume.name, "Attachment_1");
  check("  → and by context text", /attach resume/.test(rec.resume.ctx), true);

  check("recipe is keyed to the origin", Object.keys(GM.get("jobfill_recipes_v1")), ["https://wissen.zohorecruit.in"]);
}
{
  // A site where the wording gives NOTHING away, but you taught it last visit.
  const html = `<!doctype html><html><body><form>
    <div><span>Document A</span><input type="file" name="doc_a"></div>
    <div><span>Document B</span><input type="file" name="doc_b"></div>
  </form></body></html>`;
  const { window, GM, t } = boot(html);
  check("cold: ambiguous, refuses to guess", t.resumeSlot(), null);

  t.recipeSetResume(window.document.querySelector('[name="doc_b"]'));   // you attach to B by hand
  check("warm: recipe picks YOUR control, no scoring", t.resumeSlot()?.name, "doc_b");

  GM.set("jobfill_resume", RESUME);
  check("  → and attaches to it", /attached/.test(t.attachResume()), true);
  check("  → on doc_b, not doc_a", window.document.querySelector('[name="doc_b"]').files.length, 1);
  check("  → doc_a untouched", window.document.querySelector('[name="doc_a"]').files.length, 0);
}

// ── the provenance gate on recipes ───────────────────────────────────────────
console.log("\nPROVENANCE (our own attach must not teach the recipe)");
{
  const { GM, t } = boot(FORM);
  GM.set("jobfill_resume", RESUME);
  t.attachResume();                                    // autofill attaches — a GUESS
  check("our own attach did NOT write a recipe", t.recipeGet(), null);
}
{
  const { window, GM, t } = boot(FORM);
  GM.set("jobfill_resume", RESUME);
  // You attaching by hand = a real change event we didn't cause.
  const cl = window.document.getElementById("cl_file");
  const ev = new window.Event("change", { bubbles: true });
  cl.files = [{ name: "cover.pdf" }];
  cl.dispatchEvent(ev);
  check("your manual attach to a COVER LETTER is not learned as the résumé slot", t.recipeGet(), null);

  const rf = window.document.getElementById("resume_file");
  rf.files = [{ name: "mine.pdf" }];
  rf.dispatchEvent(new window.Event("change", { bubbles: true }));
  check("your manual attach to the résumé slot IS learned", t.recipeGet()?.resume?.name, "Resume");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

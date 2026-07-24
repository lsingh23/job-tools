// Phase 4: canonical facts. The whole claim is cross-site transfer — learn it once, on any
// wording, and a different site asking differently fills with no LLM call.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const SRC = new URL("./autofill.user.js", import.meta.url).pathname;

function boot(html, { url = "https://a.example.com/apply", store = new Map() } = {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url });
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 40, height: 20, top: 0, left: 0, right: 40, bottom: 20 });
  window.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, (c) => "\\" + c) };
  window.GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
  window.GM_setValue = (k, v) => store.set(k, v);
  window.GM_xmlhttpRequest = () => {};
  let src = readFileSync(SRC, "utf8");
  const tail = src.lastIndexOf("})();");
  src = src.slice(0, tail) + `
  window.__t = { keyFromPatterns, factGet, factPut, qaGet, learn, collectFields, readValue, applyFill, autofill, profile: () => profile };
` + src.slice(tail);
  window.eval(src);
  return { window, store, t: window.__t };
}

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
  if (!ok) { console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`); fail++; } else pass++;
};
const form = (label, id = "f") => `<!doctype html><html><body><form><label for="${id}">${label}</label><input id="${id}"></form></body></html>`;

// ── the table ────────────────────────────────────────────────────────────────
console.log("\nLABEL → CANONICAL KEY");
{
  const { t } = boot(form("x"));
  const cases = [
    ["Notice Period", "notice_period"],
    ["Notice period (in days)", "notice_period"],
    ["When can you join?", "notice_period"],
    ["How soon can you start?", "notice_period"],
    ["Current CTC", "current_ctc"],
    ["Present Salary", "current_ctc"],
    ["Current CTC (in LPA) *", "current_ctc"],
    ["Expected CTC", "expected_ctc"],
    ["Salary expectations", "expected_ctc"],
    ["Total Experience", "years_experience"],
    ["Years of experience", "years_experience"],
    ["Current Company", "current_company"],
    ["Present employer", "current_company"],
    ["Are you willing to relocate to Bangalore?", "willing_to_relocate"],
    ["Do you require visa sponsorship?", "visa_sponsorship"],
    ["Highest Qualification", "highest_education"],
    ["Year of passing", "graduation_year"],
    ["How did you hear about us?", "referral_source"],
    ["Describe your most impressive project", null],   // job-ish essay — no key, stays in Q&A
    ["Why do you want to work here?", null],
  ];
  for (const [label, key] of cases) check(`${JSON.stringify(label).padEnd(45)} → ${key}`, t.keyFromPatterns(label), key);

  // the ordering trap the comment warns about
  check("expected CTC does NOT collide with current CTC", t.keyFromPatterns("Expected CTC"), "expected_ctc");
}

// ── the actual claim: cross-site transfer ────────────────────────────────────
console.log("\nCROSS-SITE TRANSFER (the point of the whole phase)");
{
  const store = new Map();
  // Site A asks one way; you type the answer.
  {
    const { window, t } = boot(form("Notice Period"), { url: "https://a.example.com/apply", store });
    window.document.getElementById("f").value = "30 days";
    check("site A: your answer is learned", t.learn(t.collectFields()[0]), true);
    check("  → stored under the canonical key, not the label", t.profile().facts.notice_period.v, "30 days");
    check("  → nothing added to label-keyed Q&A", t.profile().qa.length, 0);
  }
  // Site B — different origin, different wording, never seen before.
  {
    const { window, t } = boot(form("When can you join?"), { url: "https://b.other-ats.io/careers", store });
    check("site B: the fact is already known", t.factGet("notice_period"), "30 days");
    const f = t.collectFields()[0];
    check("  → and its differently-worded field maps to the same key", t.keyFromPatterns(f.label), "notice_period");
    t.applyFill(f, t.factGet(t.keyFromPatterns(f.label)));
    check("  → so it fills with no LLM call", window.document.getElementById("f").value, "30 days");
  }
}

// ── correct once, fixed everywhere ───────────────────────────────────────────
console.log("\nCORRECT ONCE, FIXED EVERYWHERE");
{
  const store = new Map();
  {
    const { window, t } = boot(form("Notice Period"), { store });
    window.document.getElementById("f").value = "30 days";
    t.learn(t.collectFields()[0]);
  }
  {
    // Months later, on a third site with yet another wording, you correct it.
    const { window, t } = boot(form("Joining time"), { url: "https://c.ats.com/x", store });
    window.document.getElementById("f").value = "15 days";
    check("your correction is learned", t.learn(t.collectFields()[0]), true);
    check("  → it OVERWRITES the one fact, no duplicate", Object.keys(t.profile().facts), ["notice_period"]);
    check("  → new value", t.profile().facts.notice_period.v, "15 days");
  }
  {
    const { t } = boot(form("Notice period (in days)"), { url: "https://a.example.com/apply", store });
    check("back on site A: the ORIGINAL wording now yields the corrected value", t.factGet("notice_period"), "15 days");
  }
}

// ── unmapped labels still work exactly as before ─────────────────────────────
console.log("\nNO REGRESSION FOR UNMAPPED LABELS");
{
  const store = new Map();
  const { window, t } = boot(form("Describe your most impressive project"), { store });
  window.document.getElementById("f").value = "I built a Kafka pipeline.";
  check("unmapped label is learned", t.learn(t.collectFields()[0]), true);
  check("  → into label-keyed Q&A, as before", t.qaGet("Describe your most impressive project"), "I built a Kafka pipeline.");
  check("  → and NOT invented as a fact", Object.keys(t.profile().facts), []);
}

// ── migration of an existing Q&A pile ────────────────────────────────────────
console.log("\nMIGRATION (your existing Q&A collapses)");
{
  const store = new Map();
  store.set("jobfill_profile_v4", {
    contact: {}, resume: "", qa: [
      { q: "Notice Period", a: "60 days", src: "user" },            // older
      { q: "Notice period (in days)", a: "30 days", src: "user" },  // newer — should win
      { q: "When can you join?", a: "30 days", src: "user" },       // newest
      { q: "Current CTC", a: "24 LPA", src: "user" },
      { q: "Describe your proudest work", a: "The pipeline.", src: "user" },
    ],
  });
  const { t } = boot(form("x"), { store });
  check("three notice-period duplicates collapse to one fact", t.factGet("notice_period"), "30 days");
  check("current CTC folded too", t.factGet("current_ctc"), "24 LPA");
  check("5 Q&A entries → 2 facts", Object.keys(t.profile().facts).sort(), ["current_ctc", "notice_period"]);
  check("unmappable essay stays in Q&A", t.qaGet("Describe your proudest work"), "The pipeline.");
  check("  → and it's the ONLY thing left there", t.profile().qa.length, 1);

  // idempotent
  const { t: t2 } = boot(form("x"), { store });
  check("re-running migration is a no-op", t2.profile().qa.length, 1);
  check("  → facts unchanged", t2.factGet("notice_period"), "30 days");
}

// ── provenance still holds ───────────────────────────────────────────────────
console.log("\nPROVENANCE (unchanged by phase 4)");
{
  const store = new Map();
  const { t } = boot(form("Notice Period"), { store });
  const f = t.collectFields()[0];
  t.applyFill(f, "90 days");                              // an LLM guess
  check("autofilled fact is NOT learned", t.learn(f), false);
  check("  → no fact written", t.profile().facts.notice_period, undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

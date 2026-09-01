// ==UserScript==
// @name         Job Autofill — LLM (universal)
// @namespace    lakhveer.job-tools
// @version      6.8
// @description  Works on ANY ATS with no per-site setup. One knowledge base (résumé + contact
//               + Q&A). Each field — text, textarea, dropdown or radio group: exact Q&A match →
//               fill instantly; else the local LLM answers it by meaning, picking from the
//               field's real options for choices. Learns only the answers YOU author (its own
//               guesses are never fed back), on blur, on change, and on submit. Finds the
//               résumé upload even when it's hidden behind a styled button, and remembers
//               per-site which control that was once you attach one by hand.
//               Tailor résumé: one DeepSeek call proposes text-only paragraph
//               edits to your master (styling never touched), applied losslessly into the styled
//               .docx and shown as a live PDF preview with changed lines highlighted. You correct
//               anything, watch the preview update, then Save & Attach — a clean .docx lands in
//               applier/tailored/ and the clean PDF is cached for Autofill to attach. Learns Q&A.
//               ⚡ Autofill runs the WHOLE apply sequence in the order a human does it: tailor to
//               the cached JD → you review and name it → Attach uploads the PDF → wait for the
//               site's résumé parser → fill every field it left empty. When an apply MODAL is
//               open (LinkedIn Easy Apply, overlay ATSs) that modal is the form — the page
//               behind it is never filled. 🔍 Probe dumps a form's STRUCTURE (never your
//               answers) to applier/probes/ so an unsupported flow can be built against real
//               markup. Page reads are layout-free: innerText per element froze LinkedIn.
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const SERVER = "http://127.0.0.1:8787";   // applier/server.mjs

  // The ENTIRE knowledge base. Edit via ⚙ (paste your résumé text + Q&A there).
  const DEFAULT_PROFILE = {
    contact: {
      first_name: "", last_name: "", full_name: "", email: "", phone: "",
      linkedin: "", github: "", portfolio: "", location: "", city: "", country: "",
    },
    resume: "",                 // paste full résumé text
    facts: {},                  // {canonical_key: {v, label, at}} — the cross-site memory
    qa: [],                     // [{q, a}] — labels no FACT_PATTERN maps; grows as you correct
  };

  const G = {
    get: (k, d) => (typeof GM_getValue === "function" ? GM_getValue(k, d) : JSON.parse(localStorage.getItem(k) || "null") ?? d),
    set: (k, v) => (typeof GM_setValue === "function" ? GM_setValue(k, v) : localStorage.setItem(k, JSON.stringify(v))),
  };
  let profile = Object.assign({}, DEFAULT_PROFILE, G.get("jobfill_profile_v4", {}));
  profile.contact = Object.assign({}, DEFAULT_PROFILE.contact, profile.contact || {});
  profile.qa = Array.isArray(profile.qa) ? profile.qa : [];
  const saveProfile = () => G.set("jobfill_profile_v4", profile);

  // ── helpers ──────────────────────────────────────────────────────────────────
  const txt = (el) => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0" && (r.width > 0 || r.height > 0);
  };
  const norm = (s) => (s || "").toLowerCase().replace(/\*/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  // A label must actually ask something. A currency mark, a format mask or bare punctuation
  // is decoration, not a question — Zoho labels both its salary inputs "₹" — and taking one
  // as the question yields a meaningless prompt AND a junk Q&A key that two different fields
  // then share and clobber. Being present is not the same as being a label.
  const JUNK_LABEL = /^(?:[^a-z0-9]*|none|n\/?a|select|choose|optional|required|mm[^a-z]*dd[^a-z]*yyyy|dd[^a-z]*mm[^a-z]*yyyy|yyyy[^a-z]*mm[^a-z]*dd)$/i;
  const meaningful = (t) => { const s = (t || "").trim(); return !!s && /[a-z]/i.test(s) && !JUNK_LABEL.test(s); };

  // Frameworks that render their own inputs often leave the human field name in a data-*
  // attribute on the wrapper while the <input> itself gets an opaque generated name — Zoho
  // marks <lyte-input> data-zcqa="manual_First_Name" but names the input
  // "rec-form_80238000000003149". Read it only when it reads like a name, never an id.
  const DATA_LABEL_ATTRS = ["data-zcqa", "data-qa", "data-testid", "data-test", "data-field", "data-name"];
  // Plenty of these name a SLOT rather than a question — data-testid="input-field-2",
  // data-qa="field_3". Turning those into "field 2" would hand the model a meaningless
  // question and learn it under a junk key. Better to yield nothing and let the field be
  // skipped than to invent a label.
  const GENERIC_DATA_LABEL = /^(?:field|input|value|text|box|control|element|item|row|col|cell|section|group)?[ _-]*\d*$/i;
  function dataLabel(el) {
    for (let node = el, i = 0; node && node.getAttribute && i < 4; node = node.parentElement, i++) {
      for (const a of DATA_LABEL_ATTRS) {
        const v = node.getAttribute(a);
        if (!v) continue;
        const t = v.replace(/^(manual|form|field|input)[_-]/i, "").replace(/[_-]+/g, " ").trim();
        if (/[a-z]{2}/i.test(t) && !GENERIC_DATA_LABEL.test(t)) return t;
      }
    }
    return "";
  }

  // Ordered guesses at the question this field asks; labelFor takes the first meaningful one.
  function* labelCandidates(el) {
    if (el.id) yield txt(document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
    const lb = el.getAttribute("aria-labelledby");
    if (lb) yield lb.split(/\s+/).map((id) => txt(document.getElementById(id))).filter(Boolean).join(" ");
    yield (el.getAttribute("aria-label") || "").trim();
    const wrap = el.closest("label");
    if (wrap) yield txt(wrap);
    let node = el;
    for (let i = 0; i < 4 && node.parentElement; i++) {
      node = node.parentElement;
      // Stop at any container holding another field: past that point querySelector returns
      // the first label in the whole subtree, which may belong to a sibling — that's how an
      // unlabelled input silently answers its neighbour's question. Same rule as
      // fileContext, and the reason a bare climb can't be trusted at <form> level.
      if (node.querySelectorAll("input, textarea, select").length > 1) break;
      const cand = node.querySelector('label, legend, [class*="label" i]');
      if (cand && !cand.contains(el)) yield txt(cand);
    }
    yield dataLabel(el);          // opaque name + junk <label> → the wrapper still knows
    yield el.placeholder || "";   // last resort: a hint, not a question
  }
  function labelFor(el) {
    for (const t of labelCandidates(el)) if (meaningful(t)) return t;
    return "";
  }
  const hayOf = (el) => norm([labelFor(el), el.name, el.id].join(" "));
  function setValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  // Any of these marks a modal; Easy Apply is `[role=dialog]` inside `.artdeco-modal`.
  const DIALOG_SEL = '[role="dialog"], dialog, .artdeco-modal, [aria-modal="true"]';
  const mark = (el, c, title) => { el.style.outline = `2px solid ${c}`; el.style.outlineOffset = "1px"; if (title) el.title = title; };

  // True while WE are writing to the page. Every auto-write holds this across the whole
  // operation so the input/change events it dispatches — indistinguishable from your
  // typing — can't re-enter the learn hooks and teach us our own output. See applyFill(),
  // attachResume(), and the learn listeners near the bottom.
  let filling = false;

  const qaGet = (label) => { const k = norm(label); const hit = profile.qa.find((x) => norm(x.q) === k); return hit ? hit.a : null; };
  // Only ever called for values YOU authored — see learn(). src marks that provenance so a
  // later pass can tell verified facts from anything else that finds its way in here.
  function qaPut(label, ans) {
    const k = norm(label);
    profile.qa = profile.qa.filter((x) => norm(x.q) !== k);
    profile.qa.push({ q: label, a: ans, src: "user" });
    saveProfile();
  }

  // ── canonical facts: the cross-site memory ────────────────────────────────────
  // One entry per durable FACT ("notice_period"), not one per label. Every wording of the
  // same question collapses onto one key, so correcting it once fixes every site that asks
  // — and the prompt carries one line instead of a pile of near-duplicates.
  //
  // The label → key mapping is a table on purpose, not a model call. A model would name the
  // same fact notice_period on one site and joining_notice on the next, which recreates the
  // duplicates this exists to kill. A regex converges by construction, costs nothing, and is
  // testable. A label that matches nothing falls through to label-keyed Q&A — i.e. exactly
  // today's behaviour, no regression.
  //
  // Order matters: specific before generic (expected CTC before CTC).
  const FACT_PATTERNS = [
    [/\bnotice period\b|\bwhen can you (join|start)\b|\bhow soon can you (join|start)\b|\bjoining time\b|\bavailability to join\b/, "notice_period"],
    [/\bexpected\b.*\b(ctc|salary|compensation|pay)\b|\bsalary expectation/, "expected_ctc"],
    [/\b(current|present)\b.*\b(ctc|salary|compensation)\b|\bcurrent pay\b/, "current_ctc"],
    [/\b(total|years of|overall)\b.*\bexperience\b|\bexperience\b.*\b(in years|years)\b/, "years_experience"],
    [/\b(current|present|latest)\b.*\b(company|employer|organisation|organization)\b/, "current_company"],
    [/\b(current|present|latest)\b.*\b(designation|job title|role)\b/, "current_title"],
    [/\b(willing|open) to relocate\b|\brelocat/, "willing_to_relocate"],
    [/\b(require|need)\b.*\b(sponsorship|visa)\b|\bvisa sponsorship\b/, "visa_sponsorship"],
    [/\b(authori[sz]ed|eligible|right) to work\b|\bwork authori[sz]ation\b/, "work_authorization"],
    [/\bearliest start date\b|\bavailable from\b|\bstart date\b/, "earliest_start_date"],
    [/\bnotice buyout\b|\bbuyout\b/, "notice_buyout"],
    [/\bhighest\b.*\b(qualification|education|degree)\b/, "highest_education"],
    [/\bgraduation year\b|\byear of (graduation|passing)\b/, "graduation_year"],
    [/\bhow did you (hear|find|learn)\b|\breferral source\b|\bsource\b.*\bapplication\b/, "referral_source"],
    [/\b(gender|sex)\b/, "gender"],
    [/\bdate of birth\b|\bdob\b/, "date_of_birth"],
    [/\bnationality\b/, "nationality"],
  ];
  const keyFromPatterns = (label) => {
    const hay = norm(label);
    for (const [re, key] of FACT_PATTERNS) if (re.test(hay)) return key;
    return null;
  };

  profile.facts = profile.facts && typeof profile.facts === "object" ? profile.facts : {};
  const factGet = (key) => (key && profile.facts[key] ? profile.facts[key].v : null);
  function factPut(key, v, label) {
    if (!key) return;
    profile.facts[key] = { v, label: label || "", at: Date.now() };
    saveProfile();
  }
  function qaDel(label) {
    const k = norm(label);
    const before = profile.qa.length;
    profile.qa = profile.qa.filter((x) => norm(x.q) !== k);
    if (profile.qa.length !== before) saveProfile();
  }

  // Fold the existing label-keyed pile into canonical facts, so an established Q&A list
  // collapses instead of sitting alongside the new store. Idempotent: once folded, the
  // mappable entries are gone and later loads are a no-op.
  (function migrateQaToFacts() {
    const fold = new Map();                          // key → most recent legacy answer
    for (const e of profile.qa) {
      const key = keyFromPatterns(e.q);
      if (key) fold.set(key, e);                     // qaPut appends, so later entries win
    }
    if (!fold.size) return;
    for (const [key, e] of fold) if (!profile.facts[key]) profile.facts[key] = { v: e.a, label: e.q, at: Date.now() };
    profile.qa = profile.qa.filter((e) => !keyFromPatterns(e.q));
    saveProfile();
  })();

  // fast, no-LLM matcher for the contact fields nearly every ATS asks for.
  // Order matters: more specific patterns (last/first name) before generic ones (full name).
  const CONTACT_PATTERNS = [
    [/\bemail\b/, "email"],
    [/\bphone\b|\bmobile\b|\btelephone\b|\bcontact number\b/, "phone"],
    [/\blast name\b|\bsurname\b|\bfamily name\b/, "last_name"],
    [/\bfirst name\b|\bgiven name\b/, "first_name"],
    [/\bfull name\b|\byour name\b/, "full_name"],
    [/\blinkedin\b/, "linkedin"],
    [/\bgithub\b/, "github"],
    [/\bportfolio\b|\bpersonal website\b/, "portfolio"],
    [/\bpin ?code\b|\bzip ?code\b|\bpostal ?code\b/, "pin code"],
    [/\baddress\b/, "address"],
    [/\bcountry\b/, "country"],
    [/\bcity\b/, "city"],
    [/\blocation\b/, "location"],
  ];
  function contactGet(el) {
    const hay = hayOf(el);
    for (const [re, key] of CONTACT_PATTERNS) {
      if (re.test(hay) && profile.contact[key]) return profile.contact[key];
    }
    return null;
  }

  // ── the field model ───────────────────────────────────────────────────────────
  // A "field" is one answerable question, not one DOM node: a text input, a textarea, a
  // <select>, or an entire radio group (every input sharing a name). Choice fields carry
  // their real option texts, read out of the page, so the LLM picks something that
  // actually exists instead of emitting a string no option would ever match.
  const OPTION_NOISE = /^(select|choose|pick|please select|none|n\/?a|-+)\b/i;

  const selectOptions = (el) =>
    [...el.options].filter((o) => o.value !== "" && !OPTION_NOISE.test(txt(o))).map((o) => txt(o)).filter(Boolean);

  function isTextField(el) {
    const type = (el.type || "").toLowerCase();
    if (["hidden", "submit", "button", "reset", "image", "checkbox", "radio", "file"].includes(type)) return false;
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA";
  }

  // The question a radio group asks — NOT labelFor(firstRadio), which yields that one
  // option's text ("Yes"). Climb to the group's common ancestor and take the first
  // label-ish text that isn't simply one of the option labels.
  function groupLabel(els) {
    const own = new Set(els.map((e) => norm(labelFor(e))));
    let node = els[0];
    for (let i = 0; i < 6 && node.parentElement; i++) {
      node = node.parentElement;
      if (!els.every((e) => node.contains(e))) continue;
      for (const c of node.querySelectorAll('legend, label, [class*="label" i], [class*="question" i]')) {
        const t = txt(c);
        if (t && !own.has(norm(t))) return t;
      }
    }
    return els[0].name || "";
  }

  // Where the form we're working on lives. An apply flow rendered in a modal — LinkedIn
  // Easy Apply, iCIMS/Greenhouse overlays — sits on top of a page that is itself full of
  // controls (a search box, a newsletter signup, the feed). Filling those is wrong and
  // visibly weird, so once a real form modal is open it becomes the root and nothing
  // outside it is touched. "Real" means it actually holds controls: cookie banners and
  // toasts are dialogs too, and scoping into one of those would blind us to the whole page.
  function formRoot() {
    const dialogs = [...document.querySelectorAll(DIALOG_SEL)].filter(visible);
    for (let i = dialogs.length - 1; i >= 0; i--) {                     // topmost first
      const d = dialogs[i];
      if (d.querySelectorAll("input, textarea, select").length >= 2) return d;
    }
    return document;
  }

  function collectFields() {
    const all = [...formRoot().querySelectorAll("input, textarea, select")].filter(visible);
    const fields = [], radios = new Map();
    for (const el of all) {
      if ((el.type || "").toLowerCase() === "radio") {
        const key = el.name || norm(labelFor(el));
        if (!key) continue;
        if (!radios.has(key)) radios.set(key, []);
        radios.get(key).push(el);
        continue;
      }
      const label = labelFor(el);
      if (!label) continue;
      if (el.tagName === "SELECT") {
        const options = selectOptions(el);
        if (options.length) fields.push({ kind: "select", el, els: [el], label, options });
      } else if (isTextField(el)) {
        fields.push({ kind: "text", el, els: [el], label, options: [] });
      }
    }
    for (const els of radios.values()) {
      if (els.length < 2) continue;                    // a lone radio is a toggle, not a choice
      const label = groupLabel(els);
      const options = els.map((e) => labelFor(e)).filter(Boolean);
      if (label && options.length === els.length) fields.push({ kind: "radio", el: els[0], els, label, options });
    }
    return fields;
  }

  // The field's current answer in the same vocabulary we'd learn it in: option TEXT for
  // choices (never option.value — those are site-local ids like "opt_38472" and would
  // never transfer to another ATS). "" means genuinely unanswered.
  function readValue(f) {
    if (f.kind === "select") {
      const o = f.el.options[f.el.selectedIndex];
      return !o || o.value === "" || OPTION_NOISE.test(txt(o)) ? "" : txt(o);
    }
    if (f.kind === "radio") { const on = f.els.find((e) => e.checked); return on ? labelFor(on) : ""; }
    return (f.el.value || "").trim();
  }

  // Text goes in verbatim; a choice answer is snapped onto the option it names. Returns
  // false when nothing matched, so the caller can flag the field instead of pretending.
  function fillField(f, value) {
    if (f.kind === "text") { setValue(f.el, value); return true; }
    const want = norm(value);
    const near = (t) => norm(t) && (norm(t).includes(want) || want.includes(norm(t)));
    if (f.kind === "select") {
      const opt = [...f.el.options].find((o) => norm(txt(o)) === want) || [...f.el.options].find((o) => o.value !== "" && near(txt(o)));
      if (!opt) return false;
      setValue(f.el, opt.value);
      return true;
    }
    if (f.kind === "radio") {
      const hit = f.els.find((e) => norm(labelFor(e)) === want) || f.els.find((e) => near(labelFor(e)));
      if (!hit) return false;
      hit.click();
      if (!hit.checked) { hit.checked = true; hit.dispatchEvent(new Event("change", { bubbles: true })); }
      return true;
    }
    return false;
  }

  const fieldFor = (el) => collectFields().find((f) => f.els.includes(el));

  // ── résumé caching + attach ───────────────────────────────────────────────────
  const toB64 = (buf) => { let b = ""; const u = new Uint8Array(buf), c = 0x8000; for (let i = 0; i < u.length; i += c) b += String.fromCharCode.apply(null, u.subarray(i, i + c)); return btoa(b); };
  function pickResume() {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".pdf,.doc,.docx";
    inp.onchange = async () => { const f = inp.files[0]; if (!f) return; G.set("jobfill_resume", { name: f.name, type: f.type || "application/pdf", b64: toB64(await f.arrayBuffer()) }); setStatus("résumé cached: " + f.name); };
    inp.click();
  }
  const recToFile = (r) => {
    const bin = atob(r.b64), arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], r.name, { type: r.type });
  };
  function resumeFile() {
    const r = G.get("jobfill_resume", null); if (!r) return null;
    return recToFile(r);
  }
  // No tailored/cached résumé → fall back to the default un-tailored PDF the server holds on disk.
  async function defaultResumeFile() {
    const r = await getJSON("/default-resume");
    if (!r || r.error || !r.b64) return null;
    return recToFile(r);
  }
  function attachFile(el, file) { const dt = new DataTransfer(); dt.items.add(file); el.files = dt.files; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }

  // ── which upload is the résumé ────────────────────────────────────────────────
  // The real <input type=file> is nearly always HIDDEN behind a styled button (opacity:0,
  // display:none, or 1×1 px), so it must NOT be filtered through visible() the way
  // answerable fields are — doing that is why attaching silently never happened. A hidden
  // input also rarely has a <label>: the words "Attach Resume" live in a sibling <span>.
  // So score each file input on the text AROUND it, not on its own label.
  const fileInputs = () => [...formRoot().querySelectorAll('input[type="file"]')].filter((el) => !el.disabled);

  // The text a human would read as belonging to THIS upload control. Stop climbing at any
  // ancestor holding another file input: past that point we'd blend a neighbouring
  // control's wording into ours, and "Attach Resume" sitting next to "Upload Cover Letter"
  // would read as a cover letter and disqualify itself.
  function fileContext(el) {
    const bits = [labelFor(el), el.name, el.id, el.getAttribute("accept") || "", el.className];
    let node = el;
    for (let i = 0; i < 4 && node.parentElement; i++) {
      node = node.parentElement;
      if (node.querySelectorAll('input[type="file"]').length > 1) break;
      const t = txt(node);
      if (t) bits.push(t.slice(0, 200));
    }
    return norm(bits.join(" "));
  }

  const RESUME_RE = /\bresume\b|\bresumes\b|\bcv\b|curriculum vitae/;
  const NOT_RESUME_RE = /cover letter|photo|photograph|passport|aadhaar|aadhar|id proof|certificate|marksheet|payslip|offer letter/;
  // "Autofill from your résumé" parser widgets — Zoho's easy-apply, Workday's "Autofill with
  // Resume", iCIMS quick-apply — take a résumé too, and talk about résumés just as much as
  // the real field does, so they tie with it and the tie-break then refuses to pick either.
  // But they only PREFILL the form; the submission still needs the required field. Demote
  // rather than disqualify: if a page offers nothing else, it's still the best target.
  const PARSER_RE = /autofill|auto fill|easy apply|quick apply|parse|prefill|pre fill|populate/;

  // > 0 means "this is the résumé slot"; -1 means "definitely not". Higher wins.
  function resumeScore(el) {
    const ctx = fileContext(el);
    if (NOT_RESUME_RE.test(ctx)) return -1;
    let s = 0;
    if (RESUME_RE.test(ctx)) s += 10;
    if (/pdf|doc/i.test(el.getAttribute("accept") || "")) s += 2;
    if (/upload|attach|browse|choose file|drag/.test(ctx)) s += 1;
    if (PARSER_RE.test(ctx)) s -= 6;
    return s;
  }

  // A remembered slot for this site wins; else the best-scoring one; else, if the page has
  // exactly one plausible upload, it's that one — a job form with a single file field is
  // asking for your résumé.
  function resumeSlot() {
    const all = fileInputs();
    if (!all.length) return null;
    const remembered = recipeSlot(all);
    if (remembered) return remembered;
    // A clear winner only — if two uploads score the same we genuinely can't tell them
    // apart, and attaching to the wrong one is worse than asking you to do it once.
    const scored = all.map((el) => ({ el, s: resumeScore(el) })).sort((a, b) => b.s - a.s);
    if (scored[0].s > 0 && (scored.length === 1 || scored[0].s > scored[1].s)) return scored[0].el;
    const plausible = all.filter((el) => resumeScore(el) >= 0);
    return plausible.length === 1 ? plausible[0] : null;
  }

  // ── per-site recipes ──────────────────────────────────────────────────────────
  // Q&A facts generalize across sites; this does NOT — which control is the résumé slot is
  // a fact about one ATS. Keyed by origin, written only when YOU attach a file by hand,
  // read on every later visit so the same site is instant and guess-free. Fingerprinted by
  // name/id/context rather than a CSS path, which SPA re-renders would break.
  const recipes = () => G.get("jobfill_recipes_v1", {}) || {};
  const recipeGet = () => recipes()[location.origin] || null;
  const fileFingerprint = (el) => ({ name: el.name || "", id: el.id || "", ctx: fileContext(el).slice(0, 120) });
  function recipeSetResume(el) {
    const all = recipes();
    all[location.origin] = { ...(all[location.origin] || {}), resume: fileFingerprint(el), at: Date.now() };
    G.set("jobfill_recipes_v1", all);
  }
  function recipeSlot(all) {
    const fp = recipeGet() && recipeGet().resume;
    if (!fp) return null;
    return (fp.name && all.find((e) => e.name === fp.name)) ||
           (fp.id && all.find((e) => e.id === fp.id)) ||
           (fp.ctx && all.find((e) => fileContext(e).slice(0, 120) === fp.ctx)) || null;
  }

  // Attach the cached résumé to this page's slot. Returns a short status string — this is
  // the ONLY place that puts a file on a form, so Autofill and Save & attach behave alike.
  async function attachResume() {
    const file = resumeFile() || await defaultResumeFile();
    if (!file) return "no résumé cached (and no default on server)";
    const slot = resumeSlot();
    if (!slot) return fileInputs().length ? "⚠️ can't tell which upload is the résumé" : "no upload on this page";
    if (slot.files && slot.files.length) return `📎 already attached`;
    filling = true;                                    // our own write — don't learn it as a recipe
    try { attachFile(slot, file); } finally { filling = false; }
    // A hidden input can't show an outline; flag the styled button wrapping it instead.
    mark(visible(slot) ? slot : (slot.parentElement || slot), "#22c55e", "résumé attached");
    return `📎 attached ${file.name}`;
  }

  // ── cached target JD ──────────────────────────────────────────────────────────
  // Captured on LinkedIn job pages (and the local dashboard) and read later — on a
  // different origin — by the Tailor flow on the ATS "external apply" page. GM
  // storage is shared across every origin this script runs on, so the JD survives
  // the LinkedIn → external-apply → ATS hop. ONLY the two capture points below write
  // this key; the ATS page only reads it. Replaced when a new job is opened, or
  // cleared by hand from the Tailor banner.
  const jdGet = () => G.get("jobfill_active_jd", null);
  const jdSet = (o) => G.set("jobfill_active_jd", o);
  const jdClear = () => G.set("jobfill_active_jd", null);
  const agoText = (ts) => {
    const s = Math.max(0, (Date.now() - (ts || 0)) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  };

  // small transient confirmation (capture feedback outside the app-form panel)
  function toast(msg) {
    const t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;bottom:60px;right:16px;z-index:2147483647;background:#0f172a;color:#e2e8f0;font:12px system-ui;padding:8px 12px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.4);max-width:340px";
    document.body.appendChild(t);
    setTimeout(() => { t.style.transition = "opacity .4s"; t.style.opacity = "0"; setTimeout(() => t.remove(), 400); }, 2600);
  }

  // ── JD capture: LinkedIn job pages + the local dashboard ────────────────────────
  const pickText = (sels) => { for (const s of sels) { const el = document.querySelector(s); const t = (el && el.innerText || "").trim(); if (t) return t; } return ""; };
  const LI_JD_SEL    = [".show-more-less-html__markup", ".jobs-description__content", "#job-details", ".description__text", ".jobs-box__html-content"];
  const LI_TITLE_SEL = [".top-card-layout__title", ".job-details-jobs-unified-top-card__job-title", "h1"];
  const LI_CO_SEL    = [".topcard__org-name-link", ".job-details-jobs-unified-top-card__company-name", ".topcard__flavor a", ".topcard__flavor"];
  const liJobId = () =>
    new URLSearchParams(location.search).get("currentJobId") ||
    (location.pathname.match(/\/jobs\/view\/(?:.*?-)?(\d{6,})/) || [])[1] || "";

  let lastCapturedJobId = "";
  function captureLinkedInJd() {
    if (!/(^|\.)linkedin\.com$/.test(location.hostname)) return;
    const onJob = /\/jobs\/(view|search|collections)/.test(location.pathname) || new URLSearchParams(location.search).has("currentJobId");
    if (!onJob) return;
    const jd = pickText(LI_JD_SEL);
    if (jd.length < 200) return;                        // not loaded yet — a later tick will get it
    const id = liJobId();
    if (id && id === lastCapturedJobId) return;         // already stored this exact job
    const title = pickText(LI_TITLE_SEL).slice(0, 120);
    const company = pickText(LI_CO_SEL).replace(/\s+/g, " ").slice(0, 80);
    jdSet({ jd, title, company, url: location.href.split("?")[0], id, at: Date.now(), source: "linkedin" });
    lastCapturedJobId = id || title;
    toast(`📋 JD captured for Tailor: ${title || "this job"}`);
  }

  function wireDashboardCapture() {
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
    // Dashboard job rows carry the full scraped JD in the title link's data-jd.
    document.addEventListener("click", (e) => {
      const a = e.target && e.target.closest && e.target.closest("a[data-jd]");
      if (!a) return;
      const jd = decodeURIComponent(a.getAttribute("data-jd") || "");
      if (jd.length < 100) return;                      // empty/unenriched — let LinkedIn-page capture handle it
      const row = a.closest("tr");
      const company = row && row.children[3] ? (row.children[3].innerText || "").trim() : "";
      const title = (a.innerText || "").trim();
      jdSet({ jd, title: title.slice(0, 120), company: company.slice(0, 80), url: a.href, at: Date.now(), source: "dashboard" });
      toast("📋 JD captured for Tailor: " + title);
    }, true);
  }

  // ── local LLM proxy call ──────────────────────────────────────────────────────
  // Generic POST to the local proxy. Resolves to the parsed JSON, or { error } on any failure —
  // callers never throw. `timeout` is generous: /tailor runs several DeepSeek calls + a render.
  function postJSON(path, payload, timeout = 300000) {
    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest !== "function") { resolve({ error: "GM_xmlhttpRequest unavailable" }); return; }
      GM_xmlhttpRequest({
        method: "POST", url: SERVER + path, headers: { "content-type": "application/json" },
        data: JSON.stringify(payload), timeout,
        onload: (r) => { try { const j = JSON.parse(r.responseText); resolve(r.status >= 400 ? { error: j.error || `HTTP ${r.status}`, ...j } : j); } catch { resolve({ error: "bad response" }); } },
        onerror: () => resolve({ error: "server unreachable — run `node applier/server.mjs`" }),
        ontimeout: () => resolve({ error: "request timed out" }),
      });
    });
  }
  function getJSON(path, timeout = 20000) {
    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest !== "function") { resolve({ error: "GM_xmlhttpRequest unavailable" }); return; }
      GM_xmlhttpRequest({
        method: "GET", url: SERVER + path, timeout,
        onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch { resolve({ error: "bad response" }); } },
        onerror: () => resolve({ error: "server unreachable — run `node applier/server.mjs`" }),
        ontimeout: () => resolve({ error: "request timed out" }),
      });
    });
  }
  // Choice fields ship their options so the model can pick a real one on a first visit.
  const askServer = (fields) => postJSON("/answer", { profile, questions: fields.map((f) => ({ label: f.label, kind: f.kind, options: f.options })) });

  // ── résumé tailoring ── JD → ranked keywords + manual text editor → styled .docx ───
  // Grab a plausible job description from the page: the current selection if the user highlighted
  // it, else the largest text block on the page (job posts are one big description container).
  //
  // PERFORMANCE, and it is not a detail: reading `innerText` FORCES A SYNCHRONOUS STYLE +
  // LAYOUT FLUSH, because it means "the text as rendered". Doing that once per element over
  // every <div> on a LinkedIn-sized SPA is thousands of forced reflows back to back — the
  // main thread stops and the whole tab freezes for many seconds. (That's the "LinkedIn
  // blocks the script" symptom; nothing is blocking us, we're locking the page ourselves.)
  // So measure candidates with `textContent`, which is a pure DOM string read and triggers
  // NO layout, and pay for `innerText` exactly once — on the winner — to get its rendered
  // line breaks, which the tailoring prompt reads much better than run-together text.
  const JD_SCAN_CAP = 1500;                       // hard ceiling on elements measured
  function grabJd() {
    const sel = String(window.getSelection?.() || "").trim();
    if (sel.length > 200) return sel;
    let best = null, bestLen = 0, n = 0;
    for (const el of document.querySelectorAll("main, article, section, div")) {
      if (++n > JD_SCAN_CAP) break;
      const len = (el.textContent || "").trim().length;
      if (len > bestLen && len < 12000) { best = el; bestLen = len; }
    }
    const t = best ? (best.innerText || best.textContent || "").trim() : "";
    return t || (document.body?.textContent || "").trim().slice(0, 12000);
  }

  // Cache the tailored PDF as the résumé Autofill attaches to form file fields — no download.
  // (The styled .docx is written to applier/tailored/ server-side.)
  function cacheResumePdf(filename, b64) {
    G.set("jobfill_resume", { name: filename, type: "application/pdf", b64 });
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // The feedback loop's payoff, in the badge: the ranked "learn next" table across all logged
  // applications, plus callback stats. Read-only view over GET /insights.
  async function insightsFlow() {
    const ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font:13px system-ui";
    ov.innerHTML =
      `<div style="background:#0f172a;color:#e2e8f0;padding:16px;border-radius:12px;width:min(560px,92vw);max-height:88vh;overflow:auto">` +
      `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">` +
        `<div style="font-weight:600">What to learn next</div>` +
        `<button id="jf-iclose" style="cursor:pointer;background:#334155;color:#fff;border:0;border-radius:6px;padding:4px 10px">Close</button>` +
      `</div><div id="jf-ibody" style="opacity:.8">loading…</div></div>`;
    document.body.appendChild(ov);
    ov.querySelector("#jf-iclose").onclick = () => ov.remove();
    const body = ov.querySelector("#jf-ibody");
    const i = await getJSON("/insights");
    if (i.error) { body.innerHTML = `<span style="color:#fca5a5">⚠️ ${esc(i.error)}</span>`; return; }
    const pct = i.callback_rate === null ? "—" : `${Math.round(i.callback_rate * 100)}%`;
    const learnRows = (i.learn || []).slice(0, 25).map((r) =>
      `<tr><td style="padding:2px 8px">${esc(r.keyword)}</td><td style="padding:2px 8px;text-align:right">${r.missed}</td><td style="padding:2px 8px;text-align:right;color:#fca5a5">${r.no_callback}</td></tr>`).join("");
    const noRoomRows = (i.no_room || []).slice(0, 12).map((r) => `${esc(r.keyword)} <span style="opacity:.5">×${r.count}</span>`).join(", ");
    body.innerHTML =
      `<div style="margin-bottom:10px;opacity:.85">${i.total_applications} applications · ${i.with_outcome} with an outcome · ${i.callbacks} callbacks (${pct})</div>` +
      (learnRows
        ? `<table style="width:100%;border-collapse:collapse"><thead><tr style="opacity:.6;text-align:left">` +
          `<th style="padding:2px 8px">keyword the JD wanted, résumé can't back</th><th style="padding:2px 8px;text-align:right">missed</th><th style="padding:2px 8px;text-align:right">no-cb</th></tr></thead>` +
          `<tbody>${learnRows}</tbody></table>`
        : `<div style="opacity:.6">No gap keywords yet — tailor a few applications.</div>`) +
      (noRoomRows ? `<div style="margin-top:12px;opacity:.75"><b>Have it, no room</b> (free space to include): ${noRoomRows}</div>` : "");
  }

  // AI tailoring: JD + master résumé → DeepSeek proposes text-only paragraph edits (styling is
  // never touched), applied losslessly into the styled .docx and rendered to a live PDF preview
  // with the changed lines highlighted for review. You correct anything, watch the preview
  // update, then save & attach. Step 1 = JD input; step 2 = the review editor.
  const WEIGHT_COLORS = { 4: "#a855f7", 3: "#ef4444", 2: "#f59e0b", 1: "#64748b" };
  const WEIGHT_LABEL = { 4: "job title", 3: "required", 2: "preferred", 1: "mentioned" };
  // Word-boundary normalize (padded with spaces) so "Go" matches " go " not "Google", and
  // multi-word terms match only as whole phrases — mirrors keywords.mjs resumeHas server-side.
  const kwNorm = (s) => ` ${String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

  // base64 PDF → object URL for the <iframe> preview (browsers render PDFs natively — no libs).
  const pdfObjectUrl = (b64) => {
    const bin = atob(b64), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([arr], { type: "application/pdf" }));
  };

  // Attach an already-tailored PDF as-is (no AI): pick one of the pre-built per-title résumés
  // under RESUME_ROOT, cache it as the résumé Autofill attaches, and attach it to this page's
  // slot right away — same cache+attach path as the Tailor "Save & attach".
  async function pickResumeFlow() {
    const ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font:13px system-ui";
    ov.innerHTML =
      `<div style="background:#0f172a;color:#e2e8f0;padding:16px;border-radius:12px;width:min(560px,92vw);max-height:88vh;overflow:auto">` +
      `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">` +
        `<div style="font-weight:600">Attach an existing résumé</div>` +
        `<button id="jf-pclose" style="cursor:pointer;background:#334155;color:#fff;border:0;border-radius:6px;padding:4px 10px">Close</button>` +
      `</div>` +
      `<div style="opacity:.55;font-size:11px;margin-bottom:8px">Pick a pre-built PDF — it's cached and attached to this page's résumé field (no tailoring).</div>` +
      `<div id="jf-pbody" style="opacity:.8">loading…</div></div>`;
    document.body.appendChild(ov);
    ov.querySelector("#jf-pclose").onclick = () => ov.remove();
    const body = ov.querySelector("#jf-pbody");

    const list = await getJSON("/resumes");
    if (!list || list.error) { body.innerHTML = `<span style="color:#fca5a5">⚠️ ${esc(list?.error || "server unreachable — is applier running?")}</span>`; return; }
    const items = list.resumes || [];
    if (!items.length) { body.innerHTML = `<div style="opacity:.6">No PDFs found under ${esc(list.root || "résumé root")}.</div>`; return; }

    const current = (G.get("jobfill_resume", null) || {}).name || "";
    const groups = new Map();                             // folder → rows
    for (const it of items) { const k = it.folder || "(root)"; (groups.get(k) || groups.set(k, []).get(k)).push(it); }
    body.innerHTML = [...groups].map(([folder, rows]) =>
      `<div style="font-weight:600;color:#93c5fd;margin:10px 0 4px">${esc(folder)}</div>` +
      rows.map((it) => {
        const active = it.name === current;
        return `<div class="jf-pick" data-rel="${esc(it.rel)}" data-name="${esc(it.name)}" title="attach ${esc(it.name)}" ` +
          `style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid #1e293b;border-radius:6px;margin-bottom:4px;${active ? "background:rgba(34,197,94,.10);border-color:#166534" : ""}">` +
          `<span style="flex:1">${esc(it.name)}</span>` +
          (active ? `<span style="color:#4ade80;font-size:11px">● cached</span>` : `<span style="opacity:.4;font-size:11px">attach →</span>`) +
          `</div>`;
      }).join("")
    ).join("");

    body.querySelectorAll(".jf-pick").forEach((el) => {
      el.onclick = async () => {
        const rel = el.getAttribute("data-rel"), name = el.getAttribute("data-name");
        el.style.opacity = ".5";
        const r = await getJSON("/resume?rel=" + encodeURIComponent(rel));
        if (!r || r.error || !r.b64) { setStatus("⚠️ " + (r?.error || "could not load " + name)); el.style.opacity = "1"; return; }
        cacheResumePdf(r.name, r.b64);                    // becomes the résumé Autofill attaches
        const msg = await attachResume();                 // attach to this page's slot now, if present
        setStatus(`📎 ${r.name} — ${msg}`);
        ov.remove();
      };
    });
  }

  // opts.auto — opened by ⚡ Autofill (no cached JD to work from), so the review it leads
  // into continues the run after Attach.
  function tailorFlow(opts = {}) {
    const ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font:13px system-ui";
    ov.innerHTML =
      `<div id="jf-ebox" style="background:#0f172a;color:#e2e8f0;padding:16px;border-radius:12px;width:min(760px,94vw);max-height:90vh;overflow:auto">` +
      `<div style="font-weight:600;margin-bottom:8px">Tailor résumé — AI drafts, you review the PDF</div>` +
      `<div id="jf-jdbanner"></div>` +
      `<div style="display:flex;gap:8px;margin-bottom:8px">` +
        `<input id="jf-co" placeholder="Company (used in filename)" style="flex:1;box-sizing:border-box;background:#0b1220;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:6px 8px">` +
        `<input id="jf-ti" placeholder="Title (optional)" style="flex:1;box-sizing:border-box;background:#0b1220;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:6px 8px">` +
      `</div>` +
      `<textarea id="jf-jd" placeholder="Job description…" style="width:100%;height:24vh;box-sizing:border-box;background:#0b1220;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:10px;font:12px ui-monospace,monospace"></textarea>` +
      `<div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end;align-items:center">` +
        `<span id="jf-tstatus" style="margin-right:auto;opacity:.8"></span>` +
        `<button id="jf-tcancel" style="cursor:pointer;background:#334155;color:#fff;border:0;border-radius:6px;padding:6px 12px">${opts.auto ? "Skip → fill form" : "Close"}</button>` +
        `<button id="jf-tgo" style="cursor:pointer;background:#2563eb;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-weight:600">Tailor &amp; preview</button>` +
      `</div></div>`;
    document.body.appendChild(ov);

    // Prefer the JD captured on the LinkedIn job page / dashboard over this (ATS)
    // page's own text. Banner shows what's loaded, with escape hatches.
    const jdField = ov.querySelector("#jf-jd");
    const coField = ov.querySelector("#jf-co");
    const tiField = ov.querySelector("#jf-ti");
    const banner  = ov.querySelector("#jf-jdbanner");
    const cached  = jdGet();
    if (cached && cached.jd) {
      jdField.value = cached.jd;
      if (cached.company) coField.value = cached.company;
      tiField.value = (cached.title || document.title || "").slice(0, 80);
    } else {
      jdField.value = grabJd();
      tiField.value = (document.title || "").slice(0, 80);
    }
    function renderJdBanner() {
      const c = jdGet();
      if (c && c.jd) {
        banner.innerHTML =
          `<div style="display:flex;align-items:center;gap:8px;background:#0b2a1a;border:1px solid #14532d;color:#bbf7d0;border-radius:8px;padding:6px 10px;margin-bottom:8px">` +
            `<span>📋 Cached JD${c.company ? ` — <b>${esc(c.company)}</b>` : ""}${c.title ? ` · ${esc(c.title)}` : ""} <span style="opacity:.6">(${esc(c.source || "linkedin")}, ${agoText(c.at)})</span></span>` +
            `<button id="jf-jduse" style="margin-left:auto;cursor:pointer;background:#334155;color:#fff;border:0;border-radius:6px;padding:3px 8px">Use this page instead</button>` +
            `<button id="jf-jdclear" style="cursor:pointer;background:#7f1d1d;color:#fff;border:0;border-radius:6px;padding:3px 8px">✕ Clear</button>` +
          `</div>`;
        banner.querySelector("#jf-jduse").onclick = () => { jdField.value = grabJd(); banner.querySelector("#jf-jduse").textContent = "using this page ✓"; };
        banner.querySelector("#jf-jdclear").onclick = () => { jdClear(); jdField.value = grabJd(); renderJdBanner(); };
      } else {
        banner.innerHTML =
          `<div style="background:#0b1220;border:1px solid #334155;color:#94a3b8;border-radius:8px;padding:6px 10px;margin-bottom:8px">` +
          `No cached JD — using this page's text. Open the LinkedIn job (or click a job on the dashboard) to capture the real JD, then reopen Tailor.</div>`;
      }
    }
    renderJdBanner();
    const tstatus = ov.querySelector("#jf-tstatus");
    ov.querySelector("#jf-tcancel").onclick = () => {
      ov.remove();
      if (!opts.auto) return;
      tailorSkipped = true;                    // don't re-prompt on this page
      setStatus("tailoring skipped — filling fields…");
      fillPass().catch((e) => setStatus("error: " + e.message));
    };
    ov.querySelector("#jf-tgo").onclick = async () => {
      const jd = ov.querySelector("#jf-jd").value.trim();
      if (jd.length < 100) { tstatus.textContent = "paste a fuller job description first"; return; }
      const go = ov.querySelector("#jf-tgo"); go.disabled = true;
      tstatus.textContent = "DeepSeek tailoring & rendering preview… (~10s)";
      const r = await postJSON("/tailor", { jd });
      go.disabled = false;
      if (r.error) { tstatus.textContent = "⚠️ " + r.error; return; }
      renderReview(ov, r, ov.querySelector("#jf-co").value.trim(), ov.querySelector("#jf-ti").value.trim(), opts);
    };
  }

  // The review editor: left = ranked keyword chips (strike as covered) + editable paragraph rows
  // (AI edits pre-applied, changed lines flagged yellow); right = the live PDF preview with the
  // same changes highlighted. Edit any line → preview re-renders (debounced). Save & Attach writes
  // a CLEAN styled .docx to applier/tailored/ and caches the CLEAN PDF for Autofill to attach.
  // Recruiter-facing filename the review modal proposes: "<your name> Resume - <Company> - <date>".
  // You can type anything; the server slugs it and appends .docx/.pdf.
  const dateStamp = () => new Date().toLocaleDateString("en-CA");                 // YYYY-MM-DD
  const suggestName = (company) => {
    const who = (profile.contact.full_name || "").trim() ||
      [profile.contact.first_name, profile.contact.last_name].filter(Boolean).join(" ").trim() || "Lakhveer Singh";
    const co = String(company || "").replace(/[^\w .()&-]+/g, " ").replace(/\s+/g, " ").trim();
    return `${who} Resume - ${co || "Tailored"} - ${dateStamp()}`;
  };

  // opts.auto — this review was opened BY ⚡ Autofill, so attaching continues the run
  // (parser wait → fill pass) instead of just closing.
  function renderReview(ov, r, company, title, opts = {}) {
    const box = ov.querySelector("#jf-ebox");
    let lastFocused = null;                 // most-recently focused row (for click-to-insert)
    let previewUrl = pdfObjectUrl(r.pdf_base64 || "");
    let renderTimer = null, rendering = false, dirty = false;

    const keywords = r.keywords || [];
    const editedIds = new Set((r.edits || []).map((e) => e.id));
    const applied = new Map((r.edits || []).map((e) => [e.id, e.new_text]));   // AI's accepted text
    const suggest = new Map((r.rejected || []).filter((e) => e.new_text).map((e) => [e.id, e.new_text])); // too-long ideas
    const master = new Map((r.rows || []).filter((x) => x.kind === "text").map((x) => [x.id, x.text]));

    const kwRow = (k, i) =>
      `<div class="jf-kw" data-i="${i}" data-term="${esc(k.term)}" title="click to insert / copy" ` +
        `style="display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;cursor:pointer;${k.onResume ? "opacity:.45;text-decoration:line-through" : ""}">` +
        `<span style="flex:0 0 8px;width:8px;height:8px;border-radius:50%;background:${WEIGHT_COLORS[k.weight]}"></span>` +
        `<span style="flex:1">${esc(k.term)}</span>` +
        `<span style="opacity:.5;font-size:11px">${WEIGHT_LABEL[k.weight]}</span></div>`;

    const rowHtml = (row) => {
      if (row.kind === "header")
        return `<div style="font-weight:700;letter-spacing:.04em;margin:12px 0 4px;color:#93c5fd">${esc(row.text)}</div>`;
      const val = applied.has(row.id) ? applied.get(row.id) : row.text;
      const sug = suggest.has(row.id)
        ? `<div class="jf-sug" data-id="${row.id}" title="AI suggestion (was too long — click to use, then trim)" ` +
          `style="cursor:pointer;font-size:11px;color:#fbbf24;margin:-2px 0 6px;padding:0 2px">💡 ${esc(suggest.get(row.id))}</div>`
        : "";
      return `<textarea class="jf-row" data-id="${row.id}" rows="1" ` +
        `style="width:100%;box-sizing:border-box;background:#0b1220;color:#e2e8f0;border:1px solid #1e293b;border-radius:6px;padding:6px 8px;margin-bottom:${sug ? 0 : 4}px;font:12px ui-monospace,monospace;resize:vertical;overflow:hidden">${esc(val)}</textarea>` + sug;
    };

    box.style.width = "min(1220px,97vw)";
    box.innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">` +
        `<div style="font-weight:600">Tailor résumé${company ? ` — <span style="opacity:.8">${esc(company)}</span>` : ""}` +
          `${r.exact_title ? ` · JD title: <span style="opacity:.8">${esc(r.exact_title)}</span>` : ""}` +
          ` · <span style="opacity:.7">${editedIds.size} AI edit(s)</span></div>` +
        `<button id="jf-eclose" style="cursor:pointer;background:#334155;color:#fff;border:0;border-radius:6px;padding:4px 10px">Close</button>` +
      `</div>` +
      `<div style="display:flex;gap:12px;align-items:stretch;height:70vh">` +
        `<div style="flex:0 0 220px;overflow:auto;border:1px solid #1e293b;border-radius:8px;padding:8px">` +
          `<div style="font-weight:600;margin-bottom:2px">Keywords <span id="jf-kwcov" style="opacity:.6;font-weight:400"></span></div>` +
          `<div style="opacity:.5;font-size:11px;margin-bottom:6px">ranked · click to insert · strikes when covered</div>` +
          `<div id="jf-kws">${keywords.map(kwRow).join("") || `<div style="opacity:.6">No keywords — JD too short?</div>`}</div>` +
        `</div>` +
        `<div style="flex:1 1 40%;min-width:0;overflow:auto;border:1px solid #1e293b;border-radius:8px;padding:8px">` +
          `<div style="opacity:.5;font-size:11px;margin-bottom:6px"><span style="color:#eab308">▍</span> yellow = changed from your master · 💡 = trim-to-use suggestion</div>` +
          `${(r.rows || []).map(rowHtml).join("")}` +
        `</div>` +
        `<div style="flex:1 1 46%;min-width:0;display:flex;flex-direction:column;border:1px solid #1e293b;border-radius:8px;overflow:hidden">` +
          `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:#0b1220;border-bottom:1px solid #1e293b">` +
            `<span style="font-weight:600">PDF preview</span>` +
            `<span id="jf-pvinfo" style="opacity:.6;font-size:11px"></span>` +
            `<button id="jf-pvrefresh" style="margin-left:auto;cursor:pointer;background:#334155;color:#fff;border:0;border-radius:6px;padding:3px 9px">↻ Update</button>` +
          `</div>` +
          `<iframe id="jf-pv" style="flex:1;width:100%;border:0;background:#fff" src="${previewUrl}"></iframe>` +
        `</div>` +
      `</div>` +
      `<div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-wrap:wrap">` +
        `<span id="jf-estatus" style="margin-right:auto;opacity:.8"></span>` +
        `<label for="jf-ename" style="opacity:.6">Save as</label>` +
        `<input id="jf-ename" placeholder="Name this résumé…" ` +
          `style="width:min(320px,40vw);box-sizing:border-box;background:#0b1220;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:6px 8px">` +
        (opts.auto
          ? `<button id="jf-eskip" title="attach nothing tailored — go straight to filling the form" ` +
            `style="cursor:pointer;background:#334155;color:#fff;border:0;border-radius:6px;padding:7px 12px">Skip → fill form</button>`
          : "") +
        `<button id="jf-esave" style="cursor:pointer;background:#22c55e;color:#052e16;border:0;border-radius:6px;padding:7px 14px;font-weight:700">` +
          (opts.auto ? `📎 Attach &amp; continue autofill` : `✓ Save &amp; attach (.docx local · PDF to form)`) + `</button>` +
      `</div>`;

    const estatus = box.querySelector("#jf-estatus");
    const pvinfo = box.querySelector("#jf-pvinfo");
    const iframe = box.querySelector("#jf-pv");
    const autoGrow = (ta) => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
    pvinfo.textContent = `${r.pages || 1} page${(r.pages || 1) > 1 ? "s ⚠︎" : ""} · highlighted`;

    // Current edit set = every row that now differs from the master (AI edits + your changes).
    const currentEdits = () => [...box.querySelectorAll(".jf-row")]
      .map((ta) => ({ id: ta.getAttribute("data-id"), text: ta.value }))
      .filter((e) => e.text !== master.get(e.id));

    // Flag a row yellow iff it differs from the master (mirrors the PDF highlight).
    const flag = (ta) => {
      const changed = ta.value !== master.get(ta.getAttribute("data-id"));
      ta.style.borderLeft = changed ? "3px solid #eab308" : "1px solid #1e293b";
      ta.style.background = changed ? "rgba(234,179,8,.07)" : "#0b1220";
    };

    // Live keyword coverage: rescan résumé text, update strikes + counter.
    const recompute = () => {
      const hay = kwNorm([...box.querySelectorAll(".jf-row")].map((t) => t.value).join(" "));
      let covered = 0;
      box.querySelectorAll(".jf-kw").forEach((el) => {
        const on = hay.includes(kwNorm(el.getAttribute("data-term")));
        if (on) covered++;
        el.style.textDecoration = on ? "line-through" : "none";
        el.style.opacity = on ? ".45" : "1";
      });
      box.querySelector("#jf-kwcov").textContent = keywords.length ? `${covered}/${keywords.length} covered` : "";
    };

    // Re-render the highlighted preview from the current edit state (one in-flight at a time).
    const renderPreview = async () => {
      if (rendering) { dirty = true; return; }
      rendering = true; dirty = false;
      pvinfo.textContent = "rendering…";
      const resp = await postJSON("/tailor/preview", { edits: currentEdits() });
      rendering = false;
      if (resp.error) { pvinfo.textContent = "⚠️ " + resp.error; return; }
      const old = previewUrl;
      previewUrl = pdfObjectUrl(resp.pdf_base64 || "");
      iframe.src = previewUrl;
      setTimeout(() => URL.revokeObjectURL(old), 3000);
      pvinfo.textContent = `${resp.pages || 1} page${(resp.pages || 1) > 1 ? "s ⚠︎" : ""} · highlighted`;
      if (dirty) renderPreview(); // edits arrived mid-render — render once more
    };
    const scheduleRender = () => { clearTimeout(renderTimer); renderTimer = setTimeout(renderPreview, 1300); };

    box.querySelectorAll(".jf-row").forEach((ta) => {
      autoGrow(ta); flag(ta);
      ta.addEventListener("focus", () => (lastFocused = ta));
      ta.addEventListener("input", () => { autoGrow(ta); flag(ta); recompute(); scheduleRender(); });
    });

    // Click a 💡 suggestion → drop it into that row (you then trim it under the length limit).
    box.querySelectorAll(".jf-sug").forEach((el) => {
      el.onclick = () => {
        const id = el.getAttribute("data-id");
        const ta = box.querySelector(`.jf-row[data-id="${id}"]`);
        if (!ta) return;
        ta.value = suggest.get(id); ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.focus(); estatus.textContent = "suggestion applied — trim it to keep one page";
      };
    });

    // Click a keyword → insert at the cursor of the last-focused row, else copy.
    box.querySelectorAll(".jf-kw").forEach((el) => {
      el.onclick = () => {
        const term = el.getAttribute("data-term");
        if (lastFocused && document.body.contains(lastFocused)) {
          const s = lastFocused.selectionStart ?? lastFocused.value.length;
          const e = lastFocused.selectionEnd ?? lastFocused.value.length;
          const before = lastFocused.value.slice(0, s), after = lastFocused.value.slice(e);
          const pad = before && !/[\s,(]$/.test(before) ? (/[,]/.test(before) ? " " : ", ") : "";
          lastFocused.value = before + pad + term + after;
          lastFocused.dispatchEvent(new Event("input", { bubbles: true }));
          const pos = (before + pad + term).length;
          lastFocused.setSelectionRange(pos, pos); lastFocused.focus();
          estatus.textContent = `inserted "${term}"`;
        } else {
          try { navigator.clipboard?.writeText(term); } catch { /* ignore */ }
          estatus.textContent = `copied "${term}" — click a résumé line first to insert`;
        }
      };
    });

    recompute();
    box.querySelector("#jf-pvrefresh").onclick = () => { clearTimeout(renderTimer); renderPreview(); };
    box.querySelector("#jf-eclose").onclick = () => { URL.revokeObjectURL(previewUrl); ov.remove(); };

    // The name box gates attaching: nothing is written to applier/tailored/ (or uploaded)
    // until this résumé has a name you chose.
    const nameField = box.querySelector("#jf-ename");
    const save = box.querySelector("#jf-esave");
    nameField.value = suggestName(company || title);
    const syncName = () => {
      const ok = !!nameField.value.trim();
      save.disabled = !ok;
      save.style.opacity = ok ? "1" : ".45";
      save.style.cursor = ok ? "pointer" : "not-allowed";
    };
    nameField.addEventListener("input", syncName);
    syncName();

    const skip = box.querySelector("#jf-eskip");
    if (skip) skip.onclick = () => {
      URL.revokeObjectURL(previewUrl); ov.remove();
      tailorSkipped = true;
      setStatus("tailoring skipped — filling fields…");
      fillPass().catch((e) => setStatus("error: " + e.message));
    };

    save.onclick = async () => {
      const filename = nameField.value.trim();
      if (!filename) { estatus.textContent = "name the résumé first"; nameField.focus(); return; }
      save.disabled = true;
      estatus.textContent = "saving clean .docx + rendering PDF…";
      const resp = await postJSON("/tailor/save", { edits: currentEdits(), company, filename });
      save.disabled = false;
      if (resp.error) { estatus.textContent = "⚠️ " + resp.error; return; }
      const pdfName = resp.filename.replace(/\.docx$/i, ".pdf");
      cacheResumePdf(pdfName, resp.pdf_base64);
      // ...and actually attach it, which is what the button says it does. Caching alone
      // left you to guess that a second ⚡ Autofill run was required.
      const attached = await attachResume();
      pageTailored = true;                     // a second ⚡ Autofill won't re-tailor this page
      estatus.textContent = `✓ ${resp.filename} saved${resp.pages > 1 ? ` (⚠︎ ${resp.pages} pages)` : ""} · ${attached}`;
      setStatus(attached);
      if (!opts.auto) return;
      // Auto run: the résumé is on the form — hand over to the parser, then fill the rest.
      URL.revokeObjectURL(previewUrl); ov.remove();
      setStatus(`${attached} · waiting for this site's résumé parser…`);
      await waitForParser();
      await fillPass();
    };
  }

  // ── 🔍 Probe ──────────────────────────────────────────────────────────────────
  // A STRUCTURAL snapshot of the form in front of you: what controls exist, how they're
  // labelled, and what our own heuristics currently make of them. It exists so a flow we
  // don't support yet — LinkedIn Easy Apply's multi-step modal, an odd ATS — gets built
  // against the real markup instead of guessed selectors.
  //
  // VALUES ARE NEVER CAPTURED, only whether a field has one: this file gets read by a
  // person and lives on disk, and your answers are your business. Same reason the snapshot
  // is scoped to the open dialog when there is one — a probe of LinkedIn should describe
  // the apply modal, not the feed behind it.
  const attr = (el, a) => el.getAttribute(a) || undefined;
  const clsOf = (el) => (typeof el.className === "string" && el.className.trim() ? el.className.trim().slice(0, 140) : undefined);

  function describeEl(el) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    return {
      tag: el.tagName.toLowerCase(),
      type: type || undefined,
      id: el.id || undefined,
      name: el.name || undefined,
      aria: attr(el, "aria-label"),
      describedby: attr(el, "aria-describedby"),
      role: attr(el, "role"),
      cls: clsOf(el),
      label: labelFor(el) || undefined,
      visible: visible(el),
      required: el.required || attr(el, "aria-required") === "true" || undefined,
      options: el.tagName === "SELECT" ? [...el.options].map((o) => txt(o)).slice(0, 40) : undefined,
      answered: type === "file" ? (el.files || []).length > 0 : !!String(el.value || "").trim(),
      checked: /^(radio|checkbox)$/.test(type) ? el.checked : undefined,
    };
  }

  function probeSnapshot() {
    const dialog = document.querySelector(DIALOG_SEL);
    const scope = dialog || document.body;
    const pick = (sel, cap) => [...scope.querySelectorAll(sel)].slice(0, cap);
    const slot = resumeSlot();
    return {
      at: new Date().toISOString(),
      url: location.href.split("?")[0],
      host: location.host,
      title: document.title.slice(0, 160),
      // Is this a modal flow, and what is it? Easy Apply's whole shape hangs off this.
      dialog: dialog
        ? { tag: dialog.tagName.toLowerCase(), cls: clsOf(dialog), aria: attr(dialog, "aria-label"), labelledby: attr(dialog, "aria-labelledby"), heading: txt(dialog.querySelector("h1, h2, h3")).slice(0, 120) }
        : null,
      looks_like_form: looksLikeForm(),
      // What WE currently see — the gap between this and `inputs` is the bug report.
      fields: collectFields().map((f) => ({ label: f.label, kind: f.kind, options: f.options, answered: !!readValue(f), anchor: describeEl(f.el) })),
      inputs: pick("input, select, textarea", 200).map(describeEl),
      files: fileInputs().map((el) => ({ ...describeEl(el), context: fileContext(el).slice(0, 200), score: resumeScore(el), picked_as_slot: el === slot })),
      // Multi-step flows are driven by these: Next / Review / Submit live here.
      buttons: pick('button, [role="button"], input[type="submit"]', 100)
        .filter(visible)
        .map((el) => ({ text: txt(el).slice(0, 80), aria: attr(el, "aria-label"), id: el.id || undefined, cls: clsOf(el), disabled: el.disabled || undefined })),
      resume_slot: slot ? describeEl(slot) : null,
      counts: { inputs: scope.querySelectorAll("input, select, textarea").length, files: fileInputs().length, buttons: scope.querySelectorAll('button, [role="button"]').length },
    };
  }

  async function probeFlow() {
    const snap = probeSnapshot();
    setStatus(`🔍 probing ${snap.dialog ? "the open dialog" : "the page"}: ${snap.fields.length} fields, ${snap.files.length} uploads…`);
    const r = await postJSON("/probe", { snapshot: snap });
    if (r.error) {
      try { await navigator.clipboard.writeText(JSON.stringify(snap, null, 2)); setStatus("⚠️ server down — snapshot copied to clipboard instead"); }
      catch { setStatus("⚠️ " + r.error + " (and clipboard blocked — see console)"); console.log("[jobfill probe]", snap); }
      return;
    }
    console.log("[jobfill probe]", snap);
    setStatus(`🔍 saved ${r.file} · ${snap.fields.length} fields · ${snap.buttons.length} buttons`);
    toast(`🔍 probe saved → applier/probes/${r.file}`);
  }

  // ── the run: tailor → review → attach → parser → fill ──────────────────────────
  // ⚡ Autofill does the whole apply sequence in the order a human does it. Tailoring is
  // skipped — straight to the fill pass — when this page has no upload, when you already
  // tailored here, or when you said skip. It NEVER tailors blind: with no captured JD you
  // get the step-1 form (page text prefilled) to check first.
  let pageTailored = false;     // a tailored résumé is already attached on this page
  let tailorSkipped = false;    // you chose "just fill the form" here

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Uploading a résumé makes most ATSs prefill the form for you — asynchronously, seconds
  // later. Filling straight away races that: we'd write into fields the parser then
  // overwrites, and count about-to-be-filled fields as empty. So wait for the number of
  // answered fields to stop moving (or `max` ms, whichever comes first).
  async function waitForParser(max = 9000) {
    const count = () => collectFields().filter((f) => readValue(f)).length;
    let prev = count(), stable = 0;
    for (let t = 0; t < max; t += 500) {
      await sleep(500);
      const n = count();
      if (n === prev) { if (++stable >= 3) break; } else { stable = 0; prev = n; }
    }
    return prev;
  }

  // Straight into the review modal on the JD captured back on LinkedIn/the dashboard —
  // no step-1 form, because Autofill already knows the job. Same overlay shell tailorFlow
  // builds, handed to renderReview the moment the model answers.
  async function tailorAuto(c) {
    const ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font:13px system-ui";
    ov.innerHTML =
      `<div id="jf-ebox" style="background:#0f172a;color:#e2e8f0;padding:16px;border-radius:12px;width:min(760px,94vw);max-height:90vh;overflow:auto">` +
      `<div style="font-weight:600;margin-bottom:6px">Tailoring résumé to this job…</div>` +
      `<div style="opacity:.75;margin-bottom:10px">📋 ${esc(c.company || "cached JD")}${c.title ? ` · ${esc(c.title)}` : ""} <span style="opacity:.6">(${esc(c.source || "linkedin")}, ${agoText(c.at)})</span> — DeepSeek is drafting edits and rendering the PDF (~10s). You'll review and name it before anything is attached.</div>` +
      `<div style="display:flex;gap:8px;justify-content:flex-end">` +
        `<button id="jf-aedit" style="cursor:pointer;background:#334155;color:#fff;border:0;border-radius:6px;padding:6px 12px">Use a different JD</button>` +
        `<button id="jf-askip" style="cursor:pointer;background:#334155;color:#fff;border:0;border-radius:6px;padding:6px 12px">Skip → fill form</button>` +
      `</div></div>`;
    document.body.appendChild(ov);

    let cancelled = false;
    const stop = (then) => { cancelled = true; ov.remove(); then(); };
    ov.querySelector("#jf-askip").onclick = () => stop(() => {
      tailorSkipped = true;
      setStatus("tailoring skipped — filling fields…");
      fillPass().catch((e) => setStatus("error: " + e.message));
    });
    ov.querySelector("#jf-aedit").onclick = () => stop(() => tailorFlow({ auto: true }));

    const r = await postJSON("/tailor", { jd: c.jd });
    if (cancelled) return;
    if (r.error) {
      ov.remove();
      setStatus("⚠️ tailor: " + r.error);
      tailorFlow({ auto: true });               // step 1, so you can retry or skip
      return;
    }
    renderReview(ov, r, c.company || "", c.title || "", { auto: true });
  }

  async function autofill() {
    if (pageTailored || tailorSkipped) return fillPass();
    if (!resumeSlot()) { setStatus("no résumé upload here — filling fields only"); return fillPass(); }
    const c = jdGet();
    if (c && c.jd && c.jd.trim().length >= 200) return tailorAuto(c);
    // No captured JD. Never tailor blind off an ATS form page's own text — open step 1 with
    // it prefilled so you can check/paste the real description (or skip to filling).
    setStatus("no cached JD — check the description, then tailor");
    tailorFlow({ auto: true });
  }

  // ── the fill pass ─────────────────────────────────────────────────────────────
  // Every value we write is recorded in filledBy so learn() can tell our own output apart
  // from yours. Keyed by the field's anchor element (els[0] for a radio group).
  const filledBy = new WeakMap();   // el → the exact value autofill last wrote
  const recordFill = (f) => filledBy.set(f.el, readValue(f));

  // Write a value AS AUTOFILL rather than as you: hold `filling` across the whole write,
  // then record it. Without the flag, fillField's own change event re-enters the learn
  // hooks before recordFill runs, and we learn our own guess despite the gate.
  function applyFill(f, value) {
    filling = true;
    try { if (!fillField(f, value)) return false; } finally { filling = false; }
    recordFill(f);
    return true;
  }

  // The fill pass: attach whatever résumé is cached (a no-op if one is already on the
  // form), then answer every field still empty. This is the second half of a run — the
  // whole of it when there's nothing to tailor.
  async function fillPass() {
    let fast = 0, files = 0;
    const ask = [];   // fields needing the LLM

    const attachMsg = await attachResume();
    const slot = resumeSlot();
    for (const el of fileInputs()) {                    // other uploads are yours to handle
      if (el === slot || (el.files && el.files.length)) continue;
      if (visible(el)) { mark(el, "#f59e0b"); files++; }
    }

    for (const f of collectFields()) {
      if (readValue(f)) continue;                        // already answered — leave it alone
      const key = keyFromPatterns(f.label);              // this site's wording → canonical fact
      const fact = factGet(key);                         // learned on ANY site → instant, no LLM
      const known = fact || qaGet(f.label);
      const contactVal = (known || f.kind !== "text") ? null : contactGet(f.el);
      const val = known || contactVal;
      if (val && applyFill(f, val)) {
        mark(f.el, "#22c55e", fact ? `your ${key}` : known ? "from your Q&A" : "from contact info");
        fast++;
      } else ask.push(f);
    }

    const tail = `${attachMsg}${files ? ` · ⚠️ ${files} other upload` : ""}`;
    if (!ask.length) { setStatus(`✅ ${fast} known · ${tail} · nothing to ask`); return; }
    setStatus(`✅ ${fast} known · 🤖 LLM answering ${ask.length}…`);
    const resp = await askServer(ask);
    if (resp.error) { setStatus("⚠️ " + resp.error); ask.forEach((f) => mark(f.el, "#ef4444")); return; }

    let ans = 0, need = 0;
    ask.forEach((f, i) => {
      const a = (resp.answers && resp.answers[i]) || "UNKNOWN";
      if (a && a !== "UNKNOWN" && applyFill(f, a)) { mark(f.el, "#3b82f6", "LLM — verify"); ans++; }
      else { mark(f.el, "#ef4444"); need++; }
    });
    setStatus(`✅ ${fast} known · 💬 ${ans} LLM · ✍️ ${need} to fill · ${tail}`);
  }

  // ── learning: YOUR answers → Q&A ───────────────────────────────────────────────
  // Provenance gate: a field is only learned once its value differs from what we wrote
  // there. Otherwise tabbing past a blue "LLM — verify" field would promote an unreviewed
  // guess into Q&A — which prompts/answer.txt then feeds back to the model as
  // "KNOWN Q&A (authoritative)", laundering a guess into fact and reinforcing it forever.
  // A label the table recognises is stored ONCE, under its canonical key — so correcting
  // "Notice Period" here also fixes "When can you join?" on the next site. Anything the
  // table doesn't know still lands in label-keyed Q&A, exactly as before.
  function learn(f) {
    const val = readValue(f);
    if (!f.label || !val || val === "UNKNOWN") return false;
    if (filledBy.get(f.el) === val) return false;      // untouched autofill output — not yours
    const key = keyFromPatterns(f.label);
    if (key) {
      if (factGet(key) === val) return false;          // already known, unchanged
      factPut(key, val, f.label);
      qaDel(f.label);                                  // the fact supersedes any label-keyed copy
      return true;
    }
    if (qaGet(f.label) === val) return false;
    qaPut(f.label, val);
    return true;
  }

  const learnEl = (el) => {
    if (filling) return;                               // our own fill events, not your keystrokes
    if (!(el instanceof HTMLElement) || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    const f = fieldFor(el);
    if (f && learn(f)) setStatus(`💾 learned: "${f.label.slice(0, 42)}"`);
  };
  document.addEventListener("blur", (e) => learnEl(e.target), true);
  document.addEventListener("change", (e) => learnEl(e.target), true);   // selects & radios

  // You attached a file by hand → remember which control that was, for THIS site only.
  // Next visit resumeSlot() picks it with no scoring and no guessing. Provenance-gated the
  // same way: our own attach must never teach the recipe, or a wrong guess gets cemented.
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (filling || !(el instanceof HTMLElement) || el.tagName !== "INPUT") return;
    if ((el.type || "").toLowerCase() !== "file" || !el.files || !el.files.length) return;
    if (NOT_RESUME_RE.test(fileContext(el))) return;    // cover letter, ID proof — not the slot
    recipeSetResume(el);
    setStatus(`💾 learned this site's résumé slot`);
  }, true);

  // Blur misses fields that never held focus — pasted values, browser autocomplete, custom
  // widgets that write the underlying input directly. Sweep the whole form on submit as a
  // net. Still provenance-gated: submitting isn't reviewing, so an untouched LLM answer is
  // not learned here either.
  function captureAll() {
    let n = 0;
    for (const f of collectFields()) if (learn(f)) n++;
    if (n) setStatus(`💾 learned ${n} answer${n > 1 ? "s" : ""} on submit`);
  }
  document.addEventListener("submit", captureAll, true);
  document.addEventListener("click", (e) => {
    const b = e.target && e.target.closest && e.target.closest('button, input[type="submit"], [role="button"]');
    if (!b || /^jf-/.test(b.id || "") || b.closest("#jf-mini-tab")) return;    // our own UI
    if (/submit|apply|send|finish|continue|next/i.test(txt(b) + " " + (b.value || ""))) captureAll();
  }, true);

  // ── panel — shows only on application forms ────────────────────────────────────
  function looksLikeForm() {
    // visible() reads getBoundingClientRect — layout. Cap it: no real application form has
    // 400 inputs, but a feed page can, and this runs on every DOM mutation batch.
    const f = [...formRoot().querySelectorAll("input, textarea, select")].slice(0, 400).filter(visible);
    const hasFile = fileInputs().length > 0;   // NOT via visible() — résumé inputs are hidden by design
    const hasEmail = f.some((x) => (x.type || "").toLowerCase() === "email" || /\bemail\b/.test(hayOf(x)));
    const hasName = f.some((x) => /first name|last name|full name|your name/.test(hayOf(x)));
    return (hasEmail && (hasFile || hasName)) || (hasFile && hasName);
  }

  let statusEl, shown = false;
  const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };

  function editProfile() {
    const ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center";
    ov.innerHTML =
      `<div style="background:#0f172a;color:#e2e8f0;padding:16px;border-radius:12px;width:min(720px,92vw);font:13px system-ui">` +
      `<div style="font-weight:600;margin-bottom:8px">Knowledge base — contact, résumé text &amp; Q&amp;A (JSON)</div>` +
      `<textarea id="jf-ta" style="width:100%;height:52vh;box-sizing:border-box;background:#0b1220;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:10px;font:12px ui-monospace,monospace"></textarea>` +
      `<div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end">` +
      `<button id="jf-cancel" style="cursor:pointer;background:#334155;color:#fff;border:0;border-radius:6px;padding:6px 12px">Cancel</button>` +
      `<button id="jf-save" style="cursor:pointer;background:#2563eb;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-weight:600">Save</button>` +
      `</div></div>`;
    document.body.appendChild(ov);
    ov.querySelector("#jf-ta").value = JSON.stringify(profile, null, 2);
    ov.querySelector("#jf-cancel").onclick = () => ov.remove();
    ov.querySelector("#jf-save").onclick = () => {
      try {
        const d = JSON.parse(ov.querySelector("#jf-ta").value);
        profile = d; profile.qa = profile.qa || []; profile.facts = profile.facts || {};
        saveProfile();
        setStatus(`saved · ${Object.keys(profile.facts).length} facts · ${profile.qa.length} Q&A`);
        ov.remove();
      }
      catch { alert("Invalid JSON — not saved."); }
    };
  }

  function panel() {
    if (shown) return; shown = true;
    const mini = document.getElementById("jf-mini-tab");
    if (mini) mini.remove();
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;bottom:16px;right:16px;z-index:2147483646;background:#0f172a;color:#e2e8f0;font:12px/1.4 system-ui,-apple-system,sans-serif;padding:10px 12px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:340px";
    const btn = (id, label, primary, title) => `<button id="${id}"${title ? ` title="${title}"` : ""} style="cursor:pointer;background:${primary ? "#2563eb" : "#334155"};color:#fff;border:0;border-radius:6px;padding:5px ${primary ? 10 : 8}px;${primary ? "font-weight:600" : ""}">${label}</button>`;
    box.innerHTML =
      `<div style="font-weight:600;margin-bottom:6px">Autofill <span style="opacity:.55">· ${location.host}</span></div>` +
      `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">` +
      btn("jf-fill", "⚡ Autofill", true, "tailor to the cached JD → review &amp; name it → attach → fill the rest") + btn("jf-tailor", "📝 Tailor", false, "tailor only — don\'t continue into filling") + btn("jf-pick", "📎 Attach existing") + btn("jf-probe", "🔍 Probe", false, "dump this form\'s STRUCTURE (never your answers) to applier/probes/") + btn("jf-insights", "📊 Insights") + btn("jf-prof", "⚙ Knowledge") +
      `</div><div id="jf-status" style="margin-top:6px;opacity:.85">Ready · ${Object.keys(profile.facts).length} facts · ${profile.qa.length} Q&A</div>`;
    document.body.appendChild(box); statusEl = box.querySelector("#jf-status");
    box.querySelector("#jf-fill").onclick = () => autofill().catch((e) => setStatus("error: " + e.message));
    box.querySelector("#jf-tailor").onclick = () => tailorFlow();
    box.querySelector("#jf-pick").onclick = () => pickResumeFlow().catch((e) => setStatus("error: " + e.message));
    box.querySelector("#jf-probe").onclick = () => probeFlow().catch((e) => setStatus("probe error: " + e.message));
    box.querySelector("#jf-insights").onclick = insightsFlow;
    box.querySelector("#jf-prof").onclick = editProfile;
  }

  // manual override — always available, in case the auto-detect heuristic misses a
  // form (e.g. Phenom/Workday flows that gate the real form behind a sign-in or
  // resume-upload interstitial the heuristic doesn't recognize as "a form").
  function miniTab() {
    if (shown || document.getElementById("jf-mini-tab")) return;
    const tab = document.createElement("div");
    tab.id = "jf-mini-tab";
    tab.textContent = "⚡";
    tab.title = "Job Autofill — click to open";
    tab.style.cssText = "position:fixed;bottom:16px;right:16px;z-index:2147483645;background:#0f172a;color:#e2e8f0;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4);font-size:16px";
    tab.onclick = () => panel();
    document.body.appendChild(tab);
  }

  let tries = 0;
  const timer = setInterval(() => { if (looksLikeForm()) panel(); if (shown || ++tries > 20) { clearInterval(timer); miniTab(); } }, 1500);
  // An SPA like LinkedIn mutates the DOM continuously — running looksLikeForm() (which reads
  // layout for every input) on every batch is the other half of the freeze. Coalesce to one
  // check per 400ms, and stop observing entirely once the panel is up.
  let formCheckTimer = null;
  const formObserver = new MutationObserver(() => {
    if (shown) { formObserver.disconnect(); return; }
    if (formCheckTimer) return;
    formCheckTimer = setTimeout(() => {
      formCheckTimer = null;
      if (shown) { formObserver.disconnect(); return; }
      if (looksLikeForm()) panel();
    }, 400);
  });
  formObserver.observe(document.documentElement, { childList: true, subtree: true });
  miniTab();

  // JD capture — run now, then poll (LinkedIn loads the description async and is a
  // SPA, so job-to-job navigation swaps the DOM without a reload). On URL change we
  // reset the guard so the new job is re-captured.
  wireDashboardCapture();
  captureLinkedInJd();
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href; lastCapturedJobId = "";
      pageTailored = false; tailorSkipped = false;   // new page → the run starts over
    }
    captureLinkedInJd();
  }, 1500);
})();

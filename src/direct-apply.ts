/**
 * DIRECT-APPLY DETECTION — spot the postings that hand you a human instead of a
 * form: "send your CV to hr@acme.in", "please share resume", "Immediate Joiner".
 *
 * WHY THIS IS NOT A SCORING SIGNAL. Everything else in this repo ranks a job by
 * how well it FITS (scoring.ts) and then shows the good ones first. This is a
 * different question — "can I reach a person directly, right now?" — and the two
 * are independent. A 34% job with a recruiter's email in the body is worth
 * thirty seconds of your time in a way a 34% job behind a Workday form is not,
 * because the reply comes from a human and the queue is empty. So this deliberately
 * IGNORES the score (CONFIG.directApply.minScore = 0): a hit alerts and gets
 * highlighted whether it ranked high or low.
 *
 * The one gate that still applies is surface.ts's "only alert on a genuinely NEW
 * DB row" rule — otherwise the same email-in-JD posting would re-alert on every
 * run inside its search window, which is how you learn to ignore the banner.
 *
 * Everything scanned here is title + description, so it works for ANY source
 * whose cards carry a JD (Naukri inline, LinkedIn after enrichment). A card
 * surfaced without its JD simply has nothing to match — a later run that reads
 * the JD will light it up, and the upsert refreshes the flag then.
 */

import { CONFIG } from "../config.js";

/** One phrase/email that fired, with enough context to judge it at a glance. */
export interface DirectApplyHit {
  /** What kind of signal: a contact-me instruction, an address, or urgency. */
  kind: "contact" | "email" | "urgency";
  /** The phrase from config that matched, or the address itself for emails. */
  label: string;
  /** Where it was found — a title hit is far louder than a body hit. */
  where: "title" | "body";
  /** Surrounding text, so the dashboard tooltip can show it in context. */
  excerpt: string;
}

export interface DirectApplySignals {
  hits: DirectApplyHit[];
  /** Every address found, deduped — the dashboard turns these into mailto links. */
  emails: string[];
  /** True when any hit fired. Persisted so SQL/the UI can filter on it cheaply. */
  direct: boolean;
}

/**
 * A config phrase → regex. Spaces become `\s+` because JD text arrives with
 * newlines and non-breaking spaces collapsed unevenly ("send your\nCV to"), and
 * a literal-space match would miss exactly the postings we care about.
 *
 * `\b` is applied only where the phrase actually starts/ends with a word
 * character, so a future phrase like "cv@" or "(immediate)" still works.
 */
function phraseToRegex(phrase: string): RegExp {
  const escaped = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const lead = /^[\w]/.test(phrase.trim()) ? "\\b" : "";
  const tail = /[\w]$/.test(phrase.trim()) ? "\\b" : "";
  return new RegExp(`${lead}${escaped}${tail}`, "i");
}

/** Compiled once per process — these lists are static config, not per-job data. */
let compiled: { contact: [string, RegExp][]; urgency: [string, RegExp][] } | null = null;
function patterns() {
  if (!compiled) {
    const d = CONFIG.directApply;
    compiled = {
      contact: d.contactPhrases.map((p) => [p, phraseToRegex(p)] as [string, RegExp]),
      urgency: d.urgencyPhrases.map((p) => [p, phraseToRegex(p)] as [string, RegExp]),
    };
  }
  return compiled;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Whitespace-collapsed text: JDs arrive with newlines and stray nbsp. */
function normalize(s: string): string {
  return (s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/** ~60 chars either side of a match, for the tooltip and the alert body. */
function excerptAt(text: string, index: number, length: number): string {
  const from = Math.max(0, index - 60);
  const to = Math.min(text.length, index + length + 60);
  return (from > 0 ? "…" : "") + text.slice(from, to).trim() + (to < text.length ? "…" : "");
}

/**
 * Scan one posting. Returns null when nothing fired, so callers can leave the
 * field unset rather than storing an empty object on every row.
 */
export function detectDirectApply(job: { title?: string; description?: string }): DirectApplySignals | null {
  const d = CONFIG.directApply;
  if (!d.enabled) return null;

  const title = normalize(job.title ?? "");
  const body = normalize(job.description ?? "");
  const hits: DirectApplyHit[] = [];
  const emails: string[] = [];

  const { contact, urgency } = patterns();
  for (const [where, text] of [["title", title], ["body", body]] as const) {
    if (!text) continue;

    for (const [kind, list] of [["contact", contact], ["urgency", urgency]] as const) {
      for (const [label, re] of list) {
        const m = re.exec(text);
        if (m) hits.push({ kind, label, where, excerpt: excerptAt(text, m.index, m[0].length) });
      }
    }

    if (d.detectEmails) {
      EMAIL_RE.lastIndex = 0;
      for (const m of text.matchAll(EMAIL_RE)) {
        const addr = m[0].toLowerCase();
        const domain = addr.slice(addr.indexOf("@") + 1);
        // Placeholder/boilerplate domains only. A real recruiter address at a
        // free provider (gmail/outlook) is NOT filtered — that is the single
        // strongest "a human reads this inbox" signal a JD can carry.
        if (d.ignoreEmailDomains.some((bad) => domain === bad || domain.endsWith("." + bad))) continue;
        if (emails.includes(addr)) continue;
        emails.push(addr);
        hits.push({ kind: "email", label: addr, where, excerpt: excerptAt(text, m.index!, m[0].length) });
      }
    }
  }

  if (!hits.length) return null;
  // Title hits first, then contact instructions, then addresses, then urgency —
  // the order the dashboard tooltip and the alert body read in.
  const rank = { contact: 0, email: 1, urgency: 2 };
  hits.sort((a, b) =>
    (a.where === b.where ? 0 : a.where === "title" ? -1 : 1) || (rank[a.kind] - rank[b.kind]));
  return { hits, emails, direct: true };
}

/** Attach signals in place. Returns true when the job is a direct-apply hit. */
export function markDirectApply(job: { title?: string; description?: string; directApply?: DirectApplySignals }): boolean {
  const signals = detectDirectApply(job);
  if (signals) job.directApply = signals;
  return !!signals;
}

/**
 * Should this job fire an instant banner on its own merits, regardless of how it
 * scored? `minScore` defaults to 0 — the whole point is that a low-ranked
 * posting with a recruiter's inbox in it still deserves the interrupt.
 */
export function shouldAlertDirect(job: { score?: number; directApply?: DirectApplySignals }): boolean {
  if (!CONFIG.directApply.enabled) return false;
  if (!job.directApply?.direct) return false;
  return (job.score ?? 0) >= CONFIG.directApply.minScore;
}

/** One-line summary for a banner/log, e.g. "email hr@acme.in · immediate joiner". */
export function summarizeDirectApply(s: DirectApplySignals, max = 3): string {
  return s.hits.slice(0, max).map((h) => (h.kind === "email" ? h.label : h.label)).join(" · ");
}

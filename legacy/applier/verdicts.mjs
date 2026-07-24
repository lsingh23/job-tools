// Verdict cache (blueprint Part 4, Move 3): every ACCEPT/REJECT the verifier ever makes about
// a (keyword ⟵ evidence) pair is stored forever. The master resume is static, so the verdict
// "Playwright given evidence Cypress → ACCEPT" is true for every future JD — the rule map
// writes itself. After a few hundred applications almost everything is a cache hit and the AI
// only ever adjudicates a pair once.
//
// The cache is keyed by a hash of the master resume text: if the master changes, its evidence
// changes, so old verdicts must not apply. A stale-key load starts fresh (old file is kept for
// audit under the previous key).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = process.env.VERDICTS_FILE ?? path.join(HERE, "verdicts.json");

/** Stable 12-hex fingerprint of the master resume's plain text. */
export function masterHash(masterText) {
  return createHash("sha256").update(masterText.trim()).digest("hex").slice(0, 12);
}

// Cache key: the normalized KEYWORD. The master resume is static (the file is hash-keyed, so a
// changed master resets the cache), which makes "is <keyword> a credible add against THIS
// master" a single stable fact — independent of which exact substring the (non-deterministic)
// proposer happened to quote this time. Keying on the keyword is what delivers the blueprint's
// promise that the AI adjudicates each keyword only once. The evidence quote is still recorded
// in the entry (for the badge and audit), just not in the key.
const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
export const verdictKey = (keyword) => norm(keyword);

/**
 * Load the cache for a given master. Shape on disk:
 *   { "master": "<hash>", "verdicts": { "<keyword>": { verdict, by, at, evidence?, reason? } } }
 * If the file is missing, unparseable, or keyed to a different master, an empty cache is
 * returned (never throws) — a fresh master simply relearns.
 */
export function loadVerdicts(masterText, file = DEFAULT_FILE) {
  const hash = masterHash(masterText);
  let data = { master: hash, verdicts: {} };
  if (existsSync(file)) {
    try {
      const disk = JSON.parse(readFileSync(file, "utf8"));
      if (disk && disk.master === hash && disk.verdicts) data = disk;
    } catch { /* corrupt/foreign cache → start clean */ }
  }
  return new VerdictCache(hash, data.verdicts, file);
}

export class VerdictCache {
  constructor(hash, verdicts, file) {
    this.hash = hash;
    this.verdicts = verdicts ?? {};
    this.file = file;
  }

  /** Cached verdict for a keyword, or null if never judged. */
  get(keyword) {
    return this.verdicts[verdictKey(keyword)] ?? null;
  }

  /** True iff this keyword has a stored verdict of either kind. */
  has(keyword) {
    return verdictKey(keyword) in this.verdicts;
  }

  /** Record a verdict. `by`: "ai" | "user-veto" | "user-approve". Later writes overwrite earlier
   *  ones — this is how a badge veto flips a wrong AI ACCEPT to a permanent REJECT. The evidence
   *  quote is stored for display/audit but does not affect the key. */
  set(keyword, verdict, { evidence = "", by = "ai", reason = "" } = {}) {
    if (verdict !== "ACCEPT" && verdict !== "REJECT") throw new Error(`bad verdict: ${verdict}`);
    this.verdicts[verdictKey(keyword)] = {
      verdict, by, at: new Date().toISOString().slice(0, 10),
      ...(evidence ? { evidence } : {}), ...(reason ? { reason } : {}),
    };
    return this;
  }

  /** A user's veto in the badge: a permanent REJECT that outranks any AI verdict. */
  veto(keyword, { evidence = "", reason = "user vetoed" } = {}) {
    return this.set(keyword, "REJECT", { evidence, by: "user-veto", reason });
  }

  /** Partition proposer claims into { cachedAccept, cachedReject, uncached } so the verifier is
   *  only ever asked about keywords it has never seen. Each claim needs { keyword }. */
  partition(claims) {
    const cachedAccept = [], cachedReject = [], uncached = [];
    for (const c of claims) {
      const v = this.get(c.keyword);
      if (!v) uncached.push(c);
      else if (v.verdict === "ACCEPT") cachedAccept.push({ ...c, verdict: v });
      else cachedReject.push({ ...c, verdict: v });
    }
    return { cachedAccept, cachedReject, uncached };
  }

  /** Persist to disk (pretty-printed for hand-inspection/audit). */
  save() {
    writeFileSync(this.file, JSON.stringify({ master: this.hash, verdicts: this.verdicts }, null, 2) + "\n");
    return this;
  }
}

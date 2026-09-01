import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../config.js";

/** Random int in [min, max]. Seeded only by clock — fine for jitter. */
function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let lastUaIndex = -1;
function nextUserAgent(): string {
  const uas = CONFIG.http.userAgents;
  lastUaIndex = (lastUaIndex + 1) % uas.length;
  return uas[lastUaIndex]!;
}

function cachePath(key: string): string {
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 16);
  return join(CONFIG.data.cacheDir, `${hash}.cache`);
}

function readCache(key: string, ttlMinutes: number): string | null {
  const p = cachePath(key);
  if (!existsSync(p)) return null;
  const ageMin = (Date.now() - statSync(p).mtimeMs) / 60000;
  if (ageMin > ttlMinutes) return null;
  return readFileSync(p, "utf8");
}

function writeCache(key: string, body: string): void {
  mkdirSync(CONFIG.data.cacheDir, { recursive: true });
  writeFileSync(cachePath(key), body, "utf8");
}

// ── Per-host request gate ───────────────────────────────────────────────────
/**
 * ONE queue in front of each rate-sensitive host, shared by every caller in the
 * process.
 *
 * The polite delay below is per-CALL, which is only "polite" while a single loop
 * is running. Two schedulers hitting the same host each keep their own 2.5-5s
 * promise, so the host sees double the rate — and, worse, sees requests land
 * simultaneously, which is the pattern that actually looks automated. (Until
 * now this was safe by accident: the city collector and the ATS poller target
 * completely different hosts.)
 *
 * The gate makes the spacing a property of the HOST, not of the caller. Any
 * number of loops can share it and the host still sees one request every
 * minGap-maxGap ms, from one identity at a time.
 *
 * `priority` is what makes a fast loop possible: a lower number jumps the queue,
 * so the hot checker's handful of requests overtake the wide sweep's backlog
 * instead of waiting out ~170 of them. Equal priorities are strictly FIFO.
 *
 * Hosts with no entry in CONFIG.http.gates are NOT gated and keep their exact
 * previous behaviour — the ATS collector deliberately runs 6-wide against
 * first-party JSON APIs (src/sources/ats.ts) and must not be serialised.
 */
interface Waiter { priority: number; seq: number; release: () => void }
interface HostGate {
  waiting: Waiter[];
  lastReleaseAt: number;
  pumping: boolean;
  /** Set when the host pushes back (429/403); the gate stays shut until then. */
  cooldownUntil: number;
  released: number;
  blocked: number;
  lastBlockAt: number | null;
}
type GateCfg = { key: string; minGapMs: number; maxGapMs: number };

const gates = new Map<string, HostGate>();
let waiterSeq = 0;

function newGate(): HostGate {
  return { waiting: [], lastReleaseAt: 0, pumping: false, cooldownUntil: 0, released: 0, blocked: 0, lastBlockAt: null };
}

/** The gate config for a URL's host, or null when the host is ungated. */
function gateFor(url: string): GateCfg | null {
  let host: string;
  try { host = new URL(url).hostname; } catch { return null; }
  for (const [suffix, cfg] of Object.entries(CONFIG.http.gates)) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return { key: suffix, ...cfg };
  }
  return null;
}

/** Release one waiter, then re-arm for the next. Never runs two pumps at once. */
function pump(cfg: GateCfg, gate: HostGate): void {
  if (gate.pumping || gate.waiting.length === 0) return;
  gate.pumping = true;
  const gap = rand(cfg.minGapMs, cfg.maxGapMs);
  // An idle host releases immediately (lastReleaseAt is long past); a busy one
  // waits out the gap. A cooldown from a 429/403 overrides both.
  const wait = Math.max(0, gate.lastReleaseAt + gap - Date.now(), gate.cooldownUntil - Date.now());
  setTimeout(() => {
    // Lowest priority number first; FIFO within a priority.
    gate.waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const next = gate.waiting.shift();
    gate.lastReleaseAt = Date.now();
    gate.pumping = false;
    if (next) { gate.released++; next.release(); }
    pump(cfg, gate);
  }, wait);
}

/** Wait for this host's next slot. */
function acquire(cfg: GateCfg, priority: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const gate = gates.get(cfg.key) ?? newGate();
    gates.set(cfg.key, gate);
    gate.waiting.push({ priority, seq: waiterSeq++, release: resolve });
    pump(cfg, gate);
  });
}

/**
 * Record host push-back and shut the gate for a while. This is the circuit
 * breaker: a soft block degrades every loop to "wait", instead of letting the
 * retry ladder hammer through it.
 */
function noteBlocked(url: string): void {
  const cfg = gateFor(url);
  if (!cfg) return;
  const gate = gates.get(cfg.key) ?? newGate();
  gates.set(cfg.key, gate);
  gate.blocked++;
  gate.lastBlockAt = Date.now();
  gate.cooldownUntil = Math.max(gate.cooldownUntil, Date.now() + CONFIG.http.blockCooldownMs);
  process.stderr.write(
    `  [gate] ${cfg.key} pushed back (${gate.blocked} total) — pausing all requests to it for ` +
      `${Math.round(CONFIG.http.blockCooldownMs / 1000)}s\n`,
  );
}

/**
 * Live gate counters, for the dashboard. This is the instrumentation that lets
 * the real rate ceiling reveal itself from normal running, rather than by
 * probing for it (probing for a block is how you get the block).
 */
export function gateStats(): Record<string, {
  queued: number; released: number; blocked: number;
  lastBlockAt: string | null; cooldownMsLeft: number;
}> {
  const out: Record<string, ReturnType<typeof gateStats>[string]> = {};
  for (const [key, g] of gates) {
    out[key] = {
      queued: g.waiting.length,
      released: g.released,
      blocked: g.blocked,
      lastBlockAt: g.lastBlockAt ? new Date(g.lastBlockAt).toISOString() : null,
      cooldownMsLeft: Math.max(0, g.cooldownUntil - Date.now()),
    };
  }
  return out;
}

export interface FetchOpts {
  headers?: Record<string, string>;
  /** HTTP verb. Defaults to GET. */
  method?: string;
  /** Request body for POST/PUT (Workday's CXS search and Serper both need it). */
  body?: string;
  /** Skip the polite pre-request delay (e.g. first request of a run). Ignored
   *  for gated hosts — there the gate decides, and an idle gate is instant anyway. */
  noDelay?: boolean;
  /**
   * Queue priority for gated hosts: LOWER goes first. Default 1 ("normal", the
   * wide sweep); the hot checker passes 0 so its few requests overtake a long
   * backlog. Ignored for ungated hosts.
   */
  priority?: number;
  /** Cache key; if set, responses are cached on disk for the TTL. */
  cacheKey?: string;
  /** Override the default cache TTL — for data that ages slowly (e.g. salary aggregates). */
  ttlMinutes?: number;
  /**
   * Override the retry budget. Lower it for a flaky OPTIONAL source that has a
   * fallback (crt.sh 502s for minutes at a time; burning the full backoff ladder
   * on it just delays the alternative that would have worked).
   */
  maxRetries?: number;
  label?: string;
}

/**
 * A non-2xx response we deliberately do NOT retry (4xx other than 429/403).
 * Carries the status + response body so a source can inspect it and decide
 * whether it's fatal or expected (e.g. Naukri 400 "page doesn't exist" = end
 * of pagination, not breakage).
 */
export class HttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
  }
}

/**
 * Polite fetch: jittered human-like delay, rotating UA + realistic headers,
 * on-disk caching, and exponential backoff with jitter on 429/403/5xx.
 * Throws a clear error after exhausting retries so the source fails loudly.
 */
export async function politeFetch(url: string, opts: FetchOpts = {}): Promise<string> {
  if (opts.cacheKey) {
    const cached = readCache(opts.cacheKey, opts.ttlMinutes ?? CONFIG.http.cacheTtlMinutes);
    if (cached !== null) {
      process.stderr.write(`  [cache] ${opts.label ?? url}\n`);
      return cached;
    }
  }

  // Gated hosts get their spacing from the shared queue instead (per attempt,
  // below), so every loop in the process draws on one budget.
  const gate = gateFor(url);
  if (!gate && !opts.noDelay) {
    await sleep(rand(CONFIG.http.minDelayMs, CONFIG.http.maxDelayMs));
  }

  const maxRetries = opts.maxRetries ?? CONFIG.http.maxRetries;
  let lastErr = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (gate) await acquire(gate, opts.priority ?? 1);
    if (attempt > 0) {
      const backoff = CONFIG.http.backoffBaseMs * 2 ** (attempt - 1) + rand(0, 1000);
      process.stderr.write(`  [retry ${attempt}/${maxRetries}] ${opts.label ?? url} after ${backoff}ms — ${lastErr}\n`);
      await sleep(backoff);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.http.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        method: opts.method ?? "GET",
        body: opts.body,
        headers: {
          "User-Agent": nextUserAgent(),
          Accept: "text/html,application/json,application/xhtml+xml,*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          ...opts.headers,
        },
      });

      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        // 429/403 is the host telling us to stop; a 5xx is its own problem and
        // must NOT trip the breaker (that would pause a healthy loop over an
        // upstream hiccup).
        if (res.status === 429 || res.status === 403) noteBlocked(url);
        continue; // backoff + retry
      }

      const body = await res.text();
      // Other client errors (400/404/…) won't fix themselves on retry — fail
      // fast and hand the body to the caller so it can classify the error.
      if (!res.ok) throw new HttpError(res.status, body);

      if (opts.cacheKey) writeCache(opts.cacheKey, body);
      return body;
    } catch (err) {
      if (err instanceof HttpError) throw err; // non-retryable by design
      lastErr = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Failed after ${maxRetries} retries: ${lastErr}`);
}

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

function readCache(key: string): string | null {
  const p = cachePath(key);
  if (!existsSync(p)) return null;
  const ageMin = (Date.now() - statSync(p).mtimeMs) / 60000;
  if (ageMin > CONFIG.http.cacheTtlMinutes) return null;
  return readFileSync(p, "utf8");
}

function writeCache(key: string, body: string): void {
  mkdirSync(CONFIG.data.cacheDir, { recursive: true });
  writeFileSync(cachePath(key), body, "utf8");
}

export interface FetchOpts {
  headers?: Record<string, string>;
  /** Skip the polite pre-request delay (e.g. first request of a run). */
  noDelay?: boolean;
  /** Cache key; if set, responses are cached on disk for the TTL. */
  cacheKey?: string;
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
    const cached = readCache(opts.cacheKey);
    if (cached !== null) {
      console.log(`  [cache] ${opts.label ?? url}`);
      return cached;
    }
  }

  if (!opts.noDelay) {
    await sleep(rand(CONFIG.http.minDelayMs, CONFIG.http.maxDelayMs));
  }

  let lastErr = "";
  for (let attempt = 0; attempt <= CONFIG.http.maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = CONFIG.http.backoffBaseMs * 2 ** (attempt - 1) + rand(0, 1000);
      console.warn(`  [retry ${attempt}/${CONFIG.http.maxRetries}] ${opts.label ?? url} after ${backoff}ms — ${lastErr}`);
      await sleep(backoff);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.http.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
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
  throw new Error(`Failed after ${CONFIG.http.maxRetries} retries: ${lastErr}`);
}

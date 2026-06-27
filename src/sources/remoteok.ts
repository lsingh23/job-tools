import { CONFIG } from "../../config.js";
import { politeFetch } from "../http.js";
import type { Job } from "../types.js";
import type { Source } from "./base.js";

/** RemoteOK: free JSON API. TERMS: attribute RemoteOK + link back to the listing. */
interface RemoteOkJob {
  id?: string;
  slug?: string;
  position?: string;
  company?: string;
  tags?: string[];
  description?: string;
  date?: string;
  url?: string;
  location?: string;
  salary_min?: number;
  salary_max?: number;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// Frontend signals matched with word boundaries (no bare "ui"/"next" substrings
// that would hit "recrUIt"/"conText"). RemoteOK's /api is an unsearchable
// firehose of all recent jobs, so this filter is the only relevance gate.
const FE_SIGNALS = [
  "react",
  "reactjs",
  "frontend",
  "front end",
  "front-end",
  "next.js",
  "nextjs",
  "javascript",
  "typescript",
  "ui engineer",
  "ui developer",
  "web developer",
  "full stack",
  "fullstack",
  "full-stack",
  "software engineer",
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasFrontendSignal(text: string): boolean {
  return FE_SIGNALS.some((sig) => {
    const re = new RegExp(`(?<![a-z0-9])${escapeRe(sig)}(?![a-z0-9])`, "i");
    return re.test(text);
  });
}

export const remoteokSource: Source = {
  name: "remoteok",
  async fetchJobs(): Promise<Job[]> {
    const body = await politeFetch(CONFIG.endpoints.remoteok, { cacheKey: "remoteok:all", label: "remoteok" });

    let arr: RemoteOkJob[];
    try {
      arr = JSON.parse(body);
    } catch {
      throw new Error("RemoteOK returned non-JSON (API shape may have changed)");
    }
    if (!Array.isArray(arr)) throw new Error("RemoteOK did not return an array");

    const maxAgeMs = CONFIG.freshness.apiMaxAgeHours * 3600_000;
    const out: Job[] = [];

    // First element is a legal/attribution notice, not a job — skip entries with no id/position.
    for (const j of arr) {
      if (!j.id || !j.position) continue;

      // Match the TITLE only — RemoteOK's tags are SEO spam (a People-Ops manager
      // is tagged "engineer"/"api"/"cloud"), so tag matching is useless here.
      if (!hasFrontendSignal(j.position.toLowerCase())) continue;

      const posted = j.date ? Date.parse(j.date) : NaN;
      if (!Number.isNaN(posted) && Date.now() - posted > maxAgeMs) continue;

      const salary =
        j.salary_min || j.salary_max
          ? `${j.salary_min ?? "?"}–${j.salary_max ?? "?"}`
          : null;

      out.push({
        source: "remoteok",
        externalId: `remoteok:${j.id}`,
        title: j.position,
        company: j.company ?? "",
        location: j.location || "Remote",
        url: j.url ?? `https://remoteok.com/remote-jobs/${j.slug ?? j.id}`,
        description: stripHtml(j.description ?? ""),
        postedAt: Number.isNaN(posted) ? null : new Date(posted).toISOString(),
        salary,
        remote: true,
        tags: j.tags ?? [],
      });
    }
    return out;
  },
};

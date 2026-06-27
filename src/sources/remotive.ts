import { CONFIG } from "../../config.js";
import { politeFetch } from "../http.js";
import type { Job } from "../types.js";
import type { Source } from "./base.js";

/** Remotive: free JSON API. TERMS: attribute Remotive + link back; data may lag ~24h. */
interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category: string;
  tags: string[];
  job_type: string;
  publication_date: string;
  candidate_required_location: string;
  salary: string;
  description: string;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export const remotiveSource: Source = {
  name: "remotive",
  async fetchJobs(): Promise<Job[]> {
    const out: Job[] = [];
    const seen = new Set<number>();
    const maxAgeMs = CONFIG.freshness.apiMaxAgeHours * 3600_000;

    for (const term of CONFIG.locations.keywordsForApis) {
      const url = `${CONFIG.endpoints.remotive}?search=${encodeURIComponent(term)}&limit=50`;
      const body = await politeFetch(url, { cacheKey: `remotive:${term}`, label: `remotive "${term}"` });

      let data: { jobs?: RemotiveJob[] };
      try {
        data = JSON.parse(body);
      } catch {
        throw new Error("Remotive returned non-JSON (API shape may have changed)");
      }
      if (!Array.isArray(data.jobs)) throw new Error("Remotive JSON missing 'jobs' array");

      for (const j of data.jobs) {
        if (seen.has(j.id)) continue;
        seen.add(j.id);

        const posted = Date.parse(j.publication_date);
        if (!Number.isNaN(posted) && Date.now() - posted > maxAgeMs) continue;

        out.push({
          source: "remotive",
          externalId: `remotive:${j.id}`,
          title: j.title,
          company: j.company_name,
          location: j.candidate_required_location || "Remote",
          url: j.url,
          description: stripHtml(j.description ?? ""),
          postedAt: Number.isNaN(posted) ? null : new Date(posted).toISOString(),
          salary: j.salary || null,
          remote: true,
          tags: j.tags ?? [],
        });
      }
    }
    return out;
  },
};

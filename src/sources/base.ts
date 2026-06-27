import type { Job, SourceResult } from "../types.js";

export interface Source {
  name: string;
  /** Fetch + normalize jobs. May throw — runSource wraps it. */
  fetchJobs(): Promise<Job[]>;
}

/**
 * Runs a source with per-source isolation: a thrown error (block, HTML change,
 * timeout) is caught and logged loudly, but never crashes the whole run.
 */
export async function runSource(source: Source): Promise<SourceResult> {
  console.log(`\n▶ ${source.name}`);
  try {
    const jobs = await source.fetchJobs();
    console.log(`  ✓ ${source.name}: ${jobs.length} jobs`);
    return { source: source.name, ok: true, jobs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${source.name} FAILED: ${msg}`);
    console.error(`    (other sources continue. Check selectors/params in config.ts for "${source.name}".)`);
    return { source: source.name, ok: false, jobs: [], error: msg };
  }
}

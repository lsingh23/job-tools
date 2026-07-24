import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";

// Keep model files in the project, not ~/.cache
env.cacheDir = "./.model-cache";

const MODEL = "Xenova/nomic-embed-text-v1";
const BATCH = 32;

let _pipe: FeatureExtractionPipeline | null = null;

/**
 * Progress goes to STDERR, never stdout. `src/search.ts` is spawned by the
 * dashboard under a strict contract — stdout carries exactly one JSON object,
 * stderr carries logs — so a stray stdout write here silently corrupts the
 * dashboard's JSON.parse and surfaces as "Search exited 0 with no parseable
 * output" long after this function returned. Keep every byte on stderr.
 */
async function getPipe(): Promise<FeatureExtractionPipeline> {
  if (_pipe) return _pipe;
  process.stderr.write(`  [embed] Loading ${MODEL} (first run: ~274 MB download)…`);
  _pipe = (await pipeline("feature-extraction", MODEL, { dtype: "q8" })) as FeatureExtractionPipeline;
  process.stderr.write(" ready.\n");
  return _pipe;
}

/**
 * Embed texts in batches of 32. Applies nomic's "clustering" task prefix so
 * the model treats both resume and job text symmetrically.
 * Returns one normalized float vector per input string.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const fn = await getPipe();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => `clustering: ${t}`);
    const tensor = await fn(batch, { pooling: "mean", normalize: true });
    const raw = (tensor as any).tolist() as number[][] | number[][][];
    // Shape is [N, D] with pooling=mean, but guard against [N, 1, D].
    for (const row of raw) {
      out.push(Array.isArray(row[0]) ? (row as number[][])[0]! : (row as number[]));
    }
  }
  return out;
}

/** Cosine similarity. Both vectors are already L2-normalized so this is a dot product. */
export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

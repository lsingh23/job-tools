/**
 * Lightweight TF-IDF cosine similarity — no model, no downloads, runs in ms.
 *
 * How it works:
 *   1. Tokenise every document into cleaned unigrams.
 *   2. Build IDF weights from the full corpus (resume + all JDs).
 *      Rare/distinctive words ("WebContainers", "RSC", "App Router") get high
 *      weight; generic posting words ("team", "role", "experience") get low weight.
 *   3. Represent each doc as a sparse L2-normalised TF-IDF vector.
 *   4. Cosine similarity = dot product of two normalised vectors → 0..1.
 *
 * For technical job descriptions the vocabulary is domain-specific enough that
 * this gives strong signal without any neural model.
 */

// Words that carry no signal in job-description matching.
const STOP = new Set([
  // Articles / prepositions / conjunctions
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "by","from","as","if","so","than","into","via","per","out","up","its",
  // Common verbs
  "is","are","was","were","be","been","being","have","has","had","do",
  "does","did","will","would","could","should","may","might","can","not",
  "use","used","using","work","working","build","building","help","ensure",
  // Pronouns / determiners
  "we","you","it","our","your","they","them","their","this","that","these",
  "those","who","what","how","when","where","why","us","i","me","my",
  // Generic job-ad filler
  "team","role","job","position","opportunity","candidate","hire","hiring",
  "join","joining","apply","application","company","organization","firm",
  "experience","years","year","months","strong","good","great","excellent",
  "required","preferred","plus","bonus","ability","knowledge","understanding",
  "skills","skill","including","such","across","within","looking","seeking",
  "based","new","well","key","high","large","own","different","various",
  "day","days","time","make","making","need","needs","also","just","more",
  "most","all","any","both","each","other","some","no","nor","not","very",
  "about","after","before","between","during","through","above","below",
  // Numbers / misc
  "1","2","3","4","5","6","7","8","9","0","eg","ie","etc","via","vs",
]);

/** Tokenise text: lowercase, split on non-word chars, drop stopwords & short tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    // Preserve compound tech tokens: "next.js", "c++", "ui/ux", "react-query"
    .replace(/([a-z0-9])[\s]+([a-z0-9])/g, (_, a, b) => `${a} ${b}`)
    .split(/[^a-z0-9#+.\-/]+/)
    .map((t) => t.replace(/^[.\-/#+]+|[.\-/#+]+$/g, "")) // strip leading/trailing punctuation
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Build IDF (Inverse Document Frequency) from a corpus of documents.
 * Uses smoothed IDF: log((N+1)/(df+1))+1 — prevents zero weights.
 */
export function buildIdf(docs: string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(tokenize(doc))) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  const N = docs.length;
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log((N + 1) / (count + 1)) + 1);
  }
  return idf;
}

/**
 * Compute a sparse, L2-normalised TF-IDF vector for `text` given a pre-built IDF.
 * Returns a Map<term, weight> — only non-zero entries.
 */
export function vectorize(text: string, idf: Map<string, number>): Map<string, number> {
  const tokens = tokenize(text);
  if (!tokens.length) return new Map();

  // Raw term frequency (relative)
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  // TF-IDF weights
  const vec = new Map<string, number>();
  let norm = 0;
  for (const [t, freq] of tf) {
    const w = (freq / tokens.length) * (idf.get(t) ?? 1);
    vec.set(t, w);
    norm += w * w;
  }

  // L2 normalise
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (const [t, w] of vec) vec.set(t, w / norm);
  }
  return vec;
}

/** Cosine similarity of two L2-normalised sparse vectors. Result is 0..1. */
export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  // Iterate the smaller map for efficiency
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, wa] of small) {
    const wb = large.get(t);
    if (wb !== undefined) dot += wa * wb;
  }
  return Math.min(1, Math.max(0, dot));
}

/**
 * Score a resume against a batch of JD texts.
 *
 * Builds IDF from the combined corpus so domain-specific terms that appear
 * across many JDs get down-weighted (common noise) and terms that are
 * distinctive to fewer JDs — and to YOUR resume — get up-weighted.
 *
 * Returns one similarity score (0..1) per JD, same order as `jdTexts`.
 */
export function scoreResumeVsJds(
  resumeText: string,
  jdTexts: string[],
): number[] {
  if (!jdTexts.length) return [];
  const idf       = buildIdf([resumeText, ...jdTexts]);
  const resumeVec = vectorize(resumeText, idf);
  return jdTexts.map((jd) => cosine(resumeVec, vectorize(jd, idf)));
}

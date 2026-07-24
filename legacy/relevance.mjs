// Zero-dependency TF-IDF cosine — a plain-JS port of src/tfidf.ts so the applier
// (deliberately npm-dep-free) can rank bullets by JD relevance and score a resume
// against a JD without pulling in the neural embedder (src/embed.ts / 274 MB model).
//
// For technical job descriptions the vocabulary is domain-specific enough that
// TF-IDF gives strong signal: rare/distinctive words ("WebContainers", "agentic",
// "RSC") get high weight; generic posting words ("team", "role") get ~none.

// Words that carry no signal in job-description matching.
const STOP = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "by","from","as","if","so","than","into","via","per","out","up","its",
  "is","are","was","were","be","been","being","have","has","had","do",
  "does","did","will","would","could","should","may","might","can","not",
  "use","used","using","work","working","build","building","help","ensure",
  "we","you","it","our","your","they","them","their","this","that","these",
  "those","who","what","how","when","where","why","us","i","me","my",
  "team","role","job","position","opportunity","candidate","hire","hiring",
  "join","joining","apply","application","company","organization","firm",
  "experience","years","year","months","strong","good","great","excellent",
  "required","preferred","plus","bonus","ability","knowledge","understanding",
  "skills","skill","including","such","across","within","looking","seeking",
  "based","new","well","key","high","large","own","different","various",
  "day","days","time","make","making","need","needs","also","just","more",
  "most","all","any","both","each","other","some","no","nor","very",
  "about","after","before","between","during","through","above","below",
  "eg","ie","etc","vs",
]);

/** Tokenise text: lowercase, split on non-word chars, drop stopwords & short tokens. */
export function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    // Preserve compound tech tokens: "next.js", "c++", "ui/ux", "react-query"
    .replace(/([a-z0-9])[\s]+([a-z0-9])/g, (_, a, b) => `${a} ${b}`)
    .split(/[^a-z0-9#+.\-/]+/)
    .map((t) => t.replace(/^[.\-/#+]+|[.\-/#+]+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Smoothed IDF: log((N+1)/(df+1))+1 over a corpus of documents. */
export function buildIdf(docs) {
  const df = new Map();
  for (const doc of docs) {
    for (const term of new Set(tokenize(doc))) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const N = docs.length;
  const idf = new Map();
  for (const [term, count] of df) idf.set(term, Math.log((N + 1) / (count + 1)) + 1);
  return idf;
}

/** Sparse, L2-normalised TF-IDF vector for `text` given a pre-built IDF. */
export function vectorize(text, idf) {
  const tokens = tokenize(text);
  if (!tokens.length) return new Map();
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const vec = new Map();
  let norm = 0;
  for (const [t, freq] of tf) {
    const w = (freq / tokens.length) * (idf.get(t) ?? 1);
    vec.set(t, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (const [t, w] of vec) vec.set(t, w / norm);
  return vec;
}

/** Cosine similarity of two L2-normalised sparse vectors. Result is 0..1. */
export function cosine(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, wa] of small) {
    const wb = large.get(t);
    if (wb !== undefined) dot += wa * wb;
  }
  return Math.min(1, Math.max(0, dot));
}

/**
 * Relevance of one bullet to the JD, 0..1. `idf` should be built once per resume
 * from [jd, ...allBullets] (see makeBulletIdf) so terms distinctive to a bullet AND
 * present in the JD dominate the score.
 */
export function bulletRelevance(bulletText, jd, idf) {
  return cosine(vectorize(bulletText, idf), vectorize(jd, idf));
}

/** Build an IDF once from the JD plus every bullet, for repeated bulletRelevance calls. */
export function makeBulletIdf(jd, bullets) {
  return buildIdf([jd, ...bullets]);
}

/** Whole-resume vs JD cosine — the per-application coverage trend metric. */
export function resumeJdCosine(resumeText, jd) {
  const idf = buildIdf([resumeText, jd]);
  return cosine(vectorize(resumeText, idf), vectorize(jd, idf));
}

// Loads editable system prompts from applier/prompts/*.txt and substitutes
// {{PLACEHOLDER}} tokens. Read fresh on every call so edits apply without a
// server restart. See applier/prompts/README.md for the available placeholders.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.PROMPTS_DIR ?? path.join(HERE, "prompts");

/** Load prompts/<name>.txt and replace every {{KEY}} with vars[KEY]. */
export function loadPrompt(name, vars = {}) {
  const file = path.join(DIR, `${name}.txt`);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`prompt file not found: ${file} (see applier/prompts/README.md)`);
  }
  for (const [k, v] of Object.entries(vars)) text = text.split(`{{${k}}}`).join(String(v));
  return text.trim();
}

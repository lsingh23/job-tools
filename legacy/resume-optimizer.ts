/**
 * Resume optimizer: validates and corrects AI-generated keyword optimizations.
 * Enforces the SWAP constraint: item count per skill category must match master,
 * and lines must not grow beyond a safe width.
 */

export interface MasterResume {
  summary: string;
  skills: Record<string, string>; // e.g. { "Frontend": "React.js, Next.js, ..." }
  experience: Array<{ role: string; bullets: string[] }>;
}

export interface OptimizedResume {
  summary: string;
  skills: Record<string, string>;
  experience_edits?: Array<{
    role: string;
    edits: Array<{ original: string; revised: string }>;
  }>;
  edits?: Array<{ original: string; revised: string }>; // alternate format
}

/**
 * Parse a comma-separated skill string into an array of trimmed items.
 * Handles parentheticals: "Next.js (App Router, RSC)" counts as one item.
 */
function parseSkillItems(skillStr: string): string[] {
  const items: string[] = [];
  let current = "";
  let depth = 0;

  for (const char of skillStr) {
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) items.push(trimmed);
      current = "";
      continue;
    }
    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) items.push(trimmed);
  return items;
}

/**
 * Enforce SWAP constraint: for each category, truncate optimized skills
 * back to match master item count. Preserves JD keywords at the front,
 * removes overflow from the end.
 */
export function enforceSwapConstraint(
  optimized: OptimizedResume,
  master: MasterResume,
): OptimizedResume {
  const correctedSkills: Record<string, string> = {};

  for (const [category, masterStr] of Object.entries(master.skills)) {
    const masterItems = parseSkillItems(masterStr);
    const masterCount = masterItems.length;

    // If AI output doesn't have this category, keep master as-is
    if (!optimized.skills[category]) {
      correctedSkills[category] = masterStr;
      continue;
    }

    const optimizedItems = parseSkillItems(optimized.skills[category]);

    // If optimized count > master count, truncate to master count
    if (optimizedItems.length > masterCount) {
      const truncated = optimizedItems.slice(0, masterCount);
      correctedSkills[category] = truncated.join(", ");
      console.warn(
        `[SWAP violation] ${category}: AI added ${optimizedItems.length - masterCount} items. ` +
          `Truncated back to ${masterCount}.`,
      );
    } else if (optimizedItems.length < masterCount) {
      // AI removed items; pad back with master items not in optimized
      const optimizedSet = new Set(optimizedItems.map((s) => s.toLowerCase()));
      const needed = masterCount - optimizedItems.length;
      const toAdd = masterItems
        .filter((m) => !optimizedSet.has(m.toLowerCase()))
        .slice(0, needed);

      correctedSkills[category] = [...optimizedItems, ...toAdd].join(", ");
      console.warn(
        `[SWAP violation] ${category}: AI removed ${needed} items. ` +
          `Restored from master.`,
      );
    } else {
      correctedSkills[category] = optimized.skills[category];
    }
  }

  return {
    ...optimized,
    skills: correctedSkills,
  };
}

/**
 * Validate and correct the full optimized resume.
 * - Enforces SWAP constraint on skills
 * - Checks summary length
 * - Returns corrected output ready to apply
 */
export function validateAndCorrect(
  optimized: OptimizedResume,
  master: MasterResume,
  summaryMaxChars: number = 340,
): { valid: boolean; errors: string[]; corrected: OptimizedResume } {
  const errors: string[] = [];

  // Check summary length
  if (optimized.summary.length > summaryMaxChars) {
    errors.push(
      `Summary ${optimized.summary.length}/${summaryMaxChars} chars (exceeds limit). ` +
        `Truncating to fit.`,
    );
    // Simple truncation: cut at last sentence before limit
    let truncated = optimized.summary.substring(0, summaryMaxChars);
    const lastPeriod = truncated.lastIndexOf(".");
    if (lastPeriod > 200) {
      // Keep at least 200 chars
      truncated = truncated.substring(0, lastPeriod + 1);
    }
    optimized.summary = truncated.trim();
  }

  // Enforce SWAP on skills
  const corrected = enforceSwapConstraint(optimized, master);

  return {
    valid: errors.length === 0,
    errors,
    corrected,
  };
}

/**
 * Apply validated edits to a master resume.
 * - Updates skills
 * - Updates summary
 * - Applies bullet edits (finds exact match, replaces)
 */
export function applyOptimization(
  master: MasterResume,
  optimized: OptimizedResume,
): MasterResume {
  const updated = JSON.parse(JSON.stringify(master)) as MasterResume;

  // Apply summary
  updated.summary = optimized.summary;

  // Apply skills
  updated.skills = { ...updated.skills, ...optimized.skills };

  // Apply bullet edits
  const editsToApply = optimized.experience_edits || optimized.edits || [];

  for (const roleEdits of editsToApply) {
    const roleIndex = updated.experience.findIndex(
      (exp) =>
        exp.role.toLowerCase().includes(roleEdits.role.split(" — ")[0].toLowerCase()) ||
        exp.role.includes(roleEdits.role),
    );

    if (roleIndex >= 0) {
      for (const edit of roleEdits.edits) {
        const bulletIndex = updated.experience[roleIndex].bullets.findIndex(
          (b) => b === edit.original,
        );
        if (bulletIndex >= 0) {
          updated.experience[roleIndex].bullets[bulletIndex] = edit.revised;
        } else {
          console.warn(`Could not find bullet: "${edit.original.substring(0, 60)}..."`);
        }
      }
    } else {
      console.warn(`Could not find role: ${roleEdits.role}`);
    }
  }

  return updated;
}

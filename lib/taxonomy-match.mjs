/**
 * Shared taxonomy label matching.
 *
 * Product rows store category *labels* (not ids), and historic imports left
 * whitespace/case variants behind ("Fasteners " vs "fasteners"). Every code
 * path that compares a DB label against a taxonomy node label — rename,
 * delete, counting, browse filtering — must use the same rules or they
 * drift apart and the admin lies about what's where.
 */

/** Canonical form for comparison: collapse whitespace, trim, lowercase. */
export function normalizeLabel(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True when a DB column value refers to the given taxonomy node label. */
export function matchesTaxonomyLabel(dbValue, treeLabel) {
  const target = normalizeLabel(treeLabel);
  if (!target) return false;
  return normalizeLabel(dbValue) === target;
}

/** Escape %, _ and \ so a label can be embedded in an ilike pattern. */
export function escapeIlikePattern(value) {
  return String(value ?? '').replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Parse the `subcategory_extra` column (JSON array of labels for taxonomy
 * depth beyond subcategory_four) into an array. Never throws.
 */
export function parseExtraLabels(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * True when a row's label columns match a node scope:
 * scope = { category: label, subcategory_one: label, ... } as produced by
 * buildNodeProductFilter / buildRenameFilter. Whitespace/case tolerant.
 *
 * A scope value may be an array — used for the `subcategory_extra` column,
 * which stores taxonomy depth beyond subcategory_four as a single JSON array.
 * An array value is matched as a positional PREFIX against the row's parsed
 * extras (the row may have deeper elements after it — that's a descendant,
 * which should still match, mirroring how a single-column filter never
 * constrains columns deeper than itself).
 */
export function rowMatchesLabelScope(row, scopeFilters) {
  for (const [column, label] of Object.entries(scopeFilters)) {
    if (label == null) continue;
    if (Array.isArray(label)) {
      const rowExtra = parseExtraLabels(row?.[column]);
      for (let i = 0; i < label.length; i += 1) {
        if (!matchesTaxonomyLabel(rowExtra[i], label[i])) return false;
      }
      continue;
    }
    if (!matchesTaxonomyLabel(row?.[column], label)) return false;
  }
  return true;
}

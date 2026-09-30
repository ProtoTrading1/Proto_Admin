/**
 * Copy a chosen bulk-edit description to every selected product while keeping
 * the rest of each product's unsaved draft unchanged.
 */
export function applyDescriptionToAllRows(rows, description) {
  return rows.map((row) => ({ ...row, description }));
}

/** Apply only the common fields explicitly filled in by the editor. */
export function applySharedFieldsToAllRows(rows, { title = '', description = '' }) {
  const sharedTitle = title.trim();
  const hasDescription = Boolean(description.trim());
  return rows.map((row) => ({
    ...row,
    ...(sharedTitle ? { title: sharedTitle } : {}),
    ...(hasDescription ? { description } : {}),
  }));
}

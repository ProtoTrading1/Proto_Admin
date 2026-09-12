/**
 * Copy a chosen bulk-edit description to every selected product while keeping
 * the rest of each product's unsaved draft unchanged.
 */
export function applyDescriptionToAllRows(rows, description) {
  return rows.map((row) => ({ ...row, description }));
}

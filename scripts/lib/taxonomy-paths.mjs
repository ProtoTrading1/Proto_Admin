import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function normLabel(s) {
  return String(s || '').trim().toLowerCase();
}

export function loadBundledTaxonomy() {
  return JSON.parse(readFileSync(join(__dirname, '../../src/data/categories.json'), 'utf8'));
}

export function validatePath(tree, labels) {
  const path = [];
  let level = tree;
  for (const raw of labels) {
    if (!raw) break;
    const node = (level || []).find((n) => normLabel(n.label) === normLabel(raw));
    if (!node) return null;
    path.push(node.label);
    level = node.children || [];
  }
  return path.length >= 2 ? path : null;
}

export function fuzzyFixPath(tree, labels) {
  let level = tree;
  const resolved = [];
  for (const raw of labels) {
    if (!raw) break;
    let node = (level || []).find((n) => normLabel(n.label) === normLabel(raw));
    if (!node) {
      const r = normLabel(raw);
      node = (level || []).find((n) => {
        const l = normLabel(n.label);
        return l.includes(r) || r.includes(l) || l.replace(/&/g, 'and') === r.replace(/&/g, 'and');
      });
    }
    if (!node) return null;
    resolved.push(node.label);
    level = node.children || [];
  }
  return resolved.length >= 2 ? resolved : null;
}

// Keep in lockstep with labelsToDbFields in api/_taxonomy-utils.js — depth
// beyond subcategory_four is stored as a JSON array in subcategory_extra.
export function labelsToDbFields(labels) {
  const extra = labels.slice(5).filter((v) => v != null && String(v).trim());
  return {
    category: labels[0],
    subcategory_one: labels[1] || labels[0],
    subcategory_two: labels[2] || null,
    subcategory_three: labels[3] || null,
    subcategory_four: labels[4] || null,
    subcategory_extra: extra.length ? JSON.stringify(extra) : null,
  };
}

export function pathStringToLabels(pathStr) {
  return String(pathStr || '')
    .split(/\s*>\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function resolvePathFields(tree, pathStr) {
  const labels = pathStringToLabels(pathStr);
  if (!labels.length) return null;
  const validated = validatePath(tree, labels) || fuzzyFixPath(tree, labels);
  if (validated) return labelsToDbFields(validated);
  if (labels.length === 1) {
    const main = tree.find((n) => normLabel(n.label) === normLabel(labels[0]));
    if (main) return labelsToDbFields([main.label, main.label]);
  }
  return null;
}

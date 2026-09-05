import { readFileSync } from 'fs';
import { join } from 'path';
import { labelToSlug } from './_taxonomy-utils.js';

const BUNDLED_PATH = join(process.cwd(), 'src/data/categories.json');

export function loadMainCategories() {
  const tree = JSON.parse(readFileSync(BUNDLED_PATH, 'utf8'));
  return tree.map((c) => ({ id: c.id, label: c.label }));
}

export function defaultFulfillmentUsers() {
  const cats = loadMainCategories();
  const pick = (i) => cats[i]?.id || cats[0]?.id;
  return {
    users: [
      { id: 'victor', name: 'Victor', whatsapp: '+27821234501', categoryIds: [pick(0), pick(1)] },
      { id: 'george', name: 'George', whatsapp: '+27821234502', categoryIds: [pick(2), pick(3)] },
      { id: 'peter', name: 'Peter', whatsapp: '+27821234503', categoryIds: [pick(4), pick(5)] },
      { id: 'catherine', name: 'Catherine', whatsapp: '+27821234504', categoryIds: [pick(6), pick(7)] },
      { id: 'maria', name: 'Maria', whatsapp: '+27821234505', categoryIds: [pick(8), pick(9)] },
      { id: 'james', name: 'James', whatsapp: '+27821234506', categoryIds: [pick(10), pick(11)] },
    ],
  };
}

export function slugCategory(label) {
  return labelToSlug(label || '');
}

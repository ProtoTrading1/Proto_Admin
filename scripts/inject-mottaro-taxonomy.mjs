#!/usr/bin/env node
/**
 * Inject the Mottaro brand category branch into src/data/categories.json.
 *
 * Usage: node scripts/inject-mottaro-taxonomy.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { injectMotarroIntoTree } from '../lib/mottaro-category.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const path = join(__dir, '../src/data/categories.json');

const tree = JSON.parse(readFileSync(path, 'utf8'));
const next = injectMotarroIntoTree(tree);
writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
console.log('✓ Mottaro category injected into src/data/categories.json');

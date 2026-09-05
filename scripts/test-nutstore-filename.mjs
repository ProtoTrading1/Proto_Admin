import assert from 'node:assert/strict';
import { parseNutstoreFilename } from '../api/_nutstore-filename.js';

const cases = [
  { file: '86261.jpg', code: '86261', display: '86261' },
  { file: '86843873-86843873grn.jpg', code: '86843873', display: '86843873-86843873grn' },
  { file: 'MI027-3.jpg', code: 'MI027', display: 'MI027-3' },
  { file: '/PTR-photos/101/foo/86261.JPEG', code: '86261', display: '86261' },
];

for (const { file, code, display } of cases) {
  const parsed = parseNutstoreFilename(file);
  assert.equal(parsed.code, code, `${file} code`);
  assert.equal(parsed.displayCode, display, `${file} display`);
  assert.equal(parsed.parseError, null, `${file} parseError`);
}

assert.equal(parseNutstoreFilename('x.jpg').parseError, 'sku_too_short');

console.log('nutstore filename parser: ok');

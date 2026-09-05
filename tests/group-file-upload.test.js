// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { readFileTable, unsupportedFileMessage } from '../src/lib/customerCsvImport.js';
import { parseGroupRows } from '../lib/email-groups.mjs';

/**
 * The upload chain, end to end, the way the Groups panel runs it.
 *
 * The unit tests either side of this were green while the feature was
 * completely broken: the panel called parseCustomerFile, which returns shaped
 * customer records rather than a raw table, so parseGroupRows saw a non-array
 * and returned zero members with no error. Every file failed with "No valid
 * email addresses found in that file", including perfectly good CSVs.
 *
 * Testing the two halves separately could never catch that. This joins them.
 */

function csvFile(name, text) {
  return new File([text], name, { type: 'text/csv' });
}

describe('group upload — file to members', () => {
  it('reads a plain CSV all the way through to members', async () => {
    const file = csvFile('group.csv', [
      'email,name,business_name',
      'jane@example.co.za,Jane Dlamini,Dlamini Stationers',
      'sam@example.co.za,Sam Naidoo,Naidoo Wholesale',
    ].join('\n'));

    const { members, skipped } = parseGroupRows(await readFileTable(file));

    expect(skipped).toHaveLength(0);
    expect(members).toEqual([
      { email: 'jane@example.co.za', name: 'Jane Dlamini', business_name: 'Dlamini Stationers' },
      { email: 'sam@example.co.za', name: 'Sam Naidoo', business_name: 'Naidoo Wholesale' },
    ]);
  });

  it('reads a bare list of addresses with no header row', async () => {
    const file = csvFile('list.csv', 'jane@example.co.za\nsam@example.co.za');
    const { members } = parseGroupRows(await readFileTable(file));
    expect(members.map((m) => m.email)).toEqual(['jane@example.co.za', 'sam@example.co.za']);
  });

  it('handles quoted fields and a BOM, which Excel writes', async () => {
    const file = csvFile('excel.csv', '﻿email,name\n"jane@example.co.za","Dlamini, Jane"');
    const { members } = parseGroupRows(await readFileTable(file));
    expect(members).toHaveLength(1);
    expect(members[0].name).toBe('Dlamini, Jane');
  });

  it('handles semicolon separators and CRLF line endings', async () => {
    const file = csvFile('euro.csv', 'email;name\r\njane@example.co.za;Jane\r\n');
    const { members } = parseGroupRows(await readFileTable(file));
    expect(members).toHaveLength(1);
    expect(members[0].name).toBe('Jane');
  });
});

describe('unsupported formats', () => {
  it('names Apple Numbers and says how to fix it', () => {
    // The real report: a file called "Group_2_CSV.numbers" — Numbers saves a
    // package even when the document's name says CSV.
    const message = unsupportedFileMessage('Group_2_CSV.numbers');
    expect(message).toMatch(/Numbers/);
    expect(message).toMatch(/Export To/i);
  });

  it('rejects a Numbers file instead of parsing it into nothing', async () => {
    // A .numbers file is a zip; reading it as text yields binary noise, which
    // previously surfaced as the same useless "no valid emails" message.
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'x.numbers');
    await expect(readFileTable(file)).rejects.toThrow(/Numbers/);
  });

  it('covers the other formats people reach for', () => {
    expect(unsupportedFileMessage('report.pdf')).toMatch(/PDF/);
    expect(unsupportedFileMessage('list.docx')).toMatch(/document/);
    expect(unsupportedFileMessage('deck.key')).toMatch(/Keynote/);
  });

  it('says nothing about the formats that do work', () => {
    expect(unsupportedFileMessage('group.csv')).toBe('');
    expect(unsupportedFileMessage('group.xlsx')).toBe('');
    expect(unsupportedFileMessage('group.xls')).toBe('');
  });
});

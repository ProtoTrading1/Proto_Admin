import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildDeliveryLabel, copyDeliveryLabel } from '../src/lib/deliveryLabel.js';

const customer = Object.freeze({ business_name: 'Sample Creations', contact_name: 'Jane Smith', name: 'Old Name',
  phone: '0820012345', country: 'South Africa', city: 'Sedgefield',
  delivery_address: '8 Example Avenue, Sedgefield, 6573, Western Cape, South Africa',
  company_address: 'Different company address' });

describe('sticker label formatter', () => {
  it('matches the seven-row sticker exactly with values only', () => {
    const label = buildDeliveryLabel(customer);
    expect(label.text).toBe('SAMPLE CREATIONS\r\n8 EXAMPLE AVENUE\r\nSEDGEFIELD\r\nWESTERN CAPE\r\n6573\r\nJANE SMITH\r\n0820012345');
    expect(label.warnings).toEqual([]);
    expect(label.text).not.toMatch(/ATT:|TEL:|TO:|CARTON|SOUTH AFRICA|Old Name|Different/);
    expect(customer.delivery_address).toContain('Western Cape');
  });
  it('keeps unit and suburb on the street row and preserves zero-prefixed postcode', () => {
    const label = buildDeliveryLabel({ ...customer, delivery_address: 'Unit 3\n12 Example Road\nSample Suburb\nPretoria\n0081\nGauteng\nZA' });
    expect(label.lines).toEqual(['SAMPLE CREATIONS', 'UNIT 3, 12 EXAMPLE ROAD, SAMPLE SUBURB', 'PRETORIA', 'GAUTENG', '0081', 'JANE SMITH', '0820012345']);
  });
  it('keeps the PT_00165 address shape in seven slots without inventing its missing province', () => {
    const source = Object.freeze({ ...customer, city: 'Sample Town', province: '',
      delivery_address: 'Plot 123, Sample Town, Sample Town, 0081, South Africa, Office Building' });
    const label = buildDeliveryLabel(source);
    expect(label.lines).toEqual(['SAMPLE CREATIONS', 'PLOT 123, OFFICE BUILDING', 'SAMPLE TOWN', '', '0081', 'JANE SMITH', '0820012345']);
    expect(label.warnings.join(' ')).toContain('Province is missing');
    expect(label.text).toContain('SAMPLE TOWN\r\n\r\n0081');
    expect(label.html).toContain('></td></tr>');
    expect(label.html.match(/<tr>/g)).toHaveLength(7);
    expect(source.delivery_address).toContain('South Africa, Office Building');
  });
  it('keeps a building before the street and collapses duplicate town fragments', () => {
    const label = buildDeliveryLabel({ ...customer, city: 'Sample Town',
      delivery_address: 'Office Building, Plot 123, Sample Town, Sample Town, 0081, South Africa' });
    expect(label.lines.slice(1,5)).toEqual(['OFFICE BUILDING, PLOT 123', 'SAMPLE TOWN', '', '0081']);
  });
  it('uses a saved province only for an explicitly matching town, never a different profile town', () => {
    const input = { ...customer, city: 'Sample Town', province: 'Northern Cape',
      delivery_address: '12 Test Road, Sample Town, 8800, South Africa' };
    expect(buildDeliveryLabel(input).lines[3]).toBe('NORTHERN CAPE');
    expect(buildDeliveryLabel({ ...input, city: 'Different Town' }).lines[3]).toBe('');
    expect(buildDeliveryLabel({ ...input, delivery_address: '12 Test Road, Sample Town, Western Cape, 8800, South Africa' }).lines[3]).toBe('WESTERN CAPE');
  });
  it('keeps unknown fragments and blank slots instead of shifting contact or guessing a postcode', () => {
    const label = buildDeliveryLabel({ ...customer, delivery_address: '1234, Example Road', phone: '' });
    expect(label.lines).toHaveLength(7);
    expect(label.lines[1]).toBe('1234, EXAMPLE ROAD');
    expect(label.lines.slice(2,5)).toEqual(['', '', '']);
    expect(label.lines[5]).toBe('JANE SMITH');
    expect(label.lines[6]).toBe('');
    expect(label.warnings.join(' ')).toMatch(/Town\/city.*Province.*Postal code.*Phone number/s);
  });
  it('preserves conflicting postal fragments and flags the ambiguity', () => {
    const label = buildDeliveryLabel({ ...customer, delivery_address: '12 Test Road, Sedgefield, Western Cape, 6573, 6574' });
    expect(label.lines[4]).toBe('');
    expect(label.lines[1]).toContain('6573, 6574');
    expect(label.warnings.join(' ')).toContain('Postal code is missing or ambiguous');
  });
  it('keeps foreign countries without using an unrelated profile country', () => {
    const label = buildDeliveryLabel({ ...customer, country: 'Namibia', delivery_address: '12 Main Road, Gaborone, Botswana' });
    expect(label.text).toContain('BOTSWANA');
    expect(label.text).not.toContain('NAMIBIA');
    const matching = buildDeliveryLabel({ ...customer, country: 'Namibia', delivery_address: '12 Main Road, Windhoek, Namibia' });
    expect(matching.lines.filter(line => line === 'NAMIBIA')).toHaveLength(1);
    expect(matching.lines.at(-3)).toBe('NAMIBIA');
  });
  it('does not remove country words inside street names', () => {
    expect(buildDeliveryLabel({ ...customer, delivery_address: '12 South Africa Road, Pretoria, Gauteng, 0081, RSA' }).text).toContain('12 SOUTH AFRICA ROAD');
  });
  it('warns about company-address fallback and blocks empty/placeholder addresses', () => {
    expect(buildDeliveryLabel({ ...customer, delivery_address: '' }).warnings.join(' ')).toContain('company address');
    expect(buildDeliveryLabel({ ...customer, delivery_address: 'To confirm', company_address: '' }).canCopy).toBe(false);
    expect(buildDeliveryLabel().canCopy).toBe(false);
  });
  it('escapes HTML and marks Excel cells as text rather than numbers or formulas', () => {
    const label = buildDeliveryLabel({ ...customer, business_name: '=2+2 <shop> & co' });
    expect(label.html).toContain('=2+2 &lt;SHOP&gt; &amp; CO');
    expect(label.html).toContain('mso-number-format:"\\@"');
    expect(label.html.match(/<tr>/g)).toHaveLength(7);
    expect(label.html).toContain('0820012345</td>');
  });
  it('is connected to expanded order requests without changing API selects', () => {
    const page = readFileSync(new URL('../src/pages/AdminPage.jsx', import.meta.url), 'utf8');
    expect(page).toContain('<DeliveryLabelCopy customer={order.customers} />');
  });
});

describe('clipboard writes', () => {
  it('writes matching plain-text and HTML formats in one user action', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    class Item { constructor(data) { this.data = data; } }
    const label = buildDeliveryLabel(customer);
    expect(await copyDeliveryLabel(label, { navigator: { clipboard: { write } }, ClipboardItem: Item, Blob })).toBe('excel');
    const item = write.mock.calls[0][0][0];
    expect(await item.data['text/plain'].text()).toBe(label.text);
    expect(await item.data['text/html'].text()).toBe(label.html);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('supports plain-text-only clipboard implementations', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const label = buildDeliveryLabel(customer);
    expect(await copyDeliveryLabel(label, { navigator: { clipboard: { writeText } } })).toBe('text');
    expect(writeText).toHaveBeenCalledWith(label.text);
  });
  it('reports denial and missing data, never pretending a failed write succeeded', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Denied'));
    await expect(copyDeliveryLabel(buildDeliveryLabel(customer), { navigator: { clipboard: { writeText } } })).rejects.toThrow('Denied');
    await expect(copyDeliveryLabel(buildDeliveryLabel())).rejects.toThrow('saved address');
  });
});

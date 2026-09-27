import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const panel = readFileSync(new URL('../src/components/ProductLoaderPanel.jsx', import.meta.url), 'utf8');

describe('Product Loader single-image entry point', () => {
  it('keeps every existing workflow as a separate tab', () => {
    expect(panel).toContain("{ id: 'nutstore', label: 'Nutstore' }");
    expect(panel).toContain("{ id: 'single', label: 'Single Image' }");
    expect(panel).toContain("{ id: 'upload', label: 'Multiple Images' }");
    expect(panel).toContain("{ id: 'landed', label: 'Landed Shipment' }");
    expect(panel).toContain("{ id: 'variants', label: 'Excel + Images' }");
    expect(panel).toContain("activeTab === 'single'");
    expect(panel).toContain('<ProductLoaderSingleImage');
  });

  it('mounts normal multiple-image uploads separately from Instore landed shipments', () => {
    const multipleStart = panel.indexOf("activeTab === 'upload'");
    const landedStart = panel.indexOf("activeTab === 'landed'");
    const variantsStart = panel.indexOf("activeTab === 'variants'");
    const multipleBlock = panel.slice(multipleStart, landedStart);
    const landedBlock = panel.slice(landedStart, variantsStart);

    expect(multipleBlock).toContain('<ProductLoaderUpload');
    expect(multipleBlock).not.toContain('instoreOnly');
    expect(landedBlock).toContain('<ProductLoaderUpload');
    expect(landedBlock).toContain('instoreOnly');
  });

  it('routes one-code hand-offs and upload-next actions to Single Image', () => {
    expect(panel).toContain("setActiveTab('single');");
    expect(panel).toContain('setActiveTab("single")');
  });
});

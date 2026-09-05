import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Jimp } from 'jimp';
import { describe, expect, it } from 'vitest';
import { standardizeFalOutput } from '../api/_fal-image-provider.js';

const ROOT = join(import.meta.dirname, '..');
const centreSource = readFileSync(join(ROOT, 'src/components/productLoader/ImageProcessingCentre.jsx'), 'utf8');
const jobsRouteSource = readFileSync(join(ROOT, 'api/image-processing-jobs.js'), 'utf8');
const workerSource = readFileSync(join(ROOT, 'api/image-processing-worker.js'), 'utf8');
const serviceSource = readFileSync(join(ROOT, 'api/_image-processing-service.js'), 'utf8');

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `Could not find ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `Could not find ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('Image Processing Centre archive-first acceptance contract', () => {
  it('retains a transparent PNG master while creating a separate 1600px white JPG for the website', async () => {
    const transparent = new Jimp({ width: 160, height: 120, color: 0x00000000 });
    for (let y = 20; y < 100; y += 1) {
      for (let x = 50; x < 110; x += 1) transparent.setPixelColor(0x204060ff, x, y);
    }

    const result = await standardizeFalOutput(await transparent.getBuffer('image/png'));
    const transparentMaster = await Jimp.read(result.transparentMasterBuffer);
    const websiteReady = await Jimp.read(result.websiteReadyBuffer);

    expect(result.transparentMaster).toMatchObject({ format: 'image/png', background: 'transparent' });
    expect((transparentMaster.getPixelColor(0, 0) >>> 24) & 0xff).toBe(0);
    expect(result.websiteReady).toMatchObject({ width: 1600, height: 1600, format: 'image/jpeg', background: '#FFFFFF' });
    expect(result.websiteReadyBuffer.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(websiteReady.bitmap).toMatchObject({ width: 1600, height: 1600 });
    const corner = websiteReady.getPixelColor(0, 0);
    expect((corner >>> 24) & 0xff).toBeGreaterThan(245);
    expect((corner >>> 16) & 0xff).toBeGreaterThan(245);
    expect((corner >>> 8) & 0xff).toBeGreaterThan(245);
  });

  it('requires review, explicit archive, and a separate explicit apply action', () => {
    const approveBranch = sourceSection(jobsRouteSource, "action === 'approve'", "action === 'archive'");
    const archiveBranch = sourceSection(jobsRouteSource, "action === 'archive'", "action === 'apply'");

    expect(approveBranch).toContain('markImageApproved');
    expect(approveBranch).not.toContain('applyArchivedImage');
    expect(archiveBranch).toContain('archiveApprovedImage');
    expect(archiveBranch).not.toContain('applyArchivedImage');
    expect(jobsRouteSource).toContain("action === 'apply'");
    expect(serviceSource).toContain('export async function archiveApprovedImage');
    expect(serviceSource).toContain('export async function applyArchivedImage');
  });

  it('does not automatically update Product Manager while processing, reviewing, or archiving', () => {
    const archiveService = sourceSection(serviceSource, 'export async function archiveApprovedImage', 'export async function applyArchivedImage');

    expect(workerSource).not.toMatch(/\.from\([^)]*website_stock[^)]*\)/);
    expect(archiveService).not.toMatch(/\.from\([^)]*website_stock[^)]*\)\.update/);
    expect(archiveService).not.toContain('conditionalImageUpdate');
    expect(archiveService).toContain('originalUrl');
    expect(archiveService).toContain('transparentMasterUrl');
    expect(archiveService).toContain('websiteReadyUrl');
  });

  it('requires a human to confirm an archived asset before it can alter a Product Manager image', () => {
    const applyService = sourceSection(serviceSource, 'export async function applyArchivedImage', 'export async function restorePublishedOriginal');

    expect(centreSource).toContain('Save approved result to Image Archive');
    expect(centreSource).toContain('Apply to Product Manager');
    expect(centreSource).toContain('Confirm and apply to Product Manager');
    expect(centreSource).toContain("runAction(job, 'apply'");
    expect(jobsRouteSource).toContain('confirmArchiveAssetId');
    expect(applyService).toContain("image.status !== 'archived'");
    expect(applyService).toContain('conditionalImageUpdate');
  });
});

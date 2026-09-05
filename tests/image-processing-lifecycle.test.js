import { describe, expect, it } from 'vitest';
import {
  JOB_STATUSES,
  canTransition,
  classifyImageTreatment,
  reviewChecklistComplete,
  treatmentPresentation,
} from '../lib/image-processing-lifecycle.mjs';

describe('Image Processing Centre routing and lifecycle', () => {
  it('routes clear packaging to the manual lane', () => {
    const route = classifyImageTreatment({
      productTitle: 'Clear PVC gift box with ribbon',
      category: 'Packaging',
    });
    expect(route).toMatchObject({ treatment: 'transparent', manualOnly: true, imageStyle: null });
  });

  it('routes beads and jewellery to the manual lane before generic clear terms', () => {
    const route = classifyImageTreatment({
      productTitle: 'Crystal bead jewellery set',
      category: 'Beads Jewellery & Accessories',
    });
    expect(route).toMatchObject({ treatment: 'fine_detail', manualOnly: true, imageStyle: null });
    expect(treatmentPresentation(route.treatment).manualOnly).toBe(true);
  });

  it('allows opaque multi-piece products into the standard review path', () => {
    const route = classifyImageTreatment({ productTitle: '5 pc paint brush set' });
    expect(route).toMatchObject({ treatment: 'standard', manualOnly: false, imageStyle: 'standard' });
  });

  it('requires a full human checklist before approval', () => {
    expect(reviewChecklistComplete({ correctProduct: true, labelsPreserved: true, backgroundClean: true })).toBe(true);
    expect(reviewChecklistComplete({ correctProduct: true, labelsPreserved: true, backgroundClean: false })).toBe(false);
  });

  it('permits only the staged review lifecycle including an applying lock', () => {
    expect(canTransition(JOB_STATUSES.queued, JOB_STATUSES.processing)).toBe(true);
    expect(canTransition(JOB_STATUSES.readyForReview, JOB_STATUSES.approved)).toBe(true);
    expect(canTransition(JOB_STATUSES.approved, JOB_STATUSES.applying)).toBe(true);
    expect(canTransition(JOB_STATUSES.applying, JOB_STATUSES.applied)).toBe(true);
    expect(canTransition(JOB_STATUSES.approved, JOB_STATUSES.applied)).toBe(false);
    expect(canTransition(JOB_STATUSES.applied, JOB_STATUSES.processing)).toBe(false);
  });
});

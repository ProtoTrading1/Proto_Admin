import { describe, expect, it } from 'vitest';
import { requestedWindow } from '../api/apollo-order-leader.js';

describe('Apollo authenticated order-leader endpoint window', () => {
  it('uses week-to-date when the question asks for this week', () => {
    expect(requestedWindow({ window: 'week_to_date' }, new Date('2026-09-02T10:00:00.000Z'))).toMatchObject({
      from: '2026-08-30T22:00:00.000Z', label: 'This week', timezone: 'Africa/Johannesburg',
    });
  });

  it('uses only approved rolling windows', () => {
    expect(requestedWindow({ period: '7' }, new Date('2026-09-01T10:00:00.000Z'))).toMatchObject({ periodDays: 7, label: 'Last 7 days' });
    expect(requestedWindow({ period: '14' }, new Date('2026-09-01T10:00:00.000Z'))).toMatchObject({ periodDays: 30 });
  });
});

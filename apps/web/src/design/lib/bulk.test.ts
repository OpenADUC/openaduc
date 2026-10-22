// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { runBulk } from './bulk.js';

describe('runBulk', () => {
  it('runs every id and separates successes from failures', async () => {
    const seen: string[] = [];
    const result = await runBulk(['a', 'b', 'c'], async (id) => {
      seen.push(id);
      if (id === 'b') throw new Error('insufficient access');
    });

    expect(seen).toEqual(['a', 'b', 'c']);
    expect(result.succeeded).toEqual(['a', 'c']);
    expect(result.failures).toEqual([{ id: 'b', error: 'insufficient access' }]);
  });

  it('reports progress after each item', async () => {
    const progress: number[] = [];
    await runBulk(
      ['a', 'b'],
      async () => {},
      (done) => progress.push(done),
    );
    expect(progress).toEqual([1, 2]);
  });
});

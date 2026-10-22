// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { latestRequest } from './latestRequest.js';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe('latestRequest', () => {
  it('drops a slow response that arrives after a newer one (A → B, A answers last)', async () => {
    const guard = latestRequest();
    let shown: string | null = null;
    const a = deferred<string>();
    const b = deferred<string>();

    const load = async (pending: Promise<string>) => {
      const isCurrent = guard.begin();
      const value = await pending;
      if (isCurrent()) shown = value;
    };

    const loadA = load(a.promise);
    const loadB = load(b.promise);
    b.resolve('B');
    await loadB;
    a.resolve('A');
    await loadA;

    expect(shown).toBe('B');
  });

  it('keeps the only request current', () => {
    const guard = latestRequest();
    const isCurrent = guard.begin();
    expect(isCurrent()).toBe(true);
    guard.begin();
    expect(isCurrent()).toBe(false);
  });
});

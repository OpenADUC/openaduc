// SPDX-License-Identifier: BUSL-1.1
import type { Entry } from 'ldapts';
import { describe, expect, it, vi } from 'vitest';
import { withAllMembers } from './memberRange.js';

const dns = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `CN=u${from + i},DC=x`);

// A fake DC holding `total` members, handing them out `max` per read.
function fakeDc(total: number, max: number) {
  const all = dns(0, total - 1);
  const search = vi.fn(async (_base: string, options: { attributes?: string[] }) => {
    const [, start] = /range=(\d+)-\*/.exec(options.attributes![0]!)!;
    const from = Number(start);
    const to = Math.min(from + max, total) - 1;
    const end = to === total - 1 ? '*' : String(to);
    return {
      searchEntries: [
        { dn: 'CN=Big,DC=x', [`member;range=${from}-${end}`]: all.slice(from, to + 1) },
      ],
      searchReferences: [],
    };
  });
  const first = (): Entry => ({
    dn: 'CN=Big,DC=x',
    cn: 'Big',
    [`member;range=0-${max - 1}`]: all.slice(0, max),
  });
  return { all, search, first };
}

describe('withAllMembers', () => {
  it('reads every range until AD marks the last one', async () => {
    const dc = fakeDc(3200, 1500);

    const entry = await withAllMembers(dc, dc.first());

    expect(entry.member).toEqual(dc.all);
    expect(Object.keys(entry)).toEqual(['dn', 'cn', 'member']);
    expect(dc.search.mock.calls.map((c) => c[1].attributes)).toEqual([
      ['member;range=1500-*'],
      ['member;range=3000-*'],
    ]);
  });

  it('leaves an entry with a plain member list alone', async () => {
    const search = vi.fn();
    const entry = { dn: 'CN=Small,DC=x', member: ['CN=a,DC=x'] };

    expect(await withAllMembers({ search }, entry)).toEqual(entry);
    expect(search).not.toHaveBeenCalled();
  });

  it('stops when a range doesn’t move forward', async () => {
    const search = vi.fn(async () => ({
      searchEntries: [{ dn: 'CN=Big,DC=x', 'member;range=0-1499': dns(0, 1499) }],
      searchReferences: [],
    }));

    const entry = await withAllMembers(
      { search },
      {
        dn: 'CN=Big,DC=x',
        'member;range=0-1499': dns(0, 1499),
      },
    );

    expect(search).toHaveBeenCalledOnce();
    expect(entry.member).toHaveLength(3000);
  });
});

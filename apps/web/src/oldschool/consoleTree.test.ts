// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import type { DirectoryOu } from '@openaduc/shared';
import { buildConsoleTree, pathTo } from './consoleTree.js';

const DOMAIN = 'DC=corp,DC=example';
const ou = (name: string, parentDn: string): DirectoryOu => ({
  distinguishedName: `OU=${name},${parentDn}`,
  name,
  parentDn,
  description: null,
  stale: false,
});
const STAFF = `OU=Staff,${DOMAIN}`;
const tree = buildConsoleTree([ou('Staff', DOMAIN), ou('Interns', STAFF)]);
const labels = (dn: string) => pathTo(tree, dn)?.map((n) => n.label);

describe('pathTo', () => {
  it('walks from the domain down to a nested OU', () => {
    expect(labels(`OU=Interns,${STAFF}`)).toEqual(['corp.example', 'Staff', 'Interns']);
  });

  it('matches the DN case-insensitively', () => {
    expect(labels(`ou=interns,ou=staff,dc=CORP,dc=example`)).toEqual([
      'corp.example',
      'Staff',
      'Interns',
    ]);
  });

  it('finds the synthetic containers under the domain', () => {
    expect(labels(`CN=Users,${DOMAIN}`)).toEqual(['corp.example', 'Users']);
  });

  it('is null for a DN the tree doesn’t have', () => {
    expect(pathTo(tree, `OU=Gone,${DOMAIN}`)).toBeNull();
  });
});

// SPDX-License-Identifier: BUSL-1.1
// The Old School console tree, built from the directory's OUs. The tree
// pane draws it; the contents list shows a container's children from it,
// as ADUC lists sub-OUs and containers beside the objects.
//
//   Saved Queries (synthetic, no contents)
//   <domain>          ─ resolved from the OU list's common DC= suffix
//     ├─ Builtin                 (synthetic CN= container)
//     ├─ Computers               (synthetic CN= container)
//     ├─ Domain Controllers      (only when an OU with that name exists)
//     ├─ ForeignSecurityPrincipals (synthetic)
//     ├─ Managed Service Accounts (synthetic)
//     ├─ Users                   (synthetic CN= container)
//     └─ each top-level OU       (real, expandable)
//
// Synthetic containers use `CN=<name>,<domain>` DNs.

import type { DirectoryOu } from '@openaduc/shared';
import type { SelectedKind } from './stores/useOldSchool.js';

export interface ConsoleNode {
  key: string;
  label: string;
  kind: SelectedKind;
  dn: string | null;
  icon: string;
  /** The AD `description`, for an OU; null for the synthetic rows. */
  description: string | null;
  children: ConsoleNode[];
}

/**
 * The domain's DN. The OU schema doesn't surface it directly, but every
 * cached OU ends with the same DC=…,DC=… suffix: find the longest shared
 * suffix that starts with `DC=`.
 */
function domainDnOf(ous: DirectoryOu[]): string | null {
  if (ous.length === 0) return null;
  const all = ous.map((o) => o.distinguishedName.toLowerCase());
  const parts = all[0]!.split(',');
  for (let i = 0; i < parts.length; i++) {
    const suffix = parts.slice(i).join(',');
    if (suffix.startsWith('dc=') && all.every((d) => d.endsWith(suffix))) {
      // Re-extract from the original DN to preserve case.
      const cased = ous[0]!.distinguishedName;
      return cased.slice(cased.length - suffix.length);
    }
  }
  return null;
}

const byLabel = (a: ConsoleNode, b: ConsoleNode): number =>
  a.label.localeCompare(b.label, undefined, { numeric: true });

const leaf = (
  kind: SelectedKind,
  key: string,
  label: string,
  dn: string | null,
  icon: string,
): ConsoleNode => ({ key, label, kind, dn, icon, description: null, children: [] });

export function buildConsoleTree(ous: DirectoryOu[]): ConsoleNode[] {
  const savedQueries = leaf('savedQueries', 'saved-queries', 'Saved Queries', null, 'savedQueries');
  const dn = domainDnOf(ous);
  if (!dn) return [savedQueries];

  // Index OUs by lowercase DN so we can wire parent→children.
  const byDn = new Map<string, ConsoleNode>();
  for (const o of ous) {
    byDn.set(o.distinguishedName.toLowerCase(), {
      key: o.distinguishedName,
      label: o.name,
      kind: 'ou',
      dn: o.distinguishedName,
      icon: 'ou',
      description: o.description,
      children: [],
    });
  }
  const topOus: ConsoleNode[] = [];
  for (const o of ous) {
    const node = byDn.get(o.distinguishedName.toLowerCase())!;
    const parent =
      o.parentDn && o.parentDn.toLowerCase() !== dn.toLowerCase()
        ? byDn.get(o.parentDn.toLowerCase())
        : undefined;
    // An orphan (its parent OU filtered or stale) shows at the domain root.
    if (parent) parent.children.push(node);
    else topOus.push(node);
  }
  const sortRec = (rows: ConsoleNode[]): void => {
    rows.sort(byLabel);
    for (const r of rows) sortRec(r.children);
  };
  for (const r of topOus) sortRec(r.children);

  const containers = [
    leaf('builtin', `CN=Builtin,${dn}`, 'Builtin', `CN=Builtin,${dn}`, 'builtin'),
    ...['Computers', 'ForeignSecurityPrincipals', 'Managed Service Accounts', 'Users'].map((name) =>
      leaf('container', `CN=${name},${dn}`, name, `CN=${name},${dn}`, 'container'),
    ),
  ];
  const label = dn
    .split(',')
    .filter((p) => p.toLowerCase().startsWith('dc='))
    .map((p) => p.slice(3))
    .join('.');
  const domain: ConsoleNode = {
    key: dn,
    label,
    kind: 'domain',
    dn,
    icon: 'domain',
    description: null,
    // Sorted together so the tree reads like ADUC (Builtin, Computers,
    // Domain Controllers, ..., your OUs, ..., Users).
    children: [...containers, ...topOus].sort(byLabel),
  };
  return [savedQueries, domain];
}

/** The nodes from the top of the tree down to the one with this DN, or null. */
export function pathTo(tree: ConsoleNode[], dn: string): ConsoleNode[] | null {
  const want = dn.toLowerCase();
  for (const node of tree) {
    if (node.dn?.toLowerCase() === want) return [node];
    const below = pathTo(node.children, dn);
    if (below) return [node, ...below];
  }
  return null;
}

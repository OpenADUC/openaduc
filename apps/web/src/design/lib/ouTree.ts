// SPDX-License-Identifier: BUSL-1.1
import type { DirectoryOu } from '@openaduc/shared';
import type { TreeNode } from 'primevue/treenode';

/**
 * The OUs as a PrimeVue tree keyed by DN, sorted by name at every level.
 * OUs whose parent isn't in the list (the domain root, a non-OU container)
 * become roots.
 */
export function ouTreeNodes(ous: readonly DirectoryOu[]): TreeNode[] {
  const byDn = new Map<string, TreeNode & { children: TreeNode[] }>();
  for (const ou of ous) {
    byDn.set(ou.distinguishedName.toLowerCase(), {
      key: ou.distinguishedName,
      label: ou.name,
      data: { dn: ou.distinguishedName, stale: ou.stale },
      icon: 'pi pi-folder',
      children: [],
    });
  }
  const roots: TreeNode[] = [];
  for (const ou of ous) {
    const node = byDn.get(ou.distinguishedName.toLowerCase())!;
    const parentKey = ou.parentDn?.toLowerCase();
    const parent = parentKey ? byDn.get(parentKey) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''));
    for (const n of nodes) if (n.children) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

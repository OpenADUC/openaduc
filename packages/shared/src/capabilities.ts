// SPDX-License-Identifier: BUSL-1.1
export const CAPABILITIES = [
  'read:user',
  'read:user.deleted',
  'read:group',
  'read:computer',
  'read:computer.deleted',
  'view:audit',
  'export:user',
  'import:user',
  'write:user.unlock',
  'write:user.resetPassword',
  'write:user.enableDisable',
  'write:user.attributes',
  'write:user.move',
  'write:user.restore',
  'write:group.membership',
  'write:ou.create',
  'write:ou.update',
  'write:ou.delete',
  'configure:directory',
  'configure:security',
  'view:raw_attributes',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const ROLES = ['admin', 'operator', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  admin: CAPABILITIES,
  operator: [
    'read:user',
    'read:group',
    'read:computer',
    'export:user',
    'write:user.unlock',
    'write:user.resetPassword',
    'write:user.enableDisable',
    'write:user.attributes',
    'write:user.move',
    'write:group.membership',
  ],
  auditor: ['read:user', 'read:group', 'read:computer', 'view:audit'],
};

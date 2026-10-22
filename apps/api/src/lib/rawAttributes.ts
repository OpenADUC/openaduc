// SPDX-License-Identifier: BUSL-1.1
import type { FastifyRequest } from 'fastify';
import { isSecretAttr } from '../providers/active-directory/normalize.js';

// Attributes the UI shows as ordinary properties (the old-school property
// pages read them by name), so every reader gets them. Everything else is
// the "raw LDAP" view, gated by view:raw_attributes.
const PROFILE_ATTRS = new Set([
  'facsimileTelephoneNumber',
  'homeDirectory',
  'info',
  'location',
  'machineRole',
  'msDS-SiteName',
  'operatingSystemServicePack',
  'pager',
  'physicalDeliveryOfficeName',
  'postOfficeBox',
  'profilePath',
  'scriptPath',
]);

/**
 * The raw attributes this caller may see: all of them with
 * view:raw_attributes, otherwise only the profile fields above. Secrets
 * are dropped either way (normalization already strips them; this also
 * covers cache rows written before it did).
 */
export function rawAttributesFor(
  req: FastifyRequest,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const full = req.actor?.session.capabilities.includes('view:raw_attributes') ?? false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isSecretAttr(k)) continue;
    if (full || PROFILE_ATTRS.has(k)) out[k] = v;
  }
  return out;
}

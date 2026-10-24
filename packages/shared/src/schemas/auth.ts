// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';

export const loginRequestSchema = z.object({
  directoryId: z.coerce.number().int().positive(),
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const stepUpRequestSchema = z.object({
  password: z.string().min(1).max(1024),
});
export type StepUpRequest = z.infer<typeof stepUpRequestSchema>;

// The operator's elevated session. It ends at idleExpiresAt unless the
// operator is active before then, and at absoluteExpiresAt regardless.
export const elevatedSessionSchema = z.object({
  active: z.boolean(),
  idleExpiresAt: z.string().nullable(),
  absoluteExpiresAt: z.string().nullable(),
});
export type ElevatedSessionState = z.infer<typeof elevatedSessionSchema>;

export const meResponseSchema = z.object({
  actorId: z.string(),
  displayName: z.string(),
  username: z.string(),
  email: z.string().nullable(),
  capabilities: z.array(z.string()),
  // Which directory this session is signed into. Drives the active-domain
  // affordance in the topbar; switching domains = log out.
  directoryId: z.number().int().positive(),
  directoryDomain: z.string().nullable(),
  elevated: elevatedSessionSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;

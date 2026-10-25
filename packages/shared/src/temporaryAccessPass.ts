// SPDX-License-Identifier: BUSL-1.1
import {
  TAP_MAX_START_DAYS,
  type TapIssueRequest,
  type TapPolicy,
} from './schemas/temporaryAccessPass.js';

// A start a little in the past is the browser's clock, not a request to
// backdate the pass.
const START_SKEW_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

/** Said wherever a pass is refused because the tenant has Temporary Access Pass turned off. */
export const TAP_POLICY_OFF_MESSAGE =
  'Temporary Access Pass is turned off in the tenant’s authentication methods policy. Turn it on in the Microsoft Entra admin center first.';

/** Why a pass can't start when asked: tapStartProblem's answer, in words. */
export const TAP_START_MESSAGE: Record<'past' | 'tooFar', string> = {
  past: 'The pass can’t start in the past.',
  tooFar: `The pass can start at most ${TAP_MAX_START_DAYS} days from now.`,
};

/**
 * Why the tenant's policy won't take this pass, or null when it will. The
 * dialog uses it to hold back Issue; the API applies it again before
 * asking Graph.
 */
export function tapRequestProblem(
  policy: TapPolicy,
  request: Pick<TapIssueRequest, 'startsAt' | 'lifetimeMinutes' | 'isUsableOnce'>,
  now: Date = new Date(),
): string | null {
  const { minLifetimeMinutes: min, maxLifetimeMinutes: max } = policy;
  if (request.lifetimeMinutes < min || request.lifetimeMinutes > max) {
    return `The tenant’s policy allows a lifetime from ${lifetimeLabel(min)} to ${lifetimeLabel(max)}.`;
  }
  if (!request.isUsableOnce && policy.usableOnceOnly) {
    return 'The tenant’s policy allows only single-use passes.';
  }
  const start = request.startsAt ? tapStartProblem(request.startsAt, now) : null;
  return start ? TAP_START_MESSAGE[start] : null;
}

/** Whether a pass can't start then: it's past, or further ahead than TAP_MAX_START_DAYS. */
export function tapStartProblem(startsAt: string | Date, now: Date): 'past' | 'tooFar' | null {
  const start = new Date(startsAt).getTime();
  if (start < now.getTime() - START_SKEW_MS) return 'past';
  if (start > now.getTime() + TAP_MAX_START_DAYS * DAY_MS) return 'tooFar';
  return null;
}

/** When a pass stops working: its lifetime counts from its start. */
export function tapExpiresAt(startsAt: string | Date, lifetimeMinutes: number): Date {
  return new Date(new Date(startsAt).getTime() + lifetimeMinutes * 60_000);
}

/** A lifetime in minutes, in the largest unit that divides it: `8 hours`, `90 minutes`. */
export function lifetimeLabel(minutes: number): string {
  const [n, unit] =
    minutes % 1440 === 0
      ? [minutes / 1440, 'day']
      : minutes % 60 === 0
        ? [minutes / 60, 'hour']
        : [minutes, 'minute'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

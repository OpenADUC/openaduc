// SPDX-License-Identifier: BUSL-1.1

/**
 * On every response to an elevated operator: when their elevated session
 * ends if they do nothing more. Activity moves it, so the SPA can't work it
 * out from the step-up response alone.
 */
export const ELEVATED_IDLE_END_HEADER = 'x-elevated-idle-expires-at';

/**
 * Set to '1' by the SPA on requests it makes by itself (polling a running
 * task). Those aren't the operator's activity, so they don't keep the
 * elevated session open. A client can only shorten its own session with it.
 */
export const BACKGROUND_REQUEST_HEADER = 'x-background-request';

export interface ElevatedSessionLimit {
  /** app_settings key */
  key: string;
  default: number;
  min: number;
  max: number;
}

/** The policy settings that bound an elevated session, in minutes. */
export const ELEVATED_SESSION_LIMITS: {
  idleTimeout: ElevatedSessionLimit;
  absoluteLifetime: ElevatedSessionLimit;
} = {
  idleTimeout: { key: 'stepup.idle_timeout_minutes', default: 15, min: 1, max: 480 },
  absoluteLifetime: { key: 'stepup.absolute_lifetime_minutes', default: 240, min: 1, max: 1440 },
};

/**
 * Why the API answered a write `step_up_required`, as its error's
 * `details.reason`: the operator has no elevated session (it ended, or
 * never began), or the directory refused the password it held.
 */
export const STEP_UP_REQUIRED_REASONS = ['not_elevated', 'password_rejected'] as const;
export type StepUpRequiredReason = (typeof STEP_UP_REQUIRED_REASONS)[number];

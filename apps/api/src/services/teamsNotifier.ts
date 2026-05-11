// SPDX-License-Identifier: BUSL-1.1
import type { FastifyBaseLogger } from 'fastify';
import type { EntraIntegrationService } from './entraIntegration.js';

// Outbound Teams notifications via incoming webhook. The webhook URL is
// the auth (a shared secret embedded in the URL) so we can post without
// any Graph permissions — this is the simple, supported path for "channel
// got a message" alerts.
//
// We deliberately do NOT support direct user DMs in this iteration:
// Microsoft has restricted backend-initiated 1:1 chats to flows that
// require Resource-Specific Consent + a published Teams app installed
// for each user (see notes on TeamsActivity.Send). Doing that properly
// is its own multi-week project; the EntraTab UI surfaces the limitation
// rather than half-implementing it.
//
// Adaptive Cards are JSON; Teams' incoming-webhook receiver accepts
// either MessageCard ("legacy") or Adaptive Card via the
// `attachments[].contentType = application/vnd.microsoft.card.adaptive`
// envelope. We use Adaptive Card v1.5 which is the current default in
// Teams and works in both classic and "new Teams" clients.

export type TeamsCardSeverity = 'info' | 'warning' | 'error' | 'success';

export interface TeamsAdminMessage {
  /** Short title for the card. */
  title: string;
  /** One-paragraph body. Rendered as plaintext (no markdown). */
  text: string;
  /** Drives the accent color shown next to the card. */
  severity?: TeamsCardSeverity;
  /** Optional fact list shown under the body, key/value rows. */
  facts?: Array<{ name: string; value: string }>;
  /** Optional click-through URL, rendered as a button. */
  actionUrl?: string;
  actionLabel?: string;
}

export class TeamsNotifierService {
  constructor(
    private readonly entra: EntraIntegrationService,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Send a notification to the admin Teams channel for a directory.
   * Returns ok=false (logged, not thrown) when:
   *  - integration not configured for this directory
   *  - integration disabled or feature off
   *  - webhook URL not stored
   *  - the webhook POST returned a non-2xx
   * Callers (sync runners) treat this as best-effort and never block on it.
   */
  async sendAdminMessage(
    providerId: number,
    message: TeamsAdminMessage,
  ): Promise<{ ok: boolean; reason?: string }> {
    const summary = await this.entra.getByProviderId(providerId);
    if (!summary || !summary.enabled) return { ok: false, reason: 'integration disabled' };
    if (!summary.features.teamsAdminWebhook) {
      return { ok: false, reason: 'feature disabled' };
    }
    if (!summary.hasTeamsWebhookUrl) return { ok: false, reason: 'webhook URL not configured' };

    const creds = await this.entra.getCreds(providerId);
    if (!creds || !creds.teamsWebhookUrl) {
      return { ok: false, reason: 'webhook URL not configured' };
    }

    const card = buildAdaptiveCardEnvelope(message);
    try {
      const res = await fetch(creds.teamsWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(card),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.log.warn({ status: res.status, body, providerId }, 'teams webhook returned non-2xx');
        return { ok: false, reason: `webhook returned ${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      this.log.warn({ err, providerId }, 'teams webhook post failed');
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: message };
    }
  }
}

function severityColor(
  s: TeamsCardSeverity | undefined,
): 'good' | 'warning' | 'attention' | 'default' {
  switch (s) {
    case 'success':
      return 'good';
    case 'warning':
      return 'warning';
    case 'error':
      return 'attention';
    default:
      return 'default';
  }
}

function buildAdaptiveCardEnvelope(msg: TeamsAdminMessage): unknown {
  const body: unknown[] = [
    {
      type: 'TextBlock',
      size: 'Medium',
      weight: 'Bolder',
      text: msg.title,
      color: severityColor(msg.severity),
      wrap: true,
    },
    { type: 'TextBlock', text: msg.text, wrap: true, isSubtle: false },
  ];
  if (msg.facts && msg.facts.length > 0) {
    body.push({
      type: 'FactSet',
      facts: msg.facts.map((f) => ({ title: f.name, value: f.value })),
    });
  }
  const actions: unknown[] = [];
  if (msg.actionUrl && msg.actionLabel) {
    actions.push({ type: 'Action.OpenUrl', title: msg.actionLabel, url: msg.actionUrl });
  }
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'https://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.5',
          body,
          ...(actions.length > 0 ? { actions } : {}),
        },
      },
    ],
  };
}

/**
 * /channels — front door for web traffic (non-QR signups).
 *
 * Four channel cards:
 *   - iMessage (Apple-blue accent) → sms: link to our Sendblue line
 *   - Telegram (Telegram-blue accent) → https://t.me/myinstaclaw_bot
 *   - Discord (waitlist) → expands inline email form
 *   - Slack  (waitlist) → expands inline email form
 *
 * Plus a small advanced link at the bottom for BYOB Telegram users
 * who want their own bot (legacy /signup → /connect flow). That path
 * remains intact for them; the shared-bot option is the primary
 * Telegram entry for new users.
 *
 * Public page — no auth required. Server component does nothing
 * dynamic; the client owns the interaction.
 */

import { ChannelsClient } from "./channels-client";

export default function ChannelsPage() {
  return <ChannelsClient />;
}

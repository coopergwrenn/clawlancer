/**
 * Alert System
 *
 * Sends alerts to:
 * 1. Database (alerts table) - for tracking and audit
 * 2. Slack (warning and above) - for real-time notification
 * 3. Email (critical only) - for urgent issues
 */

import { createClient } from '@supabase/supabase-js';

export type AlertLevel = 'info' | 'warning' | 'error' | 'critical';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AlertContext = Record<string, any> | object;

/**
 * Send an alert to configured channels
 */
export async function sendAlert(
  level: AlertLevel,
  message: string,
  context?: AlertContext
): Promise<void> {
  // Always log to console
  console.log(`[${level.toUpperCase()}] ${message}`, context || '');

  // Log to database
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    await supabase.from('alerts').insert({
      level,
      message,
      context: context || {},
      created_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Failed to log alert to database:', error);
  }

  // Send to Slack (warning and above)
  if (level !== 'info' && process.env.SLACK_WEBHOOK_URL) {
    await sendSlackAlert(level, message, context);
  }

  // Send email (critical only)
  if (level === 'critical' && process.env.ALERT_EMAIL) {
    await sendEmailAlert(message, context);
  }
}

/**
 * Send alert to Slack webhook
 */
async function sendSlackAlert(
  level: AlertLevel,
  message: string,
  context?: AlertContext
): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const emoji = {
    info: ':information_source:',
    warning: ':warning:',
    error: ':x:',
    critical: ':rotating_light:'
  }[level];

  const color = {
    info: '#36a64f',
    warning: '#ffcc00',
    error: '#ff6600',
    critical: '#ff0000'
  }[level];

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachments: [{
          color,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `${emoji} *[${level.toUpperCase()}]* ${message}`
              }
            },
            ...(context ? [{
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `\`\`\`${JSON.stringify(context, null, 2)}\`\`\``
              }
            }] : [])
          ]
        }]
      })
    });
  } catch (error) {
    console.error('Failed to send Slack alert:', error);
  }
}

/**
 * Send email alert (placeholder - integrate with email service)
 */
async function sendEmailAlert(
  message: string,
  context?: AlertContext
): Promise<void> {
  const alertEmail = process.env.ALERT_EMAIL;
  if (!alertEmail) return;

  // TODO: Integrate with email service (SendGrid, Resend, etc.)
  console.log(`[EMAIL ALERT] Would send to ${alertEmail}: ${message}`, context);
}

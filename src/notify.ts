import type { GrailHit } from './types.ts';
import { sendMail } from './smtp.ts';
import { postToAlertsIssue } from './github.ts';

/**
 * Push alerts for newly-in-stock grails. All channels are optional, free,
 * and driven by env vars (set them as GitHub Actions secrets):
 *
 *   SMTP_USER           — email alerts: your Gmail address; sends mail to
 *   SMTP_PASS             yourself via Gmail's free SMTP using an app
 *                         password (Google Account → Security → App passwords)
 *   ALERT_EMAIL         — optional recipient override, comma-separable
 *                         (default: SMTP_USER)
 *   SMTP_HOST/SMTP_PORT — optional non-Gmail provider (default smtp.gmail.com:465)
 *   DISCORD_WEBHOOK_URL — post into a Discord channel
 *   NTFY_TOPIC          — push notifications to your phone via ntfy.sh, no
 *                         account needed: pick a unique topic string,
 *                         subscribe to it in the ntfy app, done.
 *   NTFY_SERVER         — optional self-hosted ntfy server (default https://ntfy.sh)
 *   SLACK_WEBHOOK_URL   — post into a Slack channel
 */

function formatPrice(hit: GrailHit): string {
  const l = hit.listing;
  if (!l.priceMin) return '';
  const cur = l.currency ?? '';
  return l.priceMin === l.priceMax
    ? ` — ${l.priceMin} ${cur}`.trimEnd()
    : ` — ${l.priceMin}–${l.priceMax} ${cur}`.trimEnd();
}

function lines(hits: GrailHit[]): string[] {
  return hits.map(
    (h) => `${h.grailName}: ${h.listing.title} @ ${h.listing.retailerName}${formatPrice(h)}\n${h.listing.url}`,
  );
}

async function post(url: string, body: BodyInit, headers: Record<string, string> = {}): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      body,
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.error(`notify: ${new URL(url).host} responded ${res.status}`);
  } catch (err) {
    console.error(`notify: failed to reach ${new URL(url).host}:`, (err as Error).message);
  }
}

export async function notify(newHits: GrailHit[]): Promise<void> {
  if (newHits.length === 0) return;
  const title = `🔪 GRAIL IN STOCK — ${newHits.length} new listing${newHits.length > 1 ? 's' : ''}`;
  const body = lines(newHits).join('\n\n');
  const tasks: Promise<void>[] = [];

  // Zero-secret channel: comment on the repo's alerts issue with an
  // @mention → GitHub emails/pushes the owner. Active in any Actions run.
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
    const issueMd = newHits
      .map((h) => `- 🚨 **[${h.listing.title}](${h.listing.url})** @ ${h.listing.retailerName} — ${h.grailName}${formatPrice(h)}`)
      .join('\n');
    tasks.push(
      postToAlertsIssue(`**${title}**\n\n${issueMd}`)
        .then(() => console.log('notify: posted to GitHub alerts issue'))
        .catch((err: Error) => console.error('notify: GitHub issue failed:', err.message)),
    );
  }

  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (smtpUser && smtpPass) {
    const to = (process.env.ALERT_EMAIL ?? smtpUser)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    tasks.push(
      sendMail({
        host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
        port: Number.parseInt(process.env.SMTP_PORT ?? '465', 10),
        user: smtpUser,
        pass: smtpPass,
        to,
        subject: title,
        text: `${body}\n\n— Grail Knife Finder`,
      }).catch((err: Error) => console.error('notify: email failed:', err.message)),
    );
  }

  const ntfyTopic = process.env.NTFY_TOPIC;
  if (ntfyTopic) {
    const server = process.env.NTFY_SERVER ?? 'https://ntfy.sh';
    tasks.push(
      post(`${server}/${encodeURIComponent(ntfyTopic)}`, body, {
        Title: title,
        Priority: 'urgent',
        Tags: 'knife,rotating_light',
        Click: newHits[0].listing.url,
      }),
    );
  }

  const discord = process.env.DISCORD_WEBHOOK_URL;
  if (discord) {
    const embeds = newHits.slice(0, 10).map((h) => ({
      title: h.listing.title.slice(0, 256),
      url: h.listing.url,
      description: [
        `◈ **${h.grailName}**`,
        `🏪 ${h.listing.retailerName}${h.listing.region ? ` (${h.listing.region})` : ''}`,
        formatPrice(h) ? `💰${formatPrice(h).replace(' — ', ' ')}` : '',
        h.listing.salePct ? `🏷️ **−${h.listing.salePct}%** (was ${h.listing.compareAtMax} ${h.listing.currency ?? ''})` : '',
      ].filter(Boolean).join('\n'),
      color: h.listing.salePct ? 0xe0a458 : 0x4ade80,
    }));
    const overflow = newHits.length > 10 ? `\n…and ${newHits.length - 10} more.` : '';
    tasks.push(
      post(discord, JSON.stringify({ content: `**${title}**${overflow}`, embeds }), {
        'content-type': 'application/json',
      }),
    );
  }

  const slack = process.env.SLACK_WEBHOOK_URL;
  if (slack) {
    tasks.push(
      post(slack, JSON.stringify({ text: `*${title}*\n${body}` }), {
        'content-type': 'application/json',
      }),
    );
  }

  if (tasks.length === 0) {
    console.log('notify: no channels configured (SMTP_USER+SMTP_PASS / DISCORD_WEBHOOK_URL / NTFY_TOPIC / SLACK_WEBHOOK_URL); printing instead:\n');
    console.log(`${title}\n${body}`);
    return;
  }
  await Promise.allSettled(tasks);
}

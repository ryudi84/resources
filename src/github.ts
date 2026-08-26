/**
 * GitHub-native alert channel — works with the workflow's own GITHUB_TOKEN,
 * no user-managed secrets required. Alerts land as comments on a pinned
 * "stock alerts" issue with an @mention of the repo owner, which triggers
 * GitHub's built-in notifications (email + app push) to their account.
 */

const API = 'https://api.github.com';
const LABEL = 'stock-alerts';

async function gh(token: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'grail-knife-finder',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${res.status}`);
  return res.json();
}

/** Post markdown to the alerts issue. Returns false when not running in Actions. */
export async function postToAlertsIssue(markdown: string): Promise<boolean> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return false;

  const open = (await gh(token, 'GET', `/repos/${repo}/issues?labels=${LABEL}&state=open&per_page=1`)) as Array<{
    number: number;
  }>;
  let number = open[0]?.number;
  if (!number) {
    const created = (await gh(token, 'POST', `/repos/${repo}/issues`, {
      title: '🔪 Grail stock alerts',
      body:
        'Automated alerts from the Grail Knife Finder land here as comments — ' +
        'watch this issue (or rely on the @mention) to get email/app notifications the moment a grail comes in stock.\n\n' +
        'Configure richer channels (Discord, ntfy, SMTP) any time via repository secrets — see the README.',
      labels: [LABEL],
    })) as { number: number };
    number = created.number;
  }
  const owner = repo.split('/')[0];
  await gh(token, 'POST', `/repos/${repo}/issues/${number}/comments`, { body: `@${owner}\n\n${markdown}` });
  return true;
}

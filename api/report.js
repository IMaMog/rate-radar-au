// Receives on-site "dodgy rate" reports and files them as GitHub issues
// (label: data-issue) so they can be triaged/actioned — reporters never
// touch GitHub. Needs a GITHUB_TOKEN env var with issues:write on the repo.

const REPO = 'IMaMog/rate-radar-au';
const MAX_MESSAGE = 2000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const { message, context, website } = req.body || {};
  // Honeypot: real users never fill the hidden "website" field.
  if (website) {
    res.status(200).json({ ok: true });
    return;
  }
  const text = typeof message === 'string' ? message.trim() : '';
  if (text.length < 3 || text.length > MAX_MESSAGE) {
    res.status(400).json({ error: 'Message must be 3–2000 characters' });
    return;
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    res.status(503).json({ error: 'Reporting not configured' });
    return;
  }

  const c = context || {};
  const title = c.product
    ? `Data issue: ${String(c.bank || '').slice(0, 60)} — ${String(c.product).slice(0, 80)}`
    : 'Data issue (general)';
  const body = [
    '**Report from the site**',
    '',
    text,
    '',
    '---',
    c.product ? `**Product**: ${c.bank} — ${c.product}` : '**Product**: (general)',
    c.brandId ? `**IDs**: brandId \`${c.brandId}\`, productId \`${c.productId}\`` : null,
    c.view ? `**View**: ${c.view}` : null,
    c.snapshot ? `**Snapshot**: ${c.snapshot}` : null,
    `**Reported**: ${new Date().toISOString()}`,
  ]
    .filter(l => l != null)
    .join('\n')
    .slice(0, 6000);

  try {
    const gh = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'rate-radar-au',
      },
      body: JSON.stringify({ title, body, labels: ['data-issue'] }),
    });
    if (!gh.ok) throw new Error(`GitHub ${gh.status}`);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'Could not file the report' });
  }
}

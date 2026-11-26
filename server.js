import http from 'node:http';
import crypto from 'node:crypto';

const {
  PORT = '3000',
  FIGMA_WEBHOOK_PASSCODE,
  WATCHED_FIGMA_USERS = '',
  WATCHED_FILE_KEYS = '',
  WATCHED_LIBRARY_NAMES = '',
  SLACK_WEBHOOK_URL,
  SLACK_BOT_TOKEN,
  SLACK_WORKFLOW_WEBHOOK_URL,
  FIGMA_API_TOKEN,
  FIGMA_API_BASE = 'https://api.figma.com',
  SLACK_NOTIFY_USER_IDS = '',
  SLACK_MENTION_USER_IDS = '',
} = process.env;

if (!FIGMA_WEBHOOK_PASSCODE) {
  console.error('Missing FIGMA_WEBHOOK_PASSCODE');
  process.exit(1);
}

const watched = WATCHED_FIGMA_USERS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const watchedFiles = WATCHED_FILE_KEYS.split(',').map((s) => s.trim().split('#')[0].trim()).filter(Boolean);
const norm = (s = '') => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); // 'Clay-platform' == 'clay platform'
const watchedNames = WATCHED_LIBRARY_NAMES.split(',').map(norm).filter(Boolean);
const mentions = SLACK_MENTION_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean).map((id) => `<@${id}>`).join(' ');
const dmTargets = SLACK_NOTIFY_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean);
const seen = new Set(); // simple de-dupe in case Figma retries delivery

const safeEqual = (a = '', b = '') => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const isWatched = (user = {}) =>
  watched.length === 0 ||
  watched.includes(String(user.handle ?? '').toLowerCase()) ||
  watched.includes(String(user.id ?? '').toLowerCase());

const list = (items = [], max = 8) => {
  if (!items.length) return '';
  const names = items.slice(0, max).map((i) => `• ${i.name}`);
  if (items.length > max) names.push(`• …and ${items.length - max} more`);
  return names.join('\n');
};

function buildSlackMessage(e) {
  const who = e.triggered_by?.handle ?? 'Someone';
  const url = `https://www.figma.com/design/${e.file_key}`;
  const groups = [
    ['Components added', e.created_components],
    ['Components modified', e.modified_components],
    ['Components deleted', e.deleted_components],
    ['Styles added', e.created_styles],
    ['Styles modified', e.modified_styles],
    ['Styles deleted', e.deleted_styles],
  ].filter(([, v]) => v?.length);

  const summary = groups.map(([label, v]) => `*${label}:* ${v.length}`).join('   ') || '_No component/style changes reported_';
  const details = groups.map(([label, v]) => `*${label}*\n${list(v)}`).join('\n\n');

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '🎨 Figma library published' } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${mentions ? mentions + ' ' : ''}*${who}* published *<${url}|${e.file_name}>*\n${summary}` },
    },
  ];
  if (e.description) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Release notes:*\n${e.description}` } });
  if (details) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: details.slice(0, 2900) } });
  blocks.push({
    type: 'actions',
    elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in Figma' }, url }],
  });

  const flat = { who, library: e.file_name, url, summary: groups.map(([l, v]) => `${l}: ${v.length}`).join(', ') || 'No component/style changes reported', notes: e.description || '', details: groups.map(([l, v]) => `${l}: ${v.slice(0, 8).map((i) => i.name).join(', ')}`).join('\n') };
  return { text: `${who} published ${e.file_name}`, blocks, flat };
}

const MAX_PREVIEWS = 4;

// Looks up Figma's own thumbnail for each added/modified component (needs FIGMA_API_TOKEN with library_content:read).
// Any failure just means "no image for that component"; the notification is still sent.
async function fetchPreviews(e) {
  if (!FIGMA_API_TOKEN) return [];
  const comps = [...(e.created_components ?? []), ...(e.modified_components ?? [])].slice(0, MAX_PREVIEWS);
  const results = await Promise.all(
    comps.map(async (c) => {
      try {
        const r = await fetch(`${FIGMA_API_BASE}/v1/components/${encodeURIComponent(c.key)}`, {
          headers: { 'X-Figma-Token': FIGMA_API_TOKEN },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) {
          console.log(`Preview lookup failed for "${c.name}": HTTP ${r.status}`);
          return null;
        }
        const url = (await r.json())?.meta?.thumbnail_url;
        return url ? { name: c.name, url } : null;
      } catch (err) {
        console.log(`Preview lookup error for "${c.name}": ${err.message}`);
        return null;
      }
    }),
  );
  return results.filter(Boolean);
}

async function postToSlack(message) {
  const { flat, fallbackBlocks, ...slackMessage } = message;
  message = slackMessage;
  // Option B: Slack Workflow Builder webhook (no app approval needed). Variables: who, library, url, summary, notes, details.
  if (SLACK_WORKFLOW_WEBHOOK_URL) {
    const res = await fetch(SLACK_WORKFLOW_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(flat) });
    if (!res.ok) throw new Error(`Slack workflow webhook responded ${res.status}: ${await res.text()}`);
    return;
  }
  // Preferred: DM each recipient via a bot token (chat.postMessage with a user ID opens a DM).
  if (SLACK_BOT_TOKEN && dmTargets.length) {
    for (const channel of dmTargets) {
      const send = async (payload) => {
        const res = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
          body: JSON.stringify({ channel, ...payload }),
        });
        return res.json();
      };
      let data = await send(message);
      if (!data.ok && fallbackBlocks) {
        console.log(`Slack rejected the message with images (${data.error}); retrying without images`);
        data = await send({ ...message, blocks: fallbackBlocks });
      }
      if (!data.ok) throw new Error(`Slack chat.postMessage to ${channel} failed: ${data.error}`);
    }
    return;
  }
  // Fallback: channel incoming webhook.
  if (!SLACK_WEBHOOK_URL) {
    console.log('[dry-run] would post to Slack:\n' + JSON.stringify(message, null, 2));
    return;
  }
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (!res.ok) throw new Error(`Slack responded ${res.status}: ${await res.text()}`);
}

async function handleEvent(e) {
  if (e.event_type === 'PING') return console.log('Figma PING received – webhook is live.');
  if (e.event_type !== 'LIBRARY_PUBLISH') return console.log(`Ignoring ${e.event_type}`);

  const key = `${e.webhook_id}:${e.file_key}:${e.timestamp}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > 500) seen.delete(seen.values().next().value);

  const filtering = watchedFiles.length || watchedNames.length;
  const libraryMatch =
    watchedFiles.includes(e.file_key) ||
    watchedNames.some((n) => norm(e.file_name).includes(n));
  if (filtering && !libraryMatch) {
    return console.log(`Skipping publish of ${e.file_name} (${e.file_key}) – not a watched library`);
  }
  if (!isWatched(e.triggered_by)) {
    return console.log(`Skipping publish by ${e.triggered_by?.handle} (not on watch list)`);
  }
  const message = buildSlackMessage(e);
  const previews = await fetchPreviews(e);
  if (previews.length) {
    message.fallbackBlocks = message.blocks;
    const images = previews.map((p) => ({
      type: 'image',
      title: { type: 'plain_text', text: p.name.slice(0, 150) },
      image_url: p.url,
      alt_text: p.name.slice(0, 500),
    }));
    // keep the "Open in Figma" button last
    message.blocks = [...message.blocks.slice(0, -1), ...images, message.blocks[message.blocks.length - 1]];
  }
  await postToSlack(message);
  console.log(`Notified: ${e.triggered_by?.handle} published ${e.file_name}`);
}

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/figma-webhook') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      let event;
      try {
        event = JSON.parse(body);
      } catch {
        res.writeHead(400).end('bad json');
        return;
      }
      if (!safeEqual(event.passcode, FIGMA_WEBHOOK_PASSCODE)) {
        res.writeHead(401).end('bad passcode');
        return;
      }
      res.writeHead(200).end('ok'); // ack fast; Figma retries on slow/failed responses
      handleEvent(event).catch((err) => console.error('Handler error:', err));
    });
  })
  .listen(Number(PORT), () => console.log(`Listening on :${PORT}  (users: ${watched.join(', ') || 'everyone'}; libraries: ${[...watchedFiles, ...watchedNames].join(', ') || 'all'})`));

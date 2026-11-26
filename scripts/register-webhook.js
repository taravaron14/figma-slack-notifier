// Registers a LIBRARY_PUBLISH webhook on your Figma team (run once).
const { FIGMA_TOKEN, FIGMA_TEAM_ID, PUBLIC_URL, FIGMA_WEBHOOK_PASSCODE } = process.env;
for (const [k, v] of Object.entries({ FIGMA_TOKEN, FIGMA_TEAM_ID, PUBLIC_URL, FIGMA_WEBHOOK_PASSCODE })) {
  if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
}
const res = await fetch('https://api.figma.com/v2/webhooks', {
  method: 'POST',
  headers: { 'X-Figma-Token': FIGMA_TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    event_type: 'LIBRARY_PUBLISH',
    context: 'team',
    context_id: FIGMA_TEAM_ID,
    endpoint: `${PUBLIC_URL.replace(/\/$/, '')}/figma-webhook`,
    passcode: FIGMA_WEBHOOK_PASSCODE,
    description: 'Slack notifier for library publishes',
  }),
});
console.log(res.status, JSON.stringify(await res.json(), null, 2));

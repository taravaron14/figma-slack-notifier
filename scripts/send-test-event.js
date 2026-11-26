// Sends a fake LIBRARY_PUBLISH event to your local server to test the Slack message.
const { PORT = '3000', FIGMA_WEBHOOK_PASSCODE, WATCHED_FIGMA_USERS = '' } = process.env;
const handle = WATCHED_FIGMA_USERS.split(',')[0]?.trim() || 'Test User';
const res = await fetch(`http://localhost:${PORT}/figma-webhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    event_type: 'LIBRARY_PUBLISH',
    passcode: FIGMA_WEBHOOK_PASSCODE,
    webhook_id: 'test',
    timestamp: new Date().toISOString(),
    file_key: 'abc123',
    file_name: 'Design System – Core',
    description: 'Updated button states and spacing tokens',
    triggered_by: { id: '1', handle },
    created_components: [{ key: 'a', name: 'Button/Ghost' }],
    modified_components: [{ key: 'b', name: 'Button/Primary' }, { key: 'c', name: 'Input/Default' }],
    deleted_components: [], created_styles: [], modified_styles: [{ key: 'd', name: 'Color/Brand/500' }], deleted_styles: [],
  }),
});
console.log('Server replied', res.status);

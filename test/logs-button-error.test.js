const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'schmiks-logs-button-'));
process.env.CONFIG_PATH = path.join(temporaryDirectory, 'config.json');
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'schmiks.db');

fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ adminRoleId: ['admin'] }));

const { handleButtonInteraction } = require('../commands');
const { database } = require('../database');

test.after(() => {
  if (database.open) database.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('all log page buttons respond safely with category-specific errors when the database is unavailable', async () => {
  database.close();
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    for (const category of ['commands', 'messages', 'general']) {
      const replies = [];
      const handled = await handleButtonInteraction({
        customId: `logs:${category}:1:12`,
        user: { id: 'admin-user', tag: 'admin' },
        member: { roles: ['admin'] },
        guildId: 'guild-1', channelId: 'channel-1',
        reply: async payload => replies.push(payload), update: async () => {}
      });
      assert.equal(handled, true);
      assert.deepEqual(replies, [{
        content: `Could not load ${category === 'commands' ? 'command' : category === 'messages' ? 'message' : 'general'} logs.`,
        ephemeral: true
      }]);
    }
  } finally {
    console.error = originalConsoleError;
  }
});

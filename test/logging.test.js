const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'schmiks-logging-'));
process.env.CONFIG_PATH = path.join(temporaryDirectory, 'config.json');
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'schmiks.db');
delete process.env.BOT_PREFIX;

fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
  prefix: '!',
  moderatorRoleId: [],
  adminRoleId: [],
  links: [{ name: 'YouTube', url: 'https://youtube.example/channel' }]
}));

const { handleButtonInteraction, handlePrefixCommand, handleSlashCommand } = require('../commands');
const { database: applicationDatabase } = require('../database');

test.beforeEach(() => applicationDatabase.exec('DELETE FROM command_events'));

test.after(() => {
  applicationDatabase.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('a successful prefix command is written to the SQLite audit log', async () => {
  const replies = [];

  await handlePrefixCommand({
    content: '!links',
    author: { id: 'user-1', tag: 'tester' },
    member: { roles: { cache: { has: () => false } } },
    guild: { id: 'guild-1' },
    channelId: 'channel-1',
    reply: async payload => replies.push(payload)
  }, '!');

  assert.equal(replies.length, 1);
  assert.equal(fs.existsSync(process.env.DATABASE_PATH), true);

  const database = new Database(process.env.DATABASE_PATH, { readonly: true });
  const events = database.prepare(`
    SELECT guild_id, channel_id, user_id, interaction_type,
           command_name, success, error_code, duration_ms
    FROM command_events
  `).all();
  database.close();

  assert.equal(Number.isInteger(events[0].duration_ms), true);
  assert.equal(events[0].duration_ms >= 0, true);
  delete events[0].duration_ms;
  assert.deepEqual(events, [{
    guild_id: 'guild-1',
    channel_id: 'channel-1',
    user_id: 'user-1',
    interaction_type: 'prefix',
    command_name: 'links',
    success: 1,
    error_code: null
  }]);
});

test('a successful slash command is written to the SQLite audit log', async () => {
  const replies = [];

  await handleSlashCommand({
    commandName: 'links',
    user: { id: 'user-2', tag: 'tester' },
    member: { roles: ['member'] },
    guild: { id: 'guild-2' },
    guildId: 'guild-2',
    channelId: 'channel-2',
    reply: async payload => replies.push(payload)
  });

  assert.equal(replies.length, 1);
  assert.deepEqual(applicationDatabase.prepare(`
    SELECT guild_id, channel_id, user_id, interaction_type,
           command_name, success, error_code
    FROM command_events
  `).all(), [{
    guild_id: 'guild-2',
    channel_id: 'channel-2',
    user_id: 'user-2',
    interaction_type: 'slash',
    command_name: 'links',
    success: 1,
    error_code: null
  }]);
});

test('a denied slash command is recorded as a failed audit event', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    moderatorRoleId: ['moderator'],
    adminRoleId: []
  }));

  const replies = [];
  await handleSlashCommand({
    commandName: 'server-info',
    user: { id: 'user-3', tag: 'tester' },
    member: { roles: ['member'] },
    guild: { id: 'guild-3' },
    guildId: 'guild-3',
    channelId: 'channel-3',
    reply: async payload => replies.push(payload)
  });

  assert.equal(replies[0].ephemeral, true);
  assert.deepEqual(applicationDatabase.prepare(`
    SELECT command_name, success, error_code
    FROM command_events
  `).all(), [{
    command_name: 'server-info',
    success: 0,
    error_code: 'PERMISSION_DENIED'
  }]);
});

test('a handled link button interaction is written to the audit log', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    links: [{ name: 'YouTube', url: 'https://youtube.example/channel' }]
  }));

  const replies = [];
  const handled = await handleButtonInteraction({
    customId: 'link:youtube',
    user: { id: 'user-4', tag: 'tester' },
    guildId: 'guild-4',
    channelId: 'channel-4',
    reply: async payload => replies.push(payload)
  });

  assert.equal(handled, true);
  assert.equal(replies.length, 1);
  assert.deepEqual(applicationDatabase.prepare(`
    SELECT guild_id, user_id, interaction_type, command_name, success
    FROM command_events
  `).all(), [{
    guild_id: 'guild-4',
    user_id: 'user-4',
    interaction_type: 'button',
    command_name: 'link:youtube',
    success: 1
  }]);
});

test('an unknown prefix command is recorded without storing its arguments', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    moderatorRoleId: [],
    adminRoleId: []
  }));

  await handlePrefixCommand({
    content: '!not-a-command secret-value',
    author: { id: 'user-5', tag: 'tester' },
    member: { roles: { cache: { has: () => false } } },
    guild: { id: 'guild-5' },
    channelId: 'channel-5',
    reply: async () => {}
  }, '!');

  assert.deepEqual(applicationDatabase.prepare(`
    SELECT command_name, success, error_code, metadata_json
    FROM command_events
  `).all(), [{
    command_name: 'not-a-command',
    success: 0,
    error_code: 'UNKNOWN_COMMAND',
    metadata_json: null
  }]);
});

test('a command handler error is recorded as an execution failure', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, '{invalid json');

  const replies = [];
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await handlePrefixCommand({
      content: '!links',
      author: { id: 'user-6', tag: 'tester' },
      member: { roles: { cache: { has: () => false } } },
      guild: { id: 'guild-6' },
      channelId: 'channel-6',
      reply: async payload => replies.push(payload)
    }, '!');
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(replies[0].content, 'An error occurred while executing the command.');
  assert.deepEqual(applicationDatabase.prepare(`
    SELECT command_name, success, error_code
    FROM command_events
  `).all(), [{
    command_name: 'links',
    success: 0,
    error_code: 'EXECUTION_FAILED'
  }]);
});

test('authorized moderator commands are logged for prefix and slash use', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    moderatorRoleId: ['moderator'],
    adminRoleId: []
  }));

  const guild = {
    id: 'guild-7',
    name: 'Test Guild',
    ownerId: 'owner',
    memberCount: 1,
    members: {
      cache: {
        filter: predicate => ({
          size: [{ user: { bot: false } }].filter(predicate).length
        })
      }
    },
    createdAt: new Date('2020-01-01T00:00:00Z'),
    verificationLevel: 2,
    iconURL: () => null
  };

  await handlePrefixCommand({
    content: '!server-info',
    author: { id: 'user-7', tag: 'tester' },
    member: { roles: { cache: { has: id => id === 'moderator' } } },
    guild,
    channelId: 'channel-7',
    reply: async () => {}
  }, '!');

  await handleSlashCommand({
    commandName: 'server-info',
    user: { id: 'user-7', tag: 'tester' },
    member: { roles: ['moderator'] },
    guild,
    guildId: 'guild-7',
    channelId: 'channel-7',
    reply: async () => {}
  });

  assert.deepEqual(applicationDatabase.prepare(`
    SELECT interaction_type, command_name, success
    FROM command_events
    ORDER BY id
  `).all(), [
    { interaction_type: 'prefix', command_name: 'server-info', success: 1 },
    { interaction_type: 'slash', command_name: 'server-info', success: 1 }
  ]);
});

test('a denied prefix command is recorded as a failed audit event', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    moderatorRoleId: ['moderator'],
    adminRoleId: []
  }));

  await handlePrefixCommand({
    content: '!server-info',
    author: { id: 'user-8', tag: 'tester' },
    member: { roles: { cache: { has: () => false } } },
    guild: { id: 'guild-8' },
    channelId: 'channel-8',
    reply: async () => {}
  }, '!');

  assert.deepEqual(applicationDatabase.prepare(`
    SELECT command_name, success, error_code
    FROM command_events
  `).all(), [{
    command_name: 'server-info',
    success: 0,
    error_code: 'PERMISSION_DENIED'
  }]);
});

test('an unknown slash command is recorded as a failed audit event', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    moderatorRoleId: [],
    adminRoleId: []
  }));

  await handleSlashCommand({
    commandName: 'not-a-command',
    user: { id: 'user-9', tag: 'tester' },
    member: { roles: ['member'] },
    guild: { id: 'guild-9' },
    guildId: 'guild-9',
    channelId: 'channel-9',
    reply: async () => {}
  });

  assert.deepEqual(applicationDatabase.prepare(`
    SELECT command_name, success, error_code
    FROM command_events
  `).all(), [{
    command_name: 'not-a-command',
    success: 0,
    error_code: 'UNKNOWN_COMMAND'
  }]);
});

test('an unavailable link button is recorded as a failed audit event', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ links: [] }));

  await handleButtonInteraction({
    customId: 'link:youtube',
    user: { id: 'user-10', tag: 'tester' },
    guildId: 'guild-10',
    channelId: 'channel-10',
    reply: async () => {}
  });

  assert.deepEqual(applicationDatabase.prepare(`
    SELECT command_name, success, error_code
    FROM command_events
  `).all(), [{
    command_name: 'link:youtube',
    success: 0,
    error_code: 'LINK_NOT_CONFIGURED'
  }]);
});

test('a button handler error is recorded as an execution failure', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, '{invalid json');

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await handleButtonInteraction({
      customId: 'link:youtube',
      user: { id: 'user-11', tag: 'tester' },
      guildId: 'guild-11',
      channelId: 'channel-11',
      reply: async () => {}
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(applicationDatabase.prepare(`
    SELECT command_name, success, error_code
    FROM command_events
  `).all(), [{
    command_name: 'link:youtube',
    success: 0,
    error_code: 'EXECUTION_FAILED'
  }]);
});

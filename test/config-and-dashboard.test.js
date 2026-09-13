const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'schmiks-'));
process.env.CONFIG_PATH = path.join(temporaryDirectory, 'config.json');
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'schmiks.db');
delete process.env.BOT_PREFIX;

const {
  readLinks,
  readLoggingConfig,
  readPrefix,
  readRoleIds,
  readSlashCommands,
  validateLoggingConfig,
  validatePrefix,
  writeDashboardConfig,
  writePrefix
} = require('../config');
const { handleButtonInteraction, handlePrefixCommand, handleSlashCommand } = require('../commands');
const { database } = require('../database');
const app = require('../dashboard/server');

const defaultLogColors = {
  commandExecution: '#5865F2',
  messageEdit: '#FEE75C',
  messageDelete: '#ED4245',
  memberJoin: '#57F287',
  memberLeave: '#ED4245',
  voiceJoin: '#57F287',
  voiceLeave: '#ED4245'
};

test.after(() => {
  database.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('logging config defaults to disabled delivery with 90-day retention', () => {
  assert.deepEqual(readLoggingConfig(), {
    channelId: '',
    retentionDays: 90,
    colors: defaultLogColors,
    delivery: {
      commandExecution: false,
      messageEdit: false,
      messageDelete: false,
      memberJoin: false,
      memberLeave: false,
      voiceJoin: false,
      voiceLeave: false
    }
  });
});

test('logging config normalizes missing delivery switches to false', () => {
  assert.deepEqual(validateLoggingConfig({
    channelId: '12345678901234567',
    retentionDays: 3650,
    delivery: { messageDelete: true }
  }), {
    channelId: '12345678901234567',
    retentionDays: 3650,
    colors: defaultLogColors,
    delivery: {
      commandExecution: false,
      messageEdit: false,
      messageDelete: true,
      memberJoin: false,
      memberLeave: false,
      voiceJoin: false,
      voiceLeave: false
    }
  });
});

test('logging config rejects invalid channel IDs and retention values', () => {
  assert.throws(() => validateLoggingConfig({ channelId: '123', retentionDays: 90, delivery: {} }), /channel/i);
  assert.throws(() => validateLoggingConfig({ channelId: '', retentionDays: 0, delivery: {} }), /retention/i);
  assert.throws(() => validateLoggingConfig({ channelId: '', retentionDays: 90.5, delivery: {} }), /retention/i);
  assert.throws(() => validateLoggingConfig({ channelId: '', retentionDays: 3651, delivery: {} }), /retention/i);
});

test('logging config validates and normalizes individual embed colors', () => {
  assert.deepEqual(validateLoggingConfig({
    channelId: '',
    retentionDays: 90,
    delivery: {},
    colors: { messageEdit: '#123abc', voiceLeave: '#ABCDEF' }
  }).colors, {
    ...defaultLogColors,
    messageEdit: '#123ABC',
    voiceLeave: '#ABCDEF'
  });
  assert.throws(() => validateLoggingConfig({
    channelId: '',
    retentionDays: 90,
    delivery: {},
    colors: { messageDelete: 'red' }
  }), /color/i);
  assert.throws(() => validateLoggingConfig({
    channelId: '',
    retentionDays: 90,
    delivery: {},
    colors: { memberJoin: '#12345' }
  }), /color/i);
});

test('logging config rejects enabled delivery without a channel ID', () => {
  assert.throws(() => validateLoggingConfig({
    channelId: '',
    retentionDays: 90,
    delivery: { voiceJoin: true }
  }), /channel/i);
});

test('dashboard config round-trips logging and preserves unrelated keys', () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    prefix: '!',
    moderatorRoleId: ['moderator'],
    adminRoleId: ['admin'],
    slashCommands: [{ name: 'links', description: 'Show links' }],
    links: [{ name: 'YouTube', url: 'https://youtube.example' }],
    futureSetting: { keep: true }
  }));

  const saved = writeDashboardConfig({
    prefix: '$',
    logging: {
      channelId: '12345678901234567890',
      retentionDays: 30,
      colors: { messageEdit: '#112233', memberLeave: '#abcdef' },
      delivery: { commandExecution: true, memberLeave: true }
    }
  });

  assert.deepEqual(saved, {
    prefix: '$',
    logging: {
      channelId: '12345678901234567890',
      retentionDays: 30,
      colors: {
        ...defaultLogColors,
        messageEdit: '#112233',
        memberLeave: '#ABCDEF'
      },
      delivery: {
        commandExecution: true,
        messageEdit: false,
        messageDelete: false,
        memberJoin: false,
        memberLeave: true,
        voiceJoin: false,
        voiceLeave: false
      }
    }
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, 'utf8')), {
    prefix: '$',
    moderatorRoleId: ['moderator'],
    adminRoleId: ['admin'],
    slashCommands: [{ name: 'links', description: 'Show links' }],
    links: [{ name: 'YouTube', url: 'https://youtube.example' }],
    futureSetting: { keep: true },
    logging: saved.logging
  });
});

test('prefix config validates and round-trips', () => {
  fs.rmSync(process.env.CONFIG_PATH, { force: true });
  assert.equal(readPrefix(), '!');
  assert.equal(writePrefix('?'), '?');
  assert.equal(readPrefix(), '?');
  assert.throws(() => validatePrefix(''), /non-empty/);
  assert.throws(() => validatePrefix('123456'), /at most 5/);
});

test('link config returns usable name and URL pairs', () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    links: [
      { name: 'youtube', url: 'https://youtube.example/channel' },
      { name: '', url: 'https://invalid.example' },
      { name: 'missing-url' }
    ]
  }));

  assert.deepEqual(readLinks(), [
    { name: 'youtube', url: 'https://youtube.example/channel' }
  ]);
});

test('slash command registration includes the logs choices', () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    slashCommands: [{ name: 'links', description: 'Show useful server links' }]
  }));

  const logsCommand = readSlashCommands().find(command => command.name === 'logs');

  assert.equal(logsCommand.name, 'logs');
  assert.equal(logsCommand.description, 'View server logs');
  assert.equal(logsCommand.options[0].name, 'type');
  assert.equal(logsCommand.options[0].required, true);
  assert.deepEqual(logsCommand.options[0].choices.map(({ name, value }) => ({ name, value })), [
    { name: 'general', value: 'general' },
    { name: 'messages', value: 'messages' },
    { name: 'commands', value: 'commands' }
  ]);
});

test('server-info accepts an admin role in prefix and slash commands', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    prefix: '!',
    moderatorRoleId: [],
    adminRoleId: ['admin']
  }));
  assert.deepEqual(readRoleIds(), { moderatorRoleIds: [], adminRoleIds: ['admin'] });

  const replies = [];
  const guild = {
    id: 'guild',
    name: 'Test Guild',
    ownerId: 'owner',
    memberCount: 2,
    members: {
      cache: {
        filter: predicate => ({
          size: [{ user: { bot: false } }, { user: { bot: true } }].filter(predicate).length
        })
      }
    },
    createdAt: new Date('2020-01-01T00:00:00Z'),
    verificationLevel: 2,
    iconURL: () => null
  };
  await handlePrefixCommand({
    content: '!server-info',
    author: { id: 'user', tag: 'tester' },
    member: { roles: { cache: { has: id => id === 'admin' } } },
    guild,
    channelId: 'channel',
    reply: async payload => replies.push(payload)
  }, '!');

  await handleSlashCommand({
    commandName: 'server-info',
    user: { id: 'user', tag: 'tester' },
    member: { roles: ['admin'] },
    guild,
    guildId: 'guild',
    channelId: 'channel',
    reply: async payload => replies.push(payload)
  });

  assert.equal(replies.length, 2);
  const verificationField = replies[0].embeds[0].toJSON().fields
    .find(field => field.name === 'Verification Level');
  assert.equal(verificationField.value, '2');
});

test('links presents the four platform buttons to prefix and slash users', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    prefix: '!',
    moderatorRoleId: [],
    adminRoleId: [],
    links: [
      { name: 'YouTube', url: 'https://youtube.example/channel', iconUrl: '' },
      { name: 'Twitch', url: 'https://twitch.example/channel', iconUrl: '' },
      { name: 'TikTok', url: 'https://tiktok.example/profile', iconUrl: '' },
      { name: 'Instagram', url: 'https://instagram.example/profile', iconUrl: '' }
    ]
  }));

  const replies = [];
  const member = { roles: { cache: { has: () => false } } };
  const guild = { id: 'guild' };

  await handlePrefixCommand({
    content: '!links',
    author: { id: 'user', tag: 'tester' },
    member,
    guild,
    channelId: 'channel',
    reply: async payload => replies.push(payload)
  }, '!');

  await handleSlashCommand({
    commandName: 'links',
    user: { id: 'user', tag: 'tester' },
    member,
    guild,
    guildId: 'guild',
    channelId: 'channel',
    reply: async payload => replies.push(payload)
  });

  assert.equal(replies.length, 2);
  for (const reply of replies) {
    assert.equal(reply.ephemeral, undefined);
    assert.equal(reply.content, 'Which link would you like?');
    assert.deepEqual(
      reply.components[0].components.map(button => {
        const data = button.toJSON();
        return { label: data.label, customId: data.custom_id, disabled: data.disabled ?? false };
      }),
      [
        { label: 'YouTube', customId: 'link:youtube', disabled: false },
        { label: 'Twitch', customId: 'link:twitch', disabled: false },
        { label: 'TikTok', customId: 'link:tiktok', disabled: false },
        { label: 'Instagram', customId: 'link:instagram', disabled: false }
      ]
    );
  }
});

test('a link button returns a public hyperlink embed with its configured icon', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    links: [{
      name: 'YouTube',
      url: 'https://youtube.example/channel',
      iconUrl: 'https://assets.example/youtube.png'
    }]
  }));

  const replies = [];
  await handleButtonInteraction({
    customId: 'link:youtube',
    user: { id: 'user', tag: 'tester' },
    guildId: 'guild',
    channelId: 'channel',
    reply: async payload => replies.push(payload)
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, undefined);
  assert.deepEqual(replies[0].embeds[0].toJSON(), {
    color: 0x0099ff,
    title: 'YouTube',
    description: '[Click here](https://youtube.example/channel)',
    thumbnail: { url: 'https://assets.example/youtube.png' }
  });
});

test('dashboard returns and saves prefix plus logging without dropping unrelated keys', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const dashboardHtml = await (await fetch(`${baseUrl}/`)).text();
  assert.equal((dashboardHtml.match(/type="color"/g) ?? []).length, 7);
  for (const key of Object.keys(defaultLogColors)) {
    assert.match(dashboardHtml, new RegExp(`data-color-key="${key}"`));
  }

  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    prefix: '!',
    adminRoleId: ['admin'],
    links: [{ name: 'YouTube', url: 'https://youtube.example' }],
    futureSetting: 'keep-me'
  }));

  const update = await fetch(`${baseUrl}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prefix: '$',
      logging: {
        channelId: '12345678901234567',
        retentionDays: 120,
        colors: { commandExecution: '#010203', voiceLeave: '#a0b0c0' },
        delivery: { messageEdit: true, voiceLeave: true }
      },
      token: 'must-not-be-written'
    })
  });
  assert.equal(update.status, 200);
  assert.deepEqual(await update.json(), {
    success: true,
    prefix: '$',
    logging: {
      channelId: '12345678901234567',
      retentionDays: 120,
      colors: {
        ...defaultLogColors,
        commandExecution: '#010203',
        voiceLeave: '#A0B0C0'
      },
      delivery: {
        commandExecution: false,
        messageEdit: true,
        messageDelete: false,
        memberJoin: false,
        memberLeave: false,
        voiceJoin: false,
        voiceLeave: true
      }
    }
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, 'utf8')), {
    prefix: '$',
    adminRoleId: ['admin'],
    links: [{ name: 'YouTube', url: 'https://youtube.example' }],
    futureSetting: 'keep-me',
    logging: {
      channelId: '12345678901234567',
      retentionDays: 120,
      colors: {
        ...defaultLogColors,
        commandExecution: '#010203',
        voiceLeave: '#A0B0C0'
      },
      delivery: {
        commandExecution: false,
        messageEdit: true,
        messageDelete: false,
        memberJoin: false,
        memberLeave: false,
        voiceJoin: false,
        voiceLeave: true
      }
    }
  });

  const invalid = await fetch(`${baseUrl}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prefix: '$',
      logging: { channelId: '', retentionDays: 90, delivery: { memberJoin: true } }
    })
  });
  assert.equal(invalid.status, 400);

  const current = await fetch(`${baseUrl}/api/config`);
  assert.deepEqual(await current.json(), {
    prefix: '$',
    logging: {
      channelId: '12345678901234567',
      retentionDays: 120,
      colors: {
        ...defaultLogColors,
        commandExecution: '#010203',
        voiceLeave: '#A0B0C0'
      },
      delivery: {
        commandExecution: false,
        messageEdit: true,
        messageDelete: false,
        memberJoin: false,
        memberLeave: false,
        voiceJoin: false,
        voiceLeave: true
      }
    }
  });

  process.env.BOT_PREFIX = '#';
  const overridden = await fetch(`${baseUrl}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prefix: '?',
      logging: {
        channelId: '123456789012345678',
        retentionDays: 365,
        colors: { voiceJoin: '#0a0b0c' },
        delivery: { voiceJoin: true }
      }
    })
  });
  assert.equal(overridden.status, 200);
  assert.equal((await overridden.json()).prefix, '?');
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, 'utf8')).logging, {
    channelId: '123456789012345678',
    retentionDays: 365,
    colors: {
      ...defaultLogColors,
      voiceJoin: '#0A0B0C'
    },
    delivery: {
      commandExecution: false,
      messageEdit: false,
      messageDelete: false,
      memberJoin: false,
      memberLeave: false,
      voiceJoin: true,
      voiceLeave: false
    }
  });
  const overriddenCurrent = await fetch(`${baseUrl}/api/config`);
  assert.equal((await overriddenCurrent.json()).prefix, '#');
  delete process.env.BOT_PREFIX;
});

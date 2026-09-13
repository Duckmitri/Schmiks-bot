const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'schmiks-events-'));
process.env.CONFIG_PATH = path.join(temporaryDirectory, 'config.json');
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'schmiks.db');

const databaseApi = require('../database');
const {
  deliverLogEvent,
  handleMemberJoin,
  handleMemberLeave,
  handleMessageDelete,
  handleMessageUpdate,
  handleVoiceStateUpdate,
  runRetentionCleanup,
  snapshotMessage,
  startRetentionScheduler
} = require('../event-logging');

const deliveryKeys = [
  ['command_execution', 'commandExecution'],
  ['message_edit', 'messageEdit'],
  ['message_delete', 'messageDelete'],
  ['member_join', 'memberJoin'],
  ['member_leave', 'memberLeave'],
  ['voice_join', 'voiceJoin'],
  ['voice_leave', 'voiceLeave']
];

function writeLoggingConfig({ channelId = '', retentionDays = 90, enabled = [], colors } = {}) {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    prefix: '!',
    moderatorRoleId: [],
    adminRoleId: [],
    links: [{ name: 'YouTube', url: 'https://youtube.example/channel' }],
    logging: {
      channelId,
      retentionDays,
      ...(colors ? { colors } : {}),
      delivery: Object.fromEntries(deliveryKeys.map(([, key]) => [key, enabled.includes(key)]))
    }
  }));
}

function makeGuild({ channel, fetchedChannel, fetchError } = {}) {
  const cache = new Map();
  if (channel) cache.set('12345678901234567', channel);
  return {
    id: 'guild-1',
    channels: {
      cache,
      fetch: async id => {
        assert.equal(id, '12345678901234567');
        if (fetchError) throw fetchError;
        return fetchedChannel ?? null;
      }
    }
  };
}

function makeMessage(overrides = {}) {
  const guild = overrides.guild === undefined ? makeGuild() : overrides.guild;
  const author = overrides.author === undefined
    ? { id: 'user-1', bot: false, tag: 'tester#0001', username: 'tester' }
    : overrides.author;
  return {
    id: 'message-1',
    guild,
    guildId: guild?.id,
    channelId: 'source-channel',
    author,
    member: author ? { displayName: 'Display Tester', user: author } : null,
    content: 'hello',
    attachments: new Map([
      ['attachment-1', { url: 'https://cdn.example/one.png', name: 'one.png' }]
    ]),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    editedAt: new Date('2026-01-01T00:01:00.000Z'),
    partial: false,
    ...overrides
  };
}

function messageEvents() {
  return databaseApi.database.prepare(`
    SELECT guild_id, channel_id, message_id, author_id, event_type,
           before_content, after_content, before_attachment_urls_json,
           after_attachment_urls_json
    FROM message_events
    ORDER BY id
  `).all();
}

function generalEvents() {
  return databaseApi.database.prepare(`
    SELECT guild_id, user_id, user_label, event_type, channel_id
    FROM general_events
    ORDER BY id
  `).all();
}

test.beforeEach(() => {
  databaseApi.database.exec(`
    DELETE FROM command_events;
    DELETE FROM message_events;
    DELETE FROM general_events;
    DELETE FROM message_snapshots;
  `);
  writeLoggingConfig();
});

test.after(() => {
  if (databaseApi.database.open) databaseApi.database.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('snapshotMessage ignores bot-authored and non-guild messages', async () => {
  await snapshotMessage(makeMessage({ author: { id: 'bot', bot: true, tag: 'bot#0001' } }));
  await snapshotMessage(makeMessage({ guild: null, guildId: null }));

  assert.equal(databaseApi.database.prepare('SELECT COUNT(*) AS count FROM message_snapshots').get().count, 0);
});

test('snapshotMessage stores content, attachment URLs, author details, and timestamps', async () => {
  await snapshotMessage(makeMessage());

  assert.deepEqual(databaseApi.readMessageSnapshot('message-1', 'guild-1'), {
    message_id: 'message-1',
    guild_id: 'guild-1',
    channel_id: 'source-channel',
    author_id: 'user-1',
    author_label: 'Display Tester',
    content: 'hello',
    attachment_urls_json: '["https://cdn.example/one.png"]',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:01:00.000Z',
    deleted_at: null
  });
});

test('handleMessageUpdate records nothing when content and attachment URLs are unchanged', async () => {
  const original = makeMessage();
  await snapshotMessage(original);

  await handleMessageUpdate(original, makeMessage());

  assert.deepEqual(messageEvents(), []);
});

test('handleMessageUpdate stores before-state first, updates the snapshot, and delivers a changed edit', async () => {
  let rowsVisibleAtSend = 0;
  const channel = {
    isTextBased: () => true,
    send: async () => {
      rowsVisibleAtSend = messageEvents().length;
    }
  };
  const guild = makeGuild({ channel });
  writeLoggingConfig({ channelId: '12345678901234567', enabled: ['messageEdit'] });
  await snapshotMessage(makeMessage({ guild }));

  await handleMessageUpdate(
    makeMessage({ guild, content: 'stale Discord value' }),
    makeMessage({
      guild,
      content: 'updated',
      attachments: new Map([['attachment-2', { url: 'https://cdn.example/two.png' }]]),
      editedAt: new Date('2026-01-01T00:02:00.000Z')
    })
  );

  assert.equal(rowsVisibleAtSend, 1);
  assert.deepEqual(messageEvents(), [{
    guild_id: 'guild-1',
    channel_id: 'source-channel',
    message_id: 'message-1',
    author_id: 'user-1',
    event_type: 'message_edit',
    before_content: 'hello',
    after_content: 'updated',
    before_attachment_urls_json: '["https://cdn.example/one.png"]',
    after_attachment_urls_json: '["https://cdn.example/two.png"]'
  }]);
  assert.equal(databaseApi.readMessageSnapshot('message-1', 'guild-1').content, 'updated');
});

test('handleMessageUpdate fetches a partial new message when possible', async () => {
  await snapshotMessage(makeMessage());
  let fetches = 0;
  const fetched = makeMessage({ content: 'fetched content' });
  const partial = makeMessage({
    partial: true,
    content: '',
    fetch: async () => {
      fetches += 1;
      return fetched;
    }
  });

  await handleMessageUpdate(makeMessage(), partial);

  assert.equal(fetches, 1);
  assert.equal(messageEvents()[0].after_content, 'fetched content');
});

test('handleMessageUpdate reads Discord message properties without flattening prototype getters', async () => {
  await snapshotMessage(makeMessage());
  const guild = makeGuild();
  class DiscordLikeMessage {
    get id() { return 'message-1'; }
    get guildId() { return 'guild-1'; }
    get guild() { return guild; }
    get channelId() { return 'source-channel'; }
    get author() { return { id: 'user-1', bot: false, tag: 'tester#0001' }; }
    get member() { return { displayName: 'Display Tester', user: this.author }; }
    get content() { return 'getter content'; }
    get attachments() { return new Map(); }
    get createdAt() { return new Date('2026-01-01T00:00:00.000Z'); }
    get editedAt() { return new Date('2026-01-01T00:03:00.000Z'); }
    get partial() { return false; }
  }

  await handleMessageUpdate(makeMessage(), new DiscordLikeMessage());

  assert.equal(messageEvents()[0].after_content, 'getter content');
});

test('handleMessageUpdate contains a failed partial fetch without changing stored state', async () => {
  await snapshotMessage(makeMessage());
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await handleMessageUpdate(makeMessage(), makeMessage({
      partial: true,
      fetch: async () => { throw new Error('fetch failed'); }
    }));
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(messageEvents(), []);
  assert.equal(databaseApi.readMessageSnapshot('message-1', 'guild-1').content, 'hello');
});

test('handleMessageDelete prefers the snapshot, records before-state, marks deleted, then delivers', async () => {
  let deletedAtSend = null;
  const channel = {
    isTextBased: () => true,
    send: async () => {
      deletedAtSend = databaseApi.readMessageSnapshot('message-1', 'guild-1').deleted_at;
    }
  };
  const guild = makeGuild({ channel });
  writeLoggingConfig({ channelId: '12345678901234567', enabled: ['messageDelete'] });
  await snapshotMessage(makeMessage({ guild }));

  await handleMessageDelete(makeMessage({ guild, content: 'incomplete Discord value', attachments: new Map() }));

  assert.ok(deletedAtSend);
  assert.deepEqual(messageEvents()[0], {
    guild_id: 'guild-1',
    channel_id: 'source-channel',
    message_id: 'message-1',
    author_id: 'user-1',
    event_type: 'message_delete',
    before_content: 'hello',
    after_content: null,
    before_attachment_urls_json: '["https://cdn.example/one.png"]',
    after_attachment_urls_json: null
  });
});

test('handleMessageDelete always records a known guild message ID when content and author are unavailable', async () => {
  await handleMessageDelete(makeMessage({
    id: 'partial-delete',
    author: null,
    member: null,
    content: undefined,
    attachments: undefined
  }));

  assert.deepEqual(messageEvents(), [{
    guild_id: 'guild-1',
    channel_id: 'source-channel',
    message_id: 'partial-delete',
    author_id: 'unknown',
    event_type: 'message_delete',
    before_content: '',
    after_content: null,
    before_attachment_urls_json: '[]',
    after_attachment_urls_json: null
  }]);
});

test('member add and remove events use the best member display label', async () => {
  const member = {
    id: 'user-2',
    displayName: 'Guild Display',
    user: { id: 'user-2', globalName: 'Global Name', username: 'username' },
    guild: makeGuild(),
    joinedAt: new Date('2026-01-02T00:00:00.000Z')
  };

  await handleMemberJoin(member);
  await handleMemberLeave(member);

  assert.deepEqual(generalEvents(), [
    { guild_id: 'guild-1', user_id: 'user-2', user_label: 'Guild Display', event_type: 'member_join', channel_id: null },
    { guild_id: 'guild-1', user_id: 'user-2', user_label: 'Guild Display', event_type: 'member_leave', channel_id: null }
  ]);
});

test('voice state changes record joins, leaves, moves in order, and ignore unchanged channels', async () => {
  const guild = makeGuild();
  const member = { id: 'user-3', displayName: 'Voice User', user: { id: 'user-3', username: 'voice' } };
  const state = channelId => ({ guild, id: 'user-3', member, channelId });

  await handleVoiceStateUpdate(state(null), state('voice-a'));
  await handleVoiceStateUpdate(state('voice-a'), state('voice-b'));
  await handleVoiceStateUpdate(state('voice-b'), state(null));
  await handleVoiceStateUpdate(state('voice-c'), state('voice-c'));

  assert.deepEqual(generalEvents(), [
    { guild_id: 'guild-1', user_id: 'user-3', user_label: 'Voice User', event_type: 'voice_join', channel_id: 'voice-a' },
    { guild_id: 'guild-1', user_id: 'user-3', user_label: 'Voice User', event_type: 'voice_leave', channel_id: 'voice-a' },
    { guild_id: 'guild-1', user_id: 'user-3', user_label: 'Voice User', event_type: 'voice_join', channel_id: 'voice-b' },
    { guild_id: 'guild-1', user_id: 'user-3', user_label: 'Voice User', event_type: 'voice_leave', channel_id: 'voice-b' }
  ]);
});

test('voice moves persist leave and join before delayed delivery lets a disconnect overtake them', async () => {
  let releaseDelivery;
  const deliveryGate = new Promise(resolve => { releaseDelivery = resolve; });
  const guild = makeGuild({
    channel: { isTextBased: () => true, send: async () => deliveryGate }
  });
  writeLoggingConfig({
    channelId: '12345678901234567',
    enabled: ['voiceJoin', 'voiceLeave']
  });
  const member = { id: 'user-3', displayName: 'Voice User', user: { id: 'user-3', username: 'voice' } };
  const state = channelId => ({ guild, id: 'user-3', member, channelId });

  const move = handleVoiceStateUpdate(state('voice-a'), state('voice-b'));
  const disconnect = handleVoiceStateUpdate(state('voice-b'), state(null));
  try {
    assert.deepEqual(generalEvents().map(event => [event.event_type, event.channel_id]), [
      ['voice_leave', 'voice-a'],
      ['voice_join', 'voice-b'],
      ['voice_leave', 'voice-b']
    ]);
  } finally {
    releaseDelivery();
    await Promise.allSettled([move, disconnect]);
  }
});

test('every delivery switch controls only its matching event type', async () => {
  for (const [eventType, configKey] of deliveryKeys) {
    const sent = [];
    const guild = makeGuild({
      channel: { isTextBased: () => true, send: async payload => sent.push(payload) }
    });
    writeLoggingConfig({ channelId: '12345678901234567', enabled: [configKey] });

    for (const [candidateType] of deliveryKeys) {
      const delivered = await deliverLogEvent(guild, candidateType, {
        guildId: guild.id,
        channelId: 'source-channel',
        userId: 'user-1',
        userLabel: 'Tester',
        messageId: 'message-1',
        commandName: 'links',
        interactionType: 'prefix',
        success: true,
        beforeContent: 'before',
        afterContent: 'after',
        beforeAttachmentUrls: [],
        afterAttachmentUrls: [],
        timestamp: '2026-01-01T00:00:00.000Z'
      });
      assert.equal(delivered, candidateType === eventType, `${configKey} must not control ${candidateType}`);
    }
    assert.equal(sent.length, 1);
  }
});

test('every event type uses its independently configured embed color', async () => {
  const colors = {
    commandExecution: '#010203',
    messageEdit: '#112233',
    messageDelete: '#223344',
    memberJoin: '#334455',
    memberLeave: '#445566',
    voiceJoin: '#556677',
    voiceLeave: '#667788'
  };
  const expectedColors = {
    commandExecution: 0x010203,
    messageEdit: 0x112233,
    messageDelete: 0x223344,
    memberJoin: 0x334455,
    memberLeave: 0x445566,
    voiceJoin: 0x556677,
    voiceLeave: 0x667788
  };

  for (const [eventType, configKey] of deliveryKeys) {
    let payload;
    const guild = makeGuild({
      channel: { isTextBased: () => true, send: async value => { payload = value; } }
    });
    writeLoggingConfig({
      channelId: '12345678901234567',
      enabled: [configKey],
      colors
    });

    assert.equal(await deliverLogEvent(guild, eventType, {
      userId: 'user-1',
      channelId: 'source-channel',
      messageId: 'message-1',
      commandName: 'links',
      interactionType: 'prefix',
      success: true,
      beforeContent: 'before',
      afterContent: 'after',
      beforeAttachmentUrls: [],
      afterAttachmentUrls: [],
      timestamp: '2026-01-01T00:00:00.000Z'
    }), true);
    assert.equal(payload.embeds[0].toJSON().color, expectedColors[configKey]);
  }
});

test('delivery resolves cached channels first and falls back to fetch', async () => {
  writeLoggingConfig({ channelId: '12345678901234567', enabled: ['memberJoin'] });
  const cachedSends = [];
  const cachedGuild = makeGuild({
    channel: { isTextBased: () => true, send: async payload => cachedSends.push(payload) },
    fetchError: new Error('cache should win')
  });
  const fetchedSends = [];
  const fetchedGuild = makeGuild({
    fetchedChannel: { isTextBased: () => true, send: async payload => fetchedSends.push(payload) }
  });

  assert.equal(await deliverLogEvent(cachedGuild, 'member_join', { userId: 'u', timestamp: new Date() }), true);
  assert.equal(await deliverLogEvent(fetchedGuild, 'member_join', { userId: 'u', timestamp: new Date() }), true);
  assert.equal(cachedSends.length, 1);
  assert.equal(fetchedSends.length, 1);
});

test('delivery returns false for disabled, unconfigured, missing, and unsendable channels', async t => {
  t.mock.method(console, 'warn', () => {});
  const event = { userId: 'u', timestamp: new Date() };
  assert.equal(await deliverLogEvent(makeGuild(), 'member_join', event), false);

  writeLoggingConfig({ channelId: '12345678901234567', enabled: ['memberJoin'] });
  assert.equal(await deliverLogEvent(makeGuild(), 'member_join', event), false);
  assert.equal(await deliverLogEvent(makeGuild({
    fetchedChannel: { isTextBased: () => false, send: async () => {} }
  }), 'member_join', event), false);
  assert.equal(await deliverLogEvent(makeGuild({
    fetchedChannel: { isTextBased: () => true }
  }), 'member_join', event), false);
});

test('delivery bounds event content and attachment details in a valid embed', async () => {
  let payload;
  const guild = makeGuild({
    channel: { isTextBased: () => true, send: async value => { payload = value; } }
  });
  writeLoggingConfig({ channelId: '12345678901234567', enabled: ['messageEdit'] });

  assert.equal(await deliverLogEvent(guild, 'message_edit', {
    userId: 'user-1',
    channelId: 'source-channel',
    messageId: 'message-1',
    beforeContent: 'a'.repeat(10_000),
    afterContent: 'b'.repeat(10_000),
    beforeAttachmentUrls: Array.from({ length: 100 }, (_, index) => `https://cdn.example/${index}/${'x'.repeat(100)}`),
    afterAttachmentUrls: Array.from({ length: 100 }, (_, index) => `https://cdn.example/new-${index}/${'y'.repeat(100)}`),
    timestamp: '2026-01-01T00:00:00.000Z'
  }), true);

  const embed = payload.embeds[0].toJSON();
  assert.ok(embed.timestamp);
  assert.match(JSON.stringify(embed), /<@user-1>/);
  assert.match(JSON.stringify(embed), /<#source-channel>/);
  assert.ok(embed.description.length <= 4096);
  assert.ok(embed.fields.every(field => field.name.length <= 256 && field.value.length <= 1024));
  assert.ok(JSON.stringify(embed).length < 6000);
});

for (const [name, guild, channelId, reason] of [
  ['unconfigured', makeGuild(), '', /channel.*(configured|missing|required)/i],
  ['unresolved', makeGuild(), '12345678901234567', /(resolve|found)/i],
  ['missing guild channels', { id: 'guild-1' }, '12345678901234567', /(resolve|available|missing)/i],
  ['non-text', makeGuild({ channel: { isTextBased: () => false, send: async () => {} } }), '12345678901234567', /(text|send)/i],
  ['unsendable', makeGuild({ channel: { isTextBased: () => true, isSendable: () => false, send: async () => {} } }), '12345678901234567', /send/i],
  ['missing send method', makeGuild({ channel: { isTextBased: () => true } }), '12345678901234567', /send/i]
]) {
  test(`enabled delivery diagnoses ${name} channels; disabled delivery stays quiet`, async t => {
    const diagnostics = [];
    t.mock.method(console, 'error', (...args) => diagnostics.push(args.join(' ')));
    t.mock.method(console, 'warn', (...args) => diagnostics.push(args.join(' ')));
    writeLoggingConfig({ channelId });
    assert.equal(await deliverLogEvent(guild, 'member_join', {}), false);
    assert.equal(diagnostics.length, 0);
    writeLoggingConfig({ channelId, enabled: ['memberJoin'] });
    assert.equal(await deliverLogEvent(guild, 'member_join', {}), false);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /member_join/);
    assert.match(diagnostics[0], reason);
  });
}

test('delivery contains channel fetch and send failures', async () => {
  writeLoggingConfig({ channelId: '12345678901234567', enabled: ['memberJoin'] });
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    assert.equal(await deliverLogEvent(makeGuild({ fetchError: new Error('fetch failed') }), 'member_join', {
      userId: 'user-1'
    }), false);
    assert.equal(await deliverLogEvent(makeGuild({
      channel: { isTextBased: () => true, send: async () => { throw new Error('send failed'); } }
    }), 'member_join', { userId: 'user-1' }), false);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(errors.length, 2);
});

test('runRetentionCleanup reads current retention settings on every run', () => {
  databaseApi.logGeneralEvent({
    guildId: 'guild-1', userId: 'user-old', userLabel: 'Old', type: 'member_leave',
    timestamp: '2026-01-02T00:00:00.000Z'
  });
  writeLoggingConfig({ retentionDays: 30 });
  assert.equal(runRetentionCleanup(new Date('2026-01-10T00:00:00.000Z')).generalEvents, 0);

  writeLoggingConfig({ retentionDays: 1 });
  assert.equal(runRetentionCleanup(new Date('2026-01-10T00:00:00.000Z')).generalEvents, 1);
});

test('startRetentionScheduler returns an unreferenced 24-hour interval', () => {
  const timer = startRetentionScheduler();
  try {
    assert.equal(timer._idleTimeout, 24 * 60 * 60 * 1000);
    assert.equal(timer.hasRef(), false);
  } finally {
    clearInterval(timer);
  }
});

test('command audit delivery happens only after its command event is stored', async () => {
  const { handlePrefixCommand } = require('../commands');
  let commandRowsAtSend = 0;
  const guild = makeGuild({
    channel: {
      isTextBased: () => true,
      send: async () => {
        commandRowsAtSend = databaseApi.database.prepare('SELECT COUNT(*) AS count FROM command_events').get().count;
      }
    }
  });
  writeLoggingConfig({ channelId: '12345678901234567', enabled: ['commandExecution'] });

  await handlePrefixCommand({
    content: '!links',
    author: { id: 'user-1', bot: false, tag: 'tester#0001' },
    member: { roles: { cache: { has: () => false } } },
    guild,
    guildId: guild.id,
    channelId: 'source-channel',
    reply: async () => {}
  }, '!');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(commandRowsAtSend, 1);
});

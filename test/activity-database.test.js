const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { execFileSync } = require('node:child_process');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'schmiks-activity-database-'));
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'schmiks.db');

const legacyDatabase = new Database(process.env.DATABASE_PATH);
legacyDatabase.exec(`
  CREATE TABLE command_events (
    id INTEGER PRIMARY KEY,
    occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    guild_id TEXT NOT NULL,
    channel_id TEXT,
    user_id TEXT NOT NULL,
    interaction_type TEXT NOT NULL,
    command_name TEXT NOT NULL,
    target_user_id TEXT,
    success INTEGER NOT NULL,
    duration_ms INTEGER,
    error_code TEXT,
    metadata_json TEXT
  );
  INSERT INTO command_events (guild_id, user_id, interaction_type, command_name, success)
  VALUES ('legacy-guild', 'legacy-user', 'prefix', 'legacy', 1);
`);
legacyDatabase.close();

const {
  database,
  logCommandEvent,
  readCommandEventsPage,
  upsertMessageSnapshot,
  readMessageSnapshot,
  markMessageSnapshotDeleted,
  logMessageEvent,
  logGeneralEvent,
  readMessageEventsPage,
  readGeneralEventsPage,
  purgeExpiredEvents
} = require('../database');

test.beforeEach(() => database.exec(`
  DELETE FROM message_events;
  DELETE FROM general_events;
  DELETE FROM message_snapshots;
`));

test.after(() => {
  if (database.open) database.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('schema initialization upgrades an existing database without removing command history', () => {
  const tableNames = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('message_snapshots', 'message_events', 'general_events')
    ORDER BY name
  `).pluck().all();

  assert.deepEqual(tableNames, ['general_events', 'message_events', 'message_snapshots']);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM command_events WHERE guild_id = ?')
    .get('legacy-guild').count, 1);
});

test('a message snapshot can be inserted, read, upserted, and marked deleted', () => {
  upsertMessageSnapshot({
    messageId: 'message-1', guildId: 'guild-1', channelId: 'channel-1', authorId: 'author-1',
    authorLabel: 'First label', content: 'first content', attachmentUrls: ['https://cdn.example/one'],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  });

  assert.deepEqual(readMessageSnapshot('message-1', 'guild-1'), {
    message_id: 'message-1', guild_id: 'guild-1', channel_id: 'channel-1', author_id: 'author-1',
    author_label: 'First label', content: 'first content', attachment_urls_json: '["https://cdn.example/one"]',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', deleted_at: null
  });

  upsertMessageSnapshot({
    messageId: 'message-1', guildId: 'guild-1', channelId: 'channel-2', authorId: 'author-1',
    authorLabel: 'Updated label', content: 'updated content', attachmentUrls: ['https://cdn.example/two'],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z'
  });
  markMessageSnapshotDeleted('message-1', 'guild-1', '2026-01-01T00:02:00.000Z');

  assert.deepEqual(readMessageSnapshot('message-1', 'guild-1'), {
    message_id: 'message-1', guild_id: 'guild-1', channel_id: 'channel-2', author_id: 'author-1',
    author_label: 'Updated label', content: 'updated content', attachment_urls_json: '["https://cdn.example/two"]',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:01:00.000Z',
    deleted_at: '2026-01-01T00:02:00.000Z'
  });
});

test('message snapshots are restricted to their guild', () => {
  upsertMessageSnapshot({
    messageId: 'shared-id', guildId: 'guild-1', channelId: 'channel-1', authorId: 'author-1',
    authorLabel: 'Author', content: 'private', attachmentUrls: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  });

  assert.equal(readMessageSnapshot('shared-id', 'guild-2'), undefined);
});

test('message events retain before and after content plus attachment URLs', () => {
  logMessageEvent({
    guildId: 'guild-1', channelId: 'channel-1', messageId: 'message-1', authorId: 'author-1',
    type: 'message_edit', beforeContent: 'before', afterContent: 'after',
    beforeAttachmentUrls: ['https://cdn.example/one'], afterAttachmentUrls: ['https://cdn.example/two'],
    timestamp: '2026-01-01T00:00:00.000Z'
  });
  logMessageEvent({
    guildId: 'guild-1', channelId: 'channel-1', messageId: 'message-1', authorId: 'author-1',
    type: 'message_delete', beforeContent: 'after', afterContent: null,
    beforeAttachmentUrls: ['https://cdn.example/two'], afterAttachmentUrls: null,
    timestamp: '2026-01-01T00:01:00.000Z'
  });

  const page = readMessageEventsPage('guild-1');
  assert.equal(page.total, 2);
  assert.deepEqual(page.events.map(event => ({
    event_type: event.event_type,
    before_content: event.before_content,
    after_content: event.after_content,
    before_attachment_urls_json: event.before_attachment_urls_json,
    after_attachment_urls_json: event.after_attachment_urls_json
  })), [
    {
      event_type: 'message_delete', before_content: 'after', after_content: null,
      before_attachment_urls_json: '["https://cdn.example/two"]', after_attachment_urls_json: null
    },
    {
      event_type: 'message_edit', before_content: 'before', after_content: 'after',
      before_attachment_urls_json: '["https://cdn.example/one"]',
      after_attachment_urls_json: '["https://cdn.example/two"]'
    }
  ]);
});

test('general events retain all supported member and voice event types', () => {
  const types = ['member_join', 'member_leave', 'voice_join', 'voice_leave'];
  for (const [index, type] of types.entries()) {
    logGeneralEvent({
      guildId: 'guild-1', userId: `user-${index}`, type, userLabel: `User ${index}`,
      channelId: type.startsWith('voice') ? `channel-${index}` : null,
      timestamp: `2026-01-01T00:0${index}:00.000Z`
    });
  }

  assert.deepEqual(readGeneralEventsPage('guild-1', 0, 10).events.map(event => event.event_type), [
    'voice_leave', 'voice_join', 'member_leave', 'member_join'
  ]);
});

test('activity page reads are guild isolated and hold a stable maximum ID', () => {
  for (let index = 0; index < 12; index += 1) {
    logMessageEvent({
      guildId: 'guild-1', channelId: 'channel-1', messageId: `message-${index}`, authorId: 'author-1',
      type: 'message_edit', beforeContent: String(index), afterContent: String(index + 1),
      beforeAttachmentUrls: [], afterAttachmentUrls: [], timestamp: `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z`
    });
  }
  logMessageEvent({
    guildId: 'guild-2', channelId: 'private-channel', messageId: 'private-message', authorId: 'private-author',
    type: 'message_edit', beforeContent: 'private', afterContent: 'private', beforeAttachmentUrls: [], afterAttachmentUrls: [],
    timestamp: '2026-01-01T01:00:00.000Z'
  });

  const firstPage = readMessageEventsPage('guild-1', 0, 10);
  logMessageEvent({
    guildId: 'guild-1', channelId: 'channel-1', messageId: 'new-message', authorId: 'author-1',
    type: 'message_edit', beforeContent: 'old', afterContent: 'new', beforeAttachmentUrls: [], afterAttachmentUrls: [],
    timestamp: '2026-01-01T02:00:00.000Z'
  });
  const secondPage = readMessageEventsPage('guild-1', 1, 10, firstPage.throughId);

  assert.equal(firstPage.total, 12);
  assert.equal(secondPage.total, 12);
  assert.equal(secondPage.events.length, 2);
  assert.deepEqual(secondPage.events.map(event => event.message_id), ['message-1', 'message-0']);
  assert.equal(firstPage.events.some(event => event.message_id === 'private-message'), false);
});

test('activity page bounds clamp and empty categories return one empty page', () => {
  logGeneralEvent({
    guildId: 'guild-1', userId: 'user-1', type: 'member_join', userLabel: 'User', channelId: null,
    timestamp: '2026-01-01T00:00:00.000Z'
  });

  assert.deepEqual(readGeneralEventsPage('empty-guild', 99, 10), {
    events: [], total: 0, page: 0, pageCount: 1, throughId: 0
  });
  const clamped = readGeneralEventsPage('guild-1', 99, 10);
  assert.equal(clamped.page, 0);
  assert.equal(clamped.pageCount, 1);
});

test('retention removes expired records from all sources with deterministic counts', () => {
  database.exec('DELETE FROM command_events');
  logCommandEvent({
    guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1', interactionType: 'prefix',
    commandName: 'old-command', success: true
  });
  database.prepare("UPDATE command_events SET occurred_at = '2025-01-01T00:00:00.000Z'").run();
  upsertMessageSnapshot({
    messageId: 'old-message', guildId: 'guild-1', channelId: 'channel-1', authorId: 'author-1',
    authorLabel: 'Author', content: 'old', attachmentUrls: [],
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z'
  });
  logMessageEvent({
    guildId: 'guild-1', channelId: 'channel-1', messageId: 'old-message', authorId: 'author-1',
    type: 'message_delete', beforeContent: 'old', afterContent: null, beforeAttachmentUrls: [], afterAttachmentUrls: null,
    timestamp: '2025-01-01T00:00:00.000Z'
  });
  logGeneralEvent({
    guildId: 'guild-1', userId: 'user-1', type: 'member_leave', userLabel: 'User', channelId: null,
    timestamp: '2025-01-01T00:00:00.000Z'
  });
  logGeneralEvent({
    guildId: 'guild-1', userId: 'user-2', type: 'member_join', userLabel: 'New User', channelId: null,
    timestamp: '2025-01-09T00:00:00.000Z'
  });

  assert.deepEqual(purgeExpiredEvents(7, new Date('2025-01-10T00:00:00.000Z')), {
    commandEvents: 1, messageEvents: 1, generalEvents: 1, messageSnapshots: 1
  });
  assert.throws(() => purgeExpiredEvents(0), /positive integer/i);
  assert.equal(readGeneralEventsPage('guild-1').total, 1);
});

test('retention deletes records older within the same millisecond-precision cutoff second', () => {
  logGeneralEvent({
    guildId: 'guild-1', userId: 'user-1', type: 'member_leave', userLabel: 'User', channelId: null,
    timestamp: '2025-01-02T00:00:00.250Z'
  });

  const result = purgeExpiredEvents(8, new Date('2025-01-10T00:00:00.500Z'));

  assert.equal(result.generalEvents, 1);
  assert.equal(readGeneralEventsPage('guild-1').total, 0);
});

const eventSources = [
  ['command_events', logCommandEvent, readCommandEventsPage, { guildId: 'stable-guild', userId: 'user', interactionType: 'prefix', commandName: 'links', success: true }],
  ['message_events', logMessageEvent, readMessageEventsPage, { guildId: 'stable-guild', channelId: 'channel', messageId: 'message', authorId: 'user', type: 'message_delete', beforeContent: 'content' }],
  ['general_events', logGeneralEvent, readGeneralEventsPage, { guildId: 'stable-guild', userId: 'user', type: 'member_join' }]
];

for (const [table, insert, readPage, event] of eventSources) {
  for (const purgeAll of [false, true]) {
    test(`${table} snapshot excludes new events after purging ${purgeAll ? 'all rows' : 'the highest ID'}`, () => {
      database.exec(`DELETE FROM ${table}`);
      insert(event);
      insert(event);
      const firstPage = readPage('stable-guild');
      database.prepare(`UPDATE ${table} SET occurred_at = '2020-01-01' ${purgeAll ? '' : 'WHERE id = ?'}`)
        .run(...(purgeAll ? [] : [firstPage.throughId]));
      purgeExpiredEvents(1, new Date('2021-01-01'));
      insert(event);
      const oldPage = readPage('stable-guild', 0, 10, firstPage.throughId);
      assert.equal(oldPage.total, purgeAll ? 0 : 1, 'old snapshot must never include a new record');
      assert.ok(readPage('stable-guild').throughId > firstPage.throughId, 'new IDs must exceed the purged maximum');
    });
  }
}

test('existing event tables migrate without row or constraint loss and retain ID history after reopening', () => {
  const legacyPath = path.join(temporaryDirectory, 'legacy-all-events.db');
  const legacy = new Database(legacyPath);
  legacy.pragma('foreign_keys = ON');
  for (const [table, insert, , event] of eventSources) {
    database.exec(`DELETE FROM ${table}`);
    insert(event);
    legacy.exec(database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql);
    const row = database.prepare(`SELECT * FROM ${table}`).get();
    row.id = 41;
    legacy.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(key => `@${key}`).join(',')})`).run(row);
  }
  legacy.exec('CREATE TABLE event_reference (event_id INTEGER REFERENCES general_events(id)); INSERT INTO event_reference VALUES (41); CREATE INDEX custom_general_user_idx ON general_events(user_id)');
  const reopen = code => execFileSync(process.execPath, ['-e', `const api = require(${JSON.stringify(require.resolve('../database'))}); ${code}; api.database.close();`], {
    env: { ...process.env, DATABASE_PATH: legacyPath }, encoding: 'utf8'
  });
  try {
    reopen('');
    for (const [table] of eventSources) assert.equal(legacy.prepare(`SELECT id FROM ${table}`).get().id, 41);
    assert.deepEqual(legacy.pragma('foreign_key_check'), []);
    assert.equal(legacy.pragma('foreign_keys', { simple: true }), 1);
    assert.throws(() => legacy.exec('DELETE FROM general_events'), /FOREIGN KEY/);
    assert.ok(legacy.prepare("SELECT name FROM sqlite_master WHERE name = 'custom_general_user_idx'").get());
    legacy.exec('DELETE FROM event_reference');
    reopen("api.purgeExpiredEvents(1, new Date('2100-01-01'))");
    reopen(eventSources.map(([, insert, , event]) => `api.${insert.name}(${JSON.stringify(event)})`).join(';'));
    for (const [table] of eventSources) assert.ok(legacy.prepare(`SELECT id FROM ${table}`).get().id > 41, `${table} must retain its high watermark after reopen`);
    assert.equal(legacy.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    legacy.close();
  }
});

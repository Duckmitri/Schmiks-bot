const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const databasePath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, 'data', 'schmiks.db');

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const database = new Database(databasePath);
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.exec(`
  CREATE TABLE IF NOT EXISTS command_events (
    id               INTEGER PRIMARY KEY,
    occurred_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    guild_id         TEXT NOT NULL,
    channel_id       TEXT,
    user_id          TEXT NOT NULL,
    interaction_type TEXT NOT NULL,
    command_name     TEXT NOT NULL,
    target_user_id   TEXT,
    success          INTEGER NOT NULL CHECK (success IN (0, 1)),
    duration_ms      INTEGER,
    error_code       TEXT,
    metadata_json    TEXT
  );

  CREATE INDEX IF NOT EXISTS command_events_occurred_at_idx
    ON command_events (occurred_at);
  CREATE INDEX IF NOT EXISTS command_events_guild_idx
    ON command_events (guild_id, occurred_at);
  CREATE INDEX IF NOT EXISTS command_events_user_idx
    ON command_events (user_id, occurred_at);
  CREATE INDEX IF NOT EXISTS command_events_command_idx
    ON command_events (command_name, occurred_at);

  CREATE TABLE IF NOT EXISTS message_snapshots (
    message_id           TEXT PRIMARY KEY,
    guild_id             TEXT NOT NULL,
    channel_id           TEXT NOT NULL,
    author_id            TEXT NOT NULL,
    author_label         TEXT,
    content              TEXT NOT NULL,
    attachment_urls_json TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    deleted_at           TEXT
  );

  CREATE INDEX IF NOT EXISTS message_snapshots_guild_updated_idx
    ON message_snapshots (guild_id, updated_at);
  CREATE INDEX IF NOT EXISTS message_snapshots_guild_message_idx
    ON message_snapshots (guild_id, message_id);

  CREATE TABLE IF NOT EXISTS message_events (
    id                          INTEGER PRIMARY KEY,
    occurred_at                 TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    guild_id                    TEXT NOT NULL,
    channel_id                  TEXT NOT NULL,
    message_id                  TEXT NOT NULL,
    author_id                   TEXT NOT NULL,
    event_type                  TEXT NOT NULL CHECK (event_type IN ('message_edit', 'message_delete')),
    before_content              TEXT NOT NULL,
    after_content               TEXT,
    before_attachment_urls_json TEXT NOT NULL,
    after_attachment_urls_json  TEXT
  );

  CREATE INDEX IF NOT EXISTS message_events_guild_occurred_idx
    ON message_events (guild_id, occurred_at, id);
  CREATE INDEX IF NOT EXISTS message_events_occurred_at_idx
    ON message_events (occurred_at);
  CREATE INDEX IF NOT EXISTS message_events_guild_message_idx
    ON message_events (guild_id, message_id);

  CREATE TABLE IF NOT EXISTS general_events (
    id           INTEGER PRIMARY KEY,
    occurred_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    guild_id     TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    user_label   TEXT,
    event_type   TEXT NOT NULL CHECK (event_type IN ('member_join', 'member_leave', 'voice_join', 'voice_leave')),
    channel_id   TEXT
  );

  CREATE INDEX IF NOT EXISTS general_events_guild_occurred_idx
    ON general_events (guild_id, occurred_at, id);
  CREATE INDEX IF NOT EXISTS general_events_occurred_at_idx
    ON general_events (occurred_at);
`);

// Keep ID history across retention without rebuilding existing tables and their constraints.
database.transaction(() => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS event_sequences (
      table_name TEXT PRIMARY KEY,
      last_id INTEGER NOT NULL
    );
  `);
  for (const table of ['command_events', 'message_events', 'general_events']) {
    database.exec(`
      INSERT INTO event_sequences (table_name, last_id)
      SELECT '${table}', COALESCE(MAX(id), 0) FROM ${table} WHERE true
      ON CONFLICT(table_name) DO UPDATE SET last_id = MAX(last_id, excluded.last_id);
    `);
  }
}).immediate();

const nextEventId = database.prepare(`
  UPDATE event_sequences SET last_id = last_id + 1
  WHERE table_name = ? RETURNING last_id AS id
`);

function prepareEventInsert(table, sql) {
  const insert = database.prepare(sql);
  return database.transaction(event => {
    const { id } = nextEventId.get(table);
    return insert.run({ ...event, id });
  });
}

const insertCommandEvent = prepareEventInsert('command_events', `
  INSERT INTO command_events (
    id, guild_id, channel_id, user_id, interaction_type, command_name,
    target_user_id, success, duration_ms, error_code, metadata_json
  ) VALUES (
    @id, @guildId, @channelId, @userId, @interactionType, @commandName,
    @targetUserId, @success, @durationMs, @errorCode, @metadataJson
  )
`);

function logCommandEvent(event) {
  insertCommandEvent({
    guildId: event.guildId,
    channelId: event.channelId ?? null,
    userId: event.userId,
    interactionType: event.interactionType,
    commandName: event.commandName,
    targetUserId: event.targetUserId ?? null,
    success: event.success ? 1 : 0,
    durationMs: event.durationMs ?? null,
    errorCode: event.errorCode ?? null,
    metadataJson: event.metadata ? JSON.stringify(event.metadata) : null
  });
}

function readCommandEventsPage(guildId, requestedPage = 0, pageSize = 10, requestedThroughId) {
  const throughId = requestedThroughId ?? database.prepare(`
    SELECT COALESCE(MAX(id), 0) AS id
    FROM command_events
    WHERE guild_id = ?
      AND interaction_type IN ('prefix', 'slash')
  `).get(guildId).id;
  const total = database.prepare(`
    SELECT COUNT(*) AS count
    FROM command_events
    WHERE guild_id = ?
      AND interaction_type IN ('prefix', 'slash')
      AND id <= ?
  `).get(guildId, throughId).count;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const events = database.prepare(`
    SELECT id, occurred_at, channel_id, user_id, interaction_type,
           command_name, success, duration_ms, error_code
    FROM command_events
    WHERE guild_id = ?
      AND interaction_type IN ('prefix', 'slash')
      AND id <= ?
    ORDER BY occurred_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(guildId, throughId, pageSize, page * pageSize);

  return { events, total, page, pageCount, throughId };
}

function toTimestamp(value) {
  if (value === undefined || value === null) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new TypeError('timestamp must be a valid date');
  return timestamp.toISOString();
}

function toJsonArray(value) {
  return JSON.stringify(value ?? []);
}

const upsertSnapshot = database.prepare(`
  INSERT INTO message_snapshots (
    message_id, guild_id, channel_id, author_id, author_label, content,
    attachment_urls_json, created_at, updated_at, deleted_at
  ) VALUES (
    @messageId, @guildId, @channelId, @authorId, @authorLabel, @content,
    @attachmentUrlsJson, @createdAt, @updatedAt, @deletedAt
  ) ON CONFLICT(message_id) DO UPDATE SET
    guild_id = excluded.guild_id,
    channel_id = excluded.channel_id,
    author_id = excluded.author_id,
    author_label = excluded.author_label,
    content = excluded.content,
    attachment_urls_json = excluded.attachment_urls_json,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    deleted_at = excluded.deleted_at
`);

function upsertMessageSnapshot(message) {
  upsertSnapshot.run({
    messageId: message.messageId,
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: message.authorId,
    authorLabel: message.authorLabel ?? null,
    content: message.content ?? '',
    attachmentUrlsJson: toJsonArray(message.attachmentUrls),
    createdAt: toTimestamp(message.createdAt),
    updatedAt: toTimestamp(message.updatedAt),
    deletedAt: message.deletedAt === undefined || message.deletedAt === null ? null : toTimestamp(message.deletedAt)
  });
}

const readSnapshot = database.prepare(`
  SELECT message_id, guild_id, channel_id, author_id, author_label, content,
         attachment_urls_json, created_at, updated_at, deleted_at
  FROM message_snapshots
  WHERE message_id = ? AND guild_id = ?
`);

function readMessageSnapshot(messageId, guildId) {
  return readSnapshot.get(messageId, guildId);
}

const markSnapshotDeleted = database.prepare(`
  UPDATE message_snapshots
  SET deleted_at = ?
  WHERE message_id = ? AND guild_id = ?
`);

function markMessageSnapshotDeleted(messageId, guildId, deletedAt) {
  markSnapshotDeleted.run(toTimestamp(deletedAt), messageId, guildId);
}

const insertMessageEvent = prepareEventInsert('message_events', `
  INSERT INTO message_events (
    id, occurred_at, guild_id, channel_id, message_id, author_id, event_type,
    before_content, after_content, before_attachment_urls_json, after_attachment_urls_json
  ) VALUES (
    @id, @occurredAt, @guildId, @channelId, @messageId, @authorId, @eventType,
    @beforeContent, @afterContent, @beforeAttachmentUrlsJson, @afterAttachmentUrlsJson
  )
`);

function logMessageEvent(event) {
  insertMessageEvent({
    occurredAt: toTimestamp(event.timestamp ?? event.occurredAt),
    guildId: event.guildId,
    channelId: event.channelId,
    messageId: event.messageId,
    authorId: event.authorId,
    eventType: event.type,
    beforeContent: event.beforeContent ?? '',
    afterContent: event.afterContent ?? null,
    beforeAttachmentUrlsJson: toJsonArray(event.beforeAttachmentUrls),
    afterAttachmentUrlsJson: event.afterAttachmentUrls === null ? null : toJsonArray(event.afterAttachmentUrls)
  });
}

const insertGeneralEvent = prepareEventInsert('general_events', `
  INSERT INTO general_events (
    id, occurred_at, guild_id, user_id, user_label, event_type, channel_id
  ) VALUES (
    @id, @occurredAt, @guildId, @userId, @userLabel, @eventType, @channelId
  )
`);

function logGeneralEvent(event) {
  insertGeneralEvent({
    occurredAt: toTimestamp(event.timestamp ?? event.occurredAt),
    guildId: event.guildId,
    userId: event.userId,
    userLabel: event.userLabel ?? event.label ?? null,
    eventType: event.type,
    channelId: event.channelId ?? null
  });
}

function readEventsPage(table, columns, guildId, requestedPage = 0, pageSize = 10, requestedThroughId) {
  const throughId = requestedThroughId ?? database.prepare(`
    SELECT COALESCE(MAX(id), 0) AS id
    FROM ${table}
    WHERE guild_id = ?
  `).get(guildId).id;
  const total = database.prepare(`
    SELECT COUNT(*) AS count
    FROM ${table}
    WHERE guild_id = ? AND id <= ?
  `).get(guildId, throughId).count;
  const normalizedPageSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 10;
  const pageCount = Math.max(1, Math.ceil(total / normalizedPageSize));
  const page = Math.min(Math.max(0, Number.isInteger(requestedPage) ? requestedPage : 0), pageCount - 1);
  const events = database.prepare(`
    SELECT ${columns}
    FROM ${table}
    WHERE guild_id = ? AND id <= ?
    ORDER BY occurred_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(guildId, throughId, normalizedPageSize, page * normalizedPageSize);

  return { events, total, page, pageCount, throughId };
}

function readMessageEventsPage(guildId, requestedPage = 0, pageSize = 10, requestedThroughId) {
  return readEventsPage(
    'message_events',
    'id, occurred_at, channel_id, message_id, author_id, event_type, before_content, after_content, before_attachment_urls_json, after_attachment_urls_json',
    guildId,
    requestedPage,
    pageSize,
    requestedThroughId
  );
}

function readGeneralEventsPage(guildId, requestedPage = 0, pageSize = 10, requestedThroughId) {
  return readEventsPage(
    'general_events',
    'id, occurred_at, user_id, user_label, event_type, channel_id',
    guildId,
    requestedPage,
    pageSize,
    requestedThroughId
  );
}

function purgeExpiredEvents(retentionDays, now = new Date()) {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new TypeError('retentionDays must be a positive integer');
  }

  const cutoff = new Date(new Date(toTimestamp(now)).getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const deleteOlderThan = column => database.prepare(`
    DELETE FROM ${column.table}
    WHERE julianday(${column.timestamp}) < julianday(?)
  `).run(cutoff).changes;

  return {
    commandEvents: deleteOlderThan({ table: 'command_events', timestamp: 'occurred_at' }),
    messageEvents: deleteOlderThan({ table: 'message_events', timestamp: 'occurred_at' }),
    generalEvents: deleteOlderThan({ table: 'general_events', timestamp: 'occurred_at' }),
    messageSnapshots: deleteOlderThan({ table: 'message_snapshots', timestamp: 'updated_at' })
  };
}

module.exports = {
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
};

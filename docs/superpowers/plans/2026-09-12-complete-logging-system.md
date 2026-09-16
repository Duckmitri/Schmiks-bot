# Complete Logging System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist message, member, and voice activity; browse it through the administrator logs command; and optionally deliver each event to one dashboard-configured Discord channel.

**Architecture:** Keep configuration parsing and validation in `config.js`, persistence in `database.js`, Discord event capture/delivery in a focused `event-logging.js` module, and log-view rendering/routing in `commands.js`. SQLite uses normalized snapshot/event tables and stable ID-bound pagination; dashboard changes are read dynamically so delivery and retention settings do not require a restart.

**Tech Stack:** Node.js 24+, CommonJS, discord.js 14.27, better-sqlite3 13, Express 5, Node's built-in test runner.

**Spec:** `docs/superpowers/specs/2026-09-12-complete-logging-system-design.md`

## Global Constraints

- All stored and displayed data must be restricted to the event's Discord guild.
- Store non-bot message text and attachment URLs for the configured retention period; never download attachments.
- Live-delivery toggles do not disable database recording.
- Use one shared channel ID and seven independent delivery toggles.
- Retention defaults to 90 days and validates whole numbers from 1 through 3650.
- Live delivery and event-handler failures must not crash the bot or roll back stored records.
- Rich embeds must respect Discord field, description, component, and total embed limits.
- Preserve all unrelated keys whenever dashboard configuration is written.

---

### Task 1: Logging Configuration and Dashboard

**Files:**
- Modify: `config.js`
- Modify: `dashboard/server.js`
- Modify: `dashboard/public/index.html`
- Modify: `dashboard/public/script.js`
- Modify: `dashboard/public/style.css`
- Modify: `config/config.json.example`
- Test: `test/config-and-dashboard.test.js`

**Interfaces:**
- Produces: `readLoggingConfig(): { channelId: string, retentionDays: number, delivery: Record<string, boolean> }`
- Produces: `validateLoggingConfig(value): LoggingConfig`
- Produces: `writeDashboardConfig({ prefix, logging }): { prefix: string, logging: LoggingConfig }`
- Consumes: existing `validatePrefix`, config path selection, Express `/api/config` endpoints.

- [ ] **Step 1: Write failing configuration tests**

Add tests asserting default settings, valid round trips, rejection of malformed channel IDs and retention values, rejection of enabled delivery without a channel, and preservation of roles/links/slash commands when saving.

```js
assert.deepEqual(readLoggingConfig(), {
  channelId: '', retentionDays: 90,
  delivery: {
    commandExecution: false, messageEdit: false, messageDelete: false,
    memberJoin: false, memberLeave: false, voiceJoin: false, voiceLeave: false
  }
});
assert.throws(() => validateLoggingConfig({
  channelId: '', retentionDays: 90,
  delivery: { messageDelete: true }
}), /channel ID/i);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/config-and-dashboard.test.js`
Expected: FAIL because the logging configuration exports and dashboard fields do not exist.

- [ ] **Step 3: Implement merged configuration reads/writes**

Create a frozen list of delivery keys, normalize missing booleans to false, validate a blank or 17-20 digit channel ID, validate integer retention, and replace the prefix-only destructive write with a read/merge/write helper. Export the three interfaces above without changing `BOT_PREFIX` read precedence.

- [ ] **Step 4: Implement the dashboard form and API payload**

Return `{ prefix, logging }` from GET, accept both values in POST, render the channel/retention inputs and seven labeled checkboxes, and serialize/restore them in `script.js`. Style grouped settings and checkboxes without adding dependencies.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test test/config-and-dashboard.test.js`
Expected: PASS.

Run: `npm test`
Expected: all tests PASS.

---

### Task 2: SQLite Event Storage, Pagination, and Retention

**Files:**
- Modify: `database.js`
- Create: `test/activity-database.test.js`

**Interfaces:**
- Produces: `upsertMessageSnapshot(message): void`
- Produces: `readMessageSnapshot(messageId, guildId): object | undefined`
- Produces: `logMessageEvent(event): void`
- Produces: `logGeneralEvent(event): void`
- Produces: `readMessageEventsPage(guildId, page?, pageSize?, throughId?): Page`
- Produces: `readGeneralEventsPage(guildId, page?, pageSize?, throughId?): Page`
- Produces: `purgeExpiredEvents(retentionDays, now?): { commandEvents, messageEvents, generalEvents, messageSnapshots }`
- Consumes: existing database connection and stable command pagination pattern.

- [ ] **Step 1: Write failing storage tests**

Cover snapshot insert/update/deletion state, edit/delete payloads and attachment JSON, all four general event types, newest-first guild-isolated pages, stable `throughId`, and deterministic retention counts.

```js
upsertMessageSnapshot({
  messageId: 'm1', guildId: 'g1', channelId: 'c1', authorId: 'u1',
  authorLabel: 'User', content: 'before', attachmentUrls: ['https://cdn.example/a.png'],
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z'
});
assert.equal(readMessageSnapshot('m1', 'g1').content, 'before');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/activity-database.test.js`
Expected: FAIL because the new tables and functions do not exist.

- [ ] **Step 3: Add additive schema and prepared statements**

Create `message_snapshots`, `message_events`, and `general_events` with constraints and indexes from the spec. Implement snapshot upsert/read, deletion timestamp update, event inserts, and JSON array serialization with empty arrays as `[]`.

- [ ] **Step 4: Implement shared stable pagination and retention**

Reuse one internal page calculation for message/general tables: capture the guild's maximum ID, count rows at or below it, clamp pages, and sort by `occurred_at DESC, id DESC`. Purge each table with an ISO cutoff computed from the supplied `now` and return SQLite `changes` counts.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test test/activity-database.test.js`
Expected: PASS.

Run: `npm test`
Expected: all tests PASS.

---

### Task 3: Discord Event Capture and Optional Delivery

**Files:**
- Create: `event-logging.js`
- Modify: `bot.js`
- Modify: `commands.js`
- Create: `test/event-logging.test.js`

**Interfaces:**
- Produces: `snapshotMessage(message): Promise<void>`
- Produces: `handleMessageUpdate(oldMessage, newMessage): Promise<void>`
- Produces: `handleMessageDelete(message): Promise<void>`
- Produces: `handleMemberJoin(member): Promise<void>` and `handleMemberLeave(member): Promise<void>`
- Produces: `handleVoiceStateUpdate(oldState, newState): Promise<void>`
- Produces: `deliverLogEvent(guild, eventType, event): Promise<boolean>`
- Produces: `startRetentionScheduler(): NodeJS.Timeout`
- Consumes: Task 1 logging configuration and Task 2 persistence functions.

- [ ] **Step 1: Write failing event and delivery tests**

Test that bot/DM messages are ignored, normal messages snapshot, edits only record actual content/attachment changes, deletion uses SQLite fallback, partial updates fetch when possible, joins/leaves record, voice moves create leave then join, each switch gates delivery, and delivery failures resolve false without rejecting.

```js
await handleVoiceStateUpdate(
  { guild, id: 'u1', channelId: 'old' },
  { guild, id: 'u1', channelId: 'new' }
);
assert.deepEqual(readGeneralEventsPage('g1').events.map(e => e.event_type),
  ['voice_join', 'voice_leave']);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/event-logging.test.js`
Expected: FAIL because `event-logging.js` does not exist.

- [ ] **Step 3: Implement event normalization and persistence-first handlers**

Extract IDs, labels, content, timestamps, and attachment URLs defensively from discord.js objects. Store before attempting delivery. Use snapshots before cached payloads for deletes/edits. Record voice channel moves as two ordered events and ignore unchanged states.

- [ ] **Step 4: Implement live embed delivery and command hook**

Map database event types to dashboard keys, load settings on each delivery, resolve the shared guild channel by cache then fetch, require `isTextBased()` and `send`, and truncate fields. Extend `auditInteraction` to invoke delivery after `logCommandEvent` while retaining its non-throwing behavior.

- [ ] **Step 5: Wire bot intents, partials, listeners, and cleanup**

Add `GatewayIntentBits.GuildVoiceStates` and `Partials.Message`. Register message create/update/delete, member add/remove, and voice-state listeners with a shared safe wrapper. Start an immediate purge and an unref'd 24-hour interval after readiness.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test test/event-logging.test.js`
Expected: PASS.

Run: `npm test`
Expected: all tests PASS.

---

### Task 4: Message and General Log Views

**Files:**
- Modify: `commands.js`
- Modify: `test/logs-command.test.js`
- Modify: `test/logs-button-error.test.js`

**Interfaces:**
- Produces: `buildMessageLogsView(guildId, page?, throughId?): DiscordReplyOptions`
- Produces: `buildGeneralLogsView(guildId, page?, throughId?): DiscordReplyOptions`
- Produces: category-neutral parsing of `logs:(commands|messages|general):<page>:<throughId>`.
- Consumes: Task 2 page readers and existing administrator command/button checks.

- [ ] **Step 1: Replace placeholder expectations with failing view tests**

Assert both slash/prefix category views, event-specific labels and mentions, before/after message excerpts, attachment links, empty states, stable next-page IDs, guild isolation, administrator rechecks, and descriptions no longer than 4096 characters.

```js
await handlePrefixCommand(message('!logs messages'), '!');
const data = replies[0].embeds[0].toJSON();
assert.equal(data.title, 'Message Logs');
assert.match(data.description, /Deleted/);
assert.ok(data.description.length <= 4096);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/logs-command.test.js test/logs-button-error.test.js`
Expected: FAIL because general/messages still use placeholder embeds.

- [ ] **Step 3: Implement bounded event formatting**

Create category formatters that escape Markdown, safely parse attachment arrays, cap event excerpts, stop adding entries before the description limit, and always produce the correct footer/count. Use at most ten queried events per page.

- [ ] **Step 4: Generalize command and button routing**

Select the appropriate view builder for all three choices. Parse all category custom IDs, preserve public page updates, re-check administrator roles, and return category-specific load errors ephemerally.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test test/logs-command.test.js test/logs-button-error.test.js`
Expected: PASS.

Run: `npm test`
Expected: all tests PASS.

---

### Task 5: Documentation and Final Verification

**Files:**
- Modify: `README.md`
- Modify: `HANDOFF.md`
- Modify: `package.json` only if the new module needs an explicit syntax check
- Test: all files in `test/`

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: operator instructions describing privacy, retention, dashboard setup, required Discord intents/permissions, live delivery switches, and all logs command categories.

- [ ] **Step 1: Update operator documentation**

Document the `logging` config shape, dashboard channel-ID workflow, 90-day default, per-event delivery behavior, message-content storage, attachment URL lifetime caveat, bot-offline limitation, required `Guild Members`, `Message Content`, and voice intents, and permissions to view/send embeds in the target channel.

- [ ] **Step 2: Extend syntax verification if needed**

If `event-logging.js` is not reached by an existing syntax check, add `node --check event-logging.js` to `npm run check`.

- [ ] **Step 3: Run the complete verification gate**

Run: `npm run check`
Expected: every syntax check exits zero and every Node test passes with zero failures.

- [ ] **Step 4: Inspect generated workspace state**

Run: `git status --short` when Git metadata exists; otherwise list changed project files and confirm no runtime database or credential file is intended for delivery.


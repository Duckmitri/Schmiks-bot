# Infractions System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent warn/kick infractions, public moderator-only infraction history, and dashboard-controlled warning embeds.

**Architecture:** Extend the existing `better-sqlite3` database with one durable `infractions` table and focused insert/page readers. Reuse `commands.js` routing, authorization, embed pagination, and shared kick execution; extend the existing dashboard config object with `warningEmbed` and reuse its native color popover.

**Tech Stack:** Node.js 24+, CommonJS, discord.js 14, better-sqlite3, Express 5, native `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-14-infractions-design.md`

## Global Constraints

- No new dependency.
- `warn` and `infractions` are moderator commands; configured administrator roles inherit access.
- Warning and infraction command responses are public except permission, validation, or execution errors that already use ephemeral slash replies.
- Warning templates support exactly `{server}`, `{reason}`, and `{moderator}`.
- Successful kicks and issued warnings persist; failed kick attempts do not.
- Infraction rows are not affected by event-log retention cleanup.
- Preserve the existing macOS Settings-inspired grouped, responsive dashboard design.
- `npm run check` is source verification, not proof of live Discord behavior.

---

### Task 1: Persistent infraction storage

**Files:**
- Create: `test/infractions-database.test.js`
- Modify: `database.js`

**Interfaces:**
- Produces: `logInfraction({ guildId, targetUserId, moderatorUserId, type, reason, occurredAt? })`.
- Produces: `readInfractionsPage(guildId, targetUserId, requestedPage = 0, pageSize = 10, requestedThroughId)` returning `{ infractions, total, page, pageCount, throughId }`.

- [ ] **Step 1: Write the failing database test**

Create a temporary `DATABASE_PATH`, load `database.js`, insert warn/kick rows for multiple guilds and targets, and assert guild/target filtering, newest-first pagination, and persistence fields:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schmiks-infractions-'));
process.env.DATABASE_PATH = path.join(directory, 'test.db');
const { database, logInfraction, readInfractionsPage, purgeExpiredEvents } = require('../database');

test.after(() => {
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('stores and pages infractions by guild and target without retention deletion', () => {
  logInfraction({ guildId: 'guild-a', targetUserId: 'target-a', moderatorUserId: 'mod-a', type: 'warn', reason: 'first', occurredAt: '2026-09-12T00:00:00.000Z' });
  logInfraction({ guildId: 'guild-a', targetUserId: 'target-a', moderatorUserId: 'mod-b', type: 'kick', reason: 'second', occurredAt: '2026-09-13T00:00:00.000Z' });
  logInfraction({ guildId: 'guild-b', targetUserId: 'target-a', moderatorUserId: 'mod-c', type: 'warn', reason: 'other guild' });
  logInfraction({ guildId: 'guild-a', targetUserId: 'target-b', moderatorUserId: 'mod-c', type: 'warn', reason: 'other target' });

  const firstPage = readInfractionsPage('guild-a', 'target-a', 0, 1);
  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.pageCount, 2);
  assert.equal(firstPage.infractions[0].type, 'kick');
  assert.equal(firstPage.infractions[0].reason, 'second');
  assert.equal(firstPage.infractions[0].moderator_user_id, 'mod-b');

  const secondPage = readInfractionsPage('guild-a', 'target-a', 1, 1, firstPage.throughId);
  assert.equal(secondPage.infractions[0].type, 'warn');
  purgeExpiredEvents(1, new Date('2030-01-01T00:00:00.000Z'));
  assert.equal(readInfractionsPage('guild-a', 'target-a').total, 2);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test test/infractions-database.test.js`

Expected: FAIL because `logInfraction` and `readInfractionsPage` are not exported.

- [ ] **Step 3: Add the table and minimal readers**

In `database.js`, add an auto-incrementing durable table independent of `event_sequences`:

```sql
CREATE TABLE IF NOT EXISTS infractions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  guild_id          TEXT NOT NULL,
  target_user_id    TEXT NOT NULL,
  moderator_user_id TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('warn', 'kick')),
  reason            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS infractions_guild_target_idx
  ON infractions (guild_id, target_user_id, occurred_at, id);
```

Implement `logInfraction` with a prepared insert, `toTimestamp`, strict type validation, and a nonblank reason capped at 512 characters. Implement `readInfractionsPage` with the same page normalization and stable `throughId` pattern as `readEventsPage`, scoped by both `guild_id` and `target_user_id`. Export both functions. Do not add `infractions` to `purgeExpiredEvents`.

- [ ] **Step 4: Run the focused test**

Run: `node --test test/infractions-database.test.js`

Expected: PASS.

- [ ] **Step 5: Commit storage**

```bash
git add database.js test/infractions-database.test.js
git commit -m "feat: store moderation infractions"
```

### Task 2: Warning embed configuration and dashboard section

**Files:**
- Create: `test/warning-config-dashboard.test.js`
- Modify: `config.js`
- Modify: `dashboard/server.js`
- Modify: `dashboard/public/index.html`
- Modify: `dashboard/public/script.js`
- Modify: `config/config.json.example`

**Interfaces:**
- Produces: `readWarningEmbedConfig()` returning `{ color, title, message }`.
- Produces: `validateWarningEmbedConfig(value)` with defaults `#FEE75C`, `Warning from {server}`, and `{reason}\n\nModerator: {moderator}`.
- Changes: `writeDashboardConfig` consumes and returns `warningEmbed` while preserving unrelated config.

- [ ] **Step 1: Write failing config/API tests**

Use a temporary `CONFIG_PATH`, clear the require cache before loading `config.js` and `dashboard/server.js`, and assert defaults, normalization, rejection, and API round-tripping:

```js
test('validates and persists warning embed settings', async () => {
  assert.deepEqual(readWarningEmbedConfig(), {
    color: '#FEE75C',
    title: 'Warning from {server}',
    message: '{reason}\n\nModerator: {moderator}'
  });
  assert.throws(() => validateWarningEmbedConfig({ color: 'yellow', title: 'Warn', message: '{reason}' }), /#RRGGBB/);
  assert.throws(() => validateWarningEmbedConfig({ color: '#FEE75C', title: ' ', message: '{reason}' }), /title/);

  const saved = writeDashboardConfig({
    prefix: '!', moderatorRoleIds: [], adminRoleIds: [],
    logging: readLoggingConfig(),
    warningEmbed: { color: '#ffcc00', title: '{server} warning', message: '{reason} — {moderator}' }
  });
  assert.deepEqual(saved.warningEmbed, {
    color: '#FFCC00', title: '{server} warning', message: '{reason} — {moderator}'
  });
});
```

Start the exported Express app on an ephemeral port and use native `fetch` to verify `GET /api/config` includes `warningEmbed` and `POST /api/config` accepts and returns it. Read `dashboard/public/index.html` and assert it contains `href="#infractions"`, `id="infractions"`, `warningColor`, `warningTitle`, and `warningMessage`.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test test/warning-config-dashboard.test.js`

Expected: FAIL because warning embed configuration and dashboard fields do not exist.

- [ ] **Step 3: Implement config validation and persistence**

Add `defaultWarningEmbed`, `validateWarningEmbedConfig`, and `readWarningEmbedConfig` in `config.js`. Require `#RRGGBB`; trim and require nonblank title/message strings; cap stored title at 256 characters and message at 4096 characters. Add `warningEmbed` to both the saved and persisted objects in `writeDashboardConfig`. Export the two new functions.

- [ ] **Step 4: Wire the dashboard API**

Update `dashboard/server.js` so GET returns `warningEmbed: readWarningEmbedConfig()` and POST passes `warningEmbed` through the existing `writeDashboardConfig(req.body)` call.

- [ ] **Step 5: Add the Apple-style Infractions section**

In `dashboard/public/index.html`, add an `Infractions` sidebar link and a section using existing `.settings-section`, `.settings-group`, `.setting-row`, and `.stacked` classes. Include:

```html
<a href="#infractions"><span class="nav-icon infractions-icon" aria-hidden="true">!</span>Infractions</a>

<section id="infractions" class="settings-section">
  <div class="section-heading"><h2>Infractions</h2><p>Customize warning messages sent to members.</p></div>
  <div class="settings-group">
    <div class="setting-row"><span><strong>Warning color</strong><small>Embed accent color</small></span><button class="color-control" type="button" data-color-trigger="warning"><span class="color-swatch"></span><output data-color-value="warning">#FEE75C</output></button><input id="warningColor" type="hidden" data-color-key="warning" value="#FEE75C"></div>
    <label class="setting-row stacked" for="warningTitle"><span><strong>Title template</strong><small>Supports {server}, {reason}, and {moderator}</small></span><input id="warningTitle" maxlength="256" required></label>
    <label class="setting-row stacked" for="warningMessage"><span><strong>Message template</strong><small>Supports {server}, {reason}, and {moderator}</small></span><textarea id="warningMessage" rows="5" maxlength="4096" required></textarea></label>
  </div>
</section>
```

Add only the small `.infractions-icon` color rule needed to distinguish the sidebar icon; reuse all other styles.

- [ ] **Step 6: Wire form load/save and reuse the color picker**

In `dashboard/public/script.js`, include `warning` in the existing color-control initialization without adding a second picker. Build:

```js
function getWarningEmbedFormValue() {
  return {
    color: document.getElementById('warningColor').value.toUpperCase(),
    title: document.getElementById('warningTitle').value,
    message: document.getElementById('warningMessage').value
  };
}
```

Send `warningEmbed: getWarningEmbedFormValue()` in the POST body. On load, populate the title/message, set the hidden warning color, and call `syncColorValue('warning')`.

- [ ] **Step 7: Update example config and run tests**

Add:

```json
"warningEmbed": {
  "color": "#FEE75C",
  "title": "Warning from {server}",
  "message": "{reason}\n\nModerator: {moderator}"
}
```

Run: `node --test test/warning-config-dashboard.test.js`

Expected: PASS.

- [ ] **Step 8: Commit configuration and dashboard**

```bash
git add config.js dashboard/server.js dashboard/public/index.html dashboard/public/script.js dashboard/public/style.css config/config.json.example test/warning-config-dashboard.test.js
git commit -m "feat: configure warning embeds"
```

### Task 3: Warn command and template rendering

**Files:**
- Create: `test/warn-command.test.js`
- Modify: `commands.js`
- Modify: `config.js`

**Interfaces:**
- Consumes: `readWarningEmbedConfig()` and `logInfraction(...)`.
- Produces: `renderWarningTemplate(template, { server, reason, moderator })`.
- Produces: `executeWarn({ guild, target, moderator, reason })` returning `{ success: true, dmDelivered: boolean }` or throwing on persistence failure.

- [ ] **Step 1: Write failing warning tests**

Assert global replacement, unknown-placeholder preservation, persistence-before-DM behavior, and DM failure behavior:

```js
test('renders supported placeholders without changing unknown placeholders', () => {
  assert.equal(
    renderWarningTemplate('{server}: {reason} / {reason} by {moderator} {unknown}', {
      server: 'Guild', reason: 'Spam', moderator: 'Mod'
    }),
    'Guild: Spam / Spam by Mod {unknown}'
  );
});

test('records a warning when its DM fails', async () => {
  const target = { id: 'target', send: async () => { throw new Error('DM closed'); } };
  const result = await executeWarn({
    guild: { id: 'guild', name: 'Guild' },
    target,
    moderator: { id: 'mod', tag: 'Moderator' },
    reason: 'Spam'
  });
  assert.deepEqual(result, { success: true, dmDelivered: false });
  assert.equal(readInfractionsPage('guild', 'target').infractions[0].type, 'warn');
});
```

Also inspect `readSlashCommands()` and assert `warn` has required user `target` and string `reason` options.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test test/warn-command.test.js`

Expected: FAIL because warn helpers and slash options do not exist.

- [ ] **Step 3: Implement template rendering and warning execution**

Import `readWarningEmbedConfig`, `logInfraction`, and `readInfractionsPage`. Replace supported placeholders with `String.prototype.replaceAll`. Bound substituted title to 256 and description to 4096 characters before passing them to `EmbedBuilder`. In `executeWarn`, validate target/reason, write the infraction first, then attempt the DM and return its delivery status.

- [ ] **Step 4: Route prefix and slash warn commands**

Add `warn` to `moderatorCommands`. Add a handler following the kick target/reason parsing path. Prefix usage is `<prefix>warn @member <reason>`; slash options are `target` and `reason`. Public success text is `The member was warned.` or `The warning was recorded, but their DM notification failed.`

- [ ] **Step 5: Register the slash command**

In `addBuiltInSlashCommands`, build `warn` with required user `target` and required string `reason`; filter configured duplicates before appending it.

- [ ] **Step 6: Run the focused tests**

Run: `node --test test/warn-command.test.js test/infractions-database.test.js`

Expected: PASS.

- [ ] **Step 7: Commit warn command**

```bash
git add commands.js config.js test/warn-command.test.js
git commit -m "feat: add persistent warn command"
```

### Task 4: Record successful direct and reaction kicks

**Files:**
- Create: `test/kick-infractions.test.js`
- Modify: `commands.js`

**Interfaces:**
- Changes: `executeKick({ guild, target, moderator, reason })` records one kick after `target.kick()` succeeds.
- Consumes: `logInfraction(...)`.

- [ ] **Step 1: Write failing kick persistence tests**

Use temporary database/config paths and fake Discord members:

```js
test('records only a successful kick', async () => {
  const target = { id: 'target', kickable: true, send: async () => {}, kick: async () => {} };
  await executeKick({
    guild: { id: 'guild', name: 'Guild' }, target,
    moderator: { id: 'mod' }, reason: 'Spam'
  });
  assert.equal(readInfractionsPage('guild', 'target').infractions[0].type, 'kick');
});

test('does not record a failed kick', async () => {
  const target = { id: 'failed-target', kickable: true, send: async () => {}, kick: async () => { throw new Error('forbidden'); } };
  await assert.rejects(executeKick({ guild: { id: 'guild', name: 'Guild' }, target, moderator: { id: 'mod' }, reason: 'Spam' }));
  assert.equal(readInfractionsPage('guild', 'failed-target').total, 0);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test test/kick-infractions.test.js`

Expected: FAIL because kick does not persist infractions.

- [ ] **Step 3: Persist in the shared kick executor**

Accept `moderator`, call `target.kick(boundedReason)`, then call `logInfraction` with guild, target, moderator, type `kick`, and the same bounded reason. Update direct kick to pass `messageOrInteraction.user ?? messageOrInteraction.author`; update reaction kick to pass `reactor.user`. Keep DM failure nonfatal.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/kick-infractions.test.js test/infractions-database.test.js`

Expected: PASS.

- [ ] **Step 5: Commit kick integration**

```bash
git add commands.js test/kick-infractions.test.js
git commit -m "feat: record successful kicks"
```

### Task 5: Public infraction history and pagination

**Files:**
- Create: `test/infractions-command.test.js`
- Modify: `commands.js`
- Modify: `config.js`

**Interfaces:**
- Consumes: `readInfractionsPage(...)`.
- Produces: `buildInfractionsView(guildId, target, requestedPage = 0, requestedThroughId)` returning `{ embeds, components }`.
- Adds button IDs: `infractions:<targetUserId>:<page>:<throughId>`.

- [ ] **Step 1: Write failing view and registration tests**

Insert twelve rows and assert a ten-item first page, stable snapshot buttons, public payload, escaped reasons, and empty history. Assert `readSlashCommands()` has an `infractions` command with required user `target`.

```js
const view = buildInfractionsView('guild', { id: 'target', user: { tag: 'Target' } });
assert.equal(view.embeds[0].data.title, 'Infractions for Target');
assert.match(view.embeds[0].data.footer.text, /Page 1 of 2/);
assert.match(view.components[0].components[1].data.custom_id, /^infractions:target:1:\d+$/);
assert.equal('ephemeral' in view, false);
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test test/infractions-command.test.js`

Expected: FAIL because the view and slash definition do not exist.

- [ ] **Step 3: Build the public view**

Create `buildInfractionsView` using `readInfractionsPage`, `EmbedBuilder`, existing markdown escaping, `discordTimestamp`, and two buttons. Show type, bounded reason, `<@moderator_id>`, and timestamp for each row. Use `No infractions have been recorded for this member.` for empty history.

- [ ] **Step 4: Route the command**

Add `infractions` to `moderatorCommands`. Parse the prefix mention or slash target, reject a missing target with `Usage: <command> @member`, and reply with `buildInfractionsView(...)` without `ephemeral`.

- [ ] **Step 5: Route and authorize pagination buttons**

At the start of `handleButtonInteraction`, match `^infractions:(\d{17,20}):(\d+):(\d+)$`. Re-read moderator and administrator role IDs, require either role set, fetch the target member when available (otherwise use `{ id, user: { tag: id } }`), and call `interaction.update(buildInfractionsView(...))`. Permission and execution errors use ephemeral replies.

- [ ] **Step 6: Register slash command**

Add a built-in `infractions` command with required user `target`, filtering configured duplicates before appending it.

- [ ] **Step 7: Run focused tests**

Run: `node --test test/infractions-command.test.js test/infractions-database.test.js`

Expected: PASS.

- [ ] **Step 8: Commit history command**

```bash
git add commands.js config.js test/infractions-command.test.js
git commit -m "feat: show member infractions"
```

### Task 6: Documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Documents: command syntax, public visibility, persistence rules, warning template placeholders, dashboard fields, and manual Discord checks.

- [ ] **Step 1: Update documentation**

Document prefix/slash `warn` and `infractions`, moderator authorization, successful kick recording, warning DM failure behavior, permanent infraction retention, and `{server}`, `{reason}`, `{moderator}` substitutions. Add the new database table to the operational handoff and state that `npm run check` does not verify live Discord registration or DM delivery.

- [ ] **Step 2: Run syntax and all tests**

Run: `npm run check`

Expected: all `node --check` commands succeed and all `node:test` tests pass with zero failures.

- [ ] **Step 3: Inspect the focused diff**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; only intended implementation, tests, and documentation remain.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md HANDOFF.md
git commit -m "docs: document infraction system"
```

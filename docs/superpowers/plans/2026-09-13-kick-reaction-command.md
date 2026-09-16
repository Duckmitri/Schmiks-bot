# Kick Reaction Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add moderator-only kick execution through prefix, slash, and configurable message-reaction invocation.

**Architecture:** Keep one `executeKick` function in `commands.js`; the three input routes only resolve target and reason before calling it. Store the reaction-to-command mapping in existing JSON configuration, and route Discord's native `messageReactionAdd` event directly to one command handler.

**Tech Stack:** Node.js 24, CommonJS, discord.js 14, Node test runner, existing SQLite command auditing

**Spec:** `docs/superpowers/specs/2026-09-13-kick-reaction-command-design.md`

## Global Constraints

- Prefix syntax is `!kick @target reason`.
- Slash syntax is `/kick target reason`, with both options required.
- The initial reaction mapping is Unicode `🥾` to `kick` and must remain configurable.
- An empty reacted-message body uses `You have been kicked from the server, no reason provided`.
- DM failure does not block kicking.
- No new dependency is permitted.

---

### Task 1: Configuration and slash definition

**Files:**
- Modify: `config.js`
- Modify: `config/config.json`
- Modify: `config/config.json.example`
- Test: `test/config-and-dashboard.test.js`

**Interfaces:**
- Produces: `readReactionCommands(): Record<string, string>`
- Produces: a `/kick` command with required Discord user option `target` and required string option `reason`

- [ ] **Step 1: Write failing configuration tests**

Add tests that write this fixture to `process.env.CONFIG_PATH`:

```js
{
  reactionCommands: { '🥾': 'kick', '': 'kick', '❌': '' },
  slashCommands: [{ name: 'links', description: 'Show useful server links' }]
}
```

Assert `readReactionCommands()` equals `{ '🥾': 'kick' }`. Assert the command returned by `readSlashCommands()` for `kick` has required `target`/user and `reason`/string options.

- [ ] **Step 2: Verify the tests fail**

Run:

```powershell
node --test --test-name-pattern="reaction command config|kick slash definition"
```

Expected: failure because `readReactionCommands` and the built-in kick definition do not exist.

- [ ] **Step 3: Implement the reader and built-in slash command**

Add a reader based on the existing `readConfig()`:

```js
function readReactionCommands() {
  const source = readConfig().reactionCommands;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  return Object.fromEntries(Object.entries(source).filter(([emoji, command]) =>
    emoji.trim() && typeof command === 'string' && command.trim()
  ));
}
```

Add a `SlashCommandBuilder` for `kick`, filter configured `kick` definitions before appending it alongside `logs`, and export `readReactionCommands`.

Update both JSON files with:

```json
"reactionCommands": {
  "🥾": "kick"
}
```

- [ ] **Step 4: Verify configuration tests pass**

Run the command from Step 2. Expected: both tests pass.

- [ ] **Step 5: Commit**

```powershell
git add config.js config/config.json.example test/config-and-dashboard.test.js
git commit -m "feat: configure kick command reactions"
```

`config/config.json` is intentionally ignored and remains a local configuration update.

---

### Task 2: Shared kick executor and direct commands

**Files:**
- Modify: `commands.js`
- Create: `test/kick-command.test.js`

**Interfaces:**
- Produces: `executeKick({ guild, target, reason }): Promise<{ success: boolean, errorCode?: string, dmDelivered?: boolean }>`
- Consumes: prefix mention plus remaining arguments; slash `target` and `reason` options

- [ ] **Step 1: Write failing command tests**

Use small guild-member fakes with `send`, `kick`, and `kickable`. Assert:

1. `/kick` resolves `options.getMember('target')` and `options.getString('reason', true)`.
2. `!kick @target repeated spam` resolves the first mentioned member and preserves `repeated spam` as one reason.
3. The target receives a red embed before `kick(reason)` runs.
4. Rejected `send()` still calls `kick(reason)` and the moderator response mentions DM failure.
5. `kickable: false` never calls either method and returns `TARGET_NOT_KICKABLE`.

- [ ] **Step 2: Verify command tests fail**

Run:

```powershell
node --test test/kick-command.test.js
```

Expected: failure because `kick` is not registered or implemented.

- [ ] **Step 3: Implement the minimum shared executor**

Add `'kick'` to `moderatorCommands`. Build one red embed and attempt delivery before the native kick:

```js
async function executeKick({ guild, target, reason }) {
  if (!target?.kickable) return { success: false, errorCode: 'TARGET_NOT_KICKABLE' };
  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle(`You have been kicked from ${guild.name}`)
    .setDescription(reason);
  let dmDelivered = true;
  try { await target.send({ embeds: [embed] }); } catch { dmDelivered = false; }
  await target.kick(reason);
  return { success: true, dmDelivered };
}
```

The command handler validates required prefix/slash inputs, calls `executeKick`, replies with the outcome, and returns the existing `{ success, errorCode }` audit result shape.

- [ ] **Step 4: Verify kick command tests pass**

Run the command from Step 2. Expected: all kick tests pass.

- [ ] **Step 5: Commit**

```powershell
git add commands.js test/kick-command.test.js
git commit -m "feat: add moderator kick command"
```

---

### Task 3: Reaction routing

**Files:**
- Modify: `bot.js`
- Modify: `commands.js`
- Modify: `test/kick-command.test.js`

**Interfaces:**
- Consumes: `readReactionCommands()` from `config.js`
- Produces: `handleMessageReactionAdd(reaction, user): Promise<boolean>`

- [ ] **Step 1: Write failing reaction tests**

Create reaction fakes that mirror `reaction.emoji.name`, `reaction.message`, and optional `reaction.partial`. Assert:

1. An authorized moderator's `🥾` reaction kicks the message author with the message body as reason.
2. Empty body uses the exact fallback reason from Global Constraints.
3. Bot users and users without moderator/admin roles do not call `kick`.
4. A nonconfigured emoji returns `false` without side effects.
5. Partial reactions and messages call `fetch()` before accessing message data.

- [ ] **Step 2: Verify reaction tests fail**

Run:

```powershell
node --test --test-name-pattern="reaction" test/kick-command.test.js
```

Expected: failure because `handleMessageReactionAdd` does not exist.

- [ ] **Step 3: Implement reaction dispatch and Discord event wiring**

In `commands.js`, resolve partials, derive the reaction key from `reaction.emoji.id ?? reaction.emoji.name`, read the configured command, and return `false` unless it is `kick`. Fetch the reactor's guild member, authorize against combined moderator/admin role IDs, resolve the message author as a guild member, derive the reason, and call `executeKick`. Reply to the source message with the concise outcome and send the result through `auditInteraction` using interaction type `reaction` and an audit context containing the reactor as `user`, plus the source guild/channel IDs.

In `bot.js`, add:

```js
GatewayIntentBits.GuildMessageReactions
```

and `Partials.Channel`, `Partials.Reaction`, and `Partials.User` to the existing partial list. Register:

```js
client.on('messageReactionAdd', (reaction, user) => {
  handleMessageReactionAdd(reaction, user)
    .catch(error => console.error('Unhandled reaction command error:', error));
});
```

- [ ] **Step 4: Verify reaction tests and full suite pass**

Run:

```powershell
npm run check
```

Expected: syntax checks pass and the complete test suite reports zero failures.

- [ ] **Step 5: Update documentation and commit**

Update `README.md` with direct and reaction kick usage. Update `HANDOFF.md` with the reaction intent, configuration contract, routing, fallback reason, DM behavior, and audit behavior.

```powershell
git add bot.js commands.js test/kick-command.test.js README.md HANDOFF.md
git commit -m "feat: run kick from configured reactions"
```

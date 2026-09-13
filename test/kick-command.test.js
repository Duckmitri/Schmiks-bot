const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'schmiks-kick-command-'));
process.env.CONFIG_PATH = path.join(temporaryDirectory, 'config.json');
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'schmiks.db');

const { executeKick, handlePrefixCommand, handleSlashCommand } = require('../commands');
const { database } = require('../database');

function writeRoles() {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    moderatorRoleId: ['moderator'],
    adminRoleId: []
  }));
}

function makeTarget({ kickable = true, sendError } = {}) {
  const calls = [];
  return {
    calls,
    kickable,
    async send(payload) {
      calls.push({ method: 'send', payload });
      if (sendError) throw sendError;
    },
    async kick(reason) {
      calls.push({ method: 'kick', reason });
    }
  };
}

test.beforeEach(writeRoles);

test.after(() => {
  if (database.open) database.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('/kick resolves its target member and required reason', async () => {
  const target = makeTarget();
  const optionCalls = [];
  const replies = [];

  await handleSlashCommand({
    commandName: 'kick',
    options: {
      getMember(name) {
        optionCalls.push(['member', name]);
        return target;
      },
      getString(name, required) {
        optionCalls.push(['string', name, required]);
        return 'repeated spam';
      }
    },
    user: { id: 'moderator-user', tag: 'moderator' },
    member: { roles: ['moderator'] },
    guild: { id: 'guild-1', name: 'Test Guild' },
    channelId: 'channel-1',
    reply: async payload => replies.push(payload)
  });

  assert.deepEqual(optionCalls, [['member', 'target'], ['string', 'reason', true]]);
  assert.equal(target.calls[1].reason, 'repeated spam');
  assert.match(replies[0], /kicked/i);
});

test('!kick resolves the first mentioned member and preserves the remaining reason', async () => {
  const target = makeTarget();
  const replies = [];

  await handlePrefixCommand({
    content: '!kick @target repeated spam',
    mentions: { members: { first: () => target } },
    author: { id: 'moderator-user', tag: 'moderator' },
    member: { roles: { cache: { has: id => id === 'moderator' } } },
    guild: { id: 'guild-2', name: 'Test Guild' },
    channelId: 'channel-2',
    reply: async payload => replies.push(payload)
  }, '!');

  assert.equal(target.calls[1].reason, 'repeated spam');
  assert.match(replies[0], /kicked/i);
});

test('!kick rejects a missing reason without contacting the target', async () => {
  const target = makeTarget();
  const replies = [];

  await handlePrefixCommand({
    content: '!kick @target',
    mentions: { members: { first: () => target } },
    author: { id: 'moderator-user', tag: 'moderator' },
    member: { roles: { cache: { has: id => id === 'moderator' } } },
    guild: { id: 'guild-3', name: 'Test Guild' },
    channelId: 'channel-3',
    reply: async payload => replies.push(payload)
  }, '!');

  assert.deepEqual(target.calls, []);
  assert.match(replies[0], /Usage: !kick/);
});

test('/kick rejects a missing target member', async () => {
  const replies = [];

  await handleSlashCommand({
    commandName: 'kick',
    options: {
      getMember: () => null,
      getString: () => 'repeated spam'
    },
    user: { id: 'moderator-user', tag: 'moderator' },
    member: { roles: ['moderator'] },
    guild: { id: 'guild-4', name: 'Test Guild' },
    channelId: 'channel-4',
    reply: async payload => replies.push(payload)
  });

  assert.deepEqual(replies, ['Usage: /kick @member <reason>']);
});

test('executeKick sends a red kick notice before kicking the target', async () => {
  const target = makeTarget();

  const result = await executeKick({
    guild: { name: 'Test Guild' },
    target,
    reason: 'repeated spam'
  });

  assert.deepEqual(result, { success: true, dmDelivered: true });
  assert.deepEqual(target.calls.map(call => call.method), ['send', 'kick']);
  assert.deepEqual(target.calls[0].payload.embeds[0].toJSON(), {
    color: 0xED4245,
    title: 'You have been kicked from Test Guild',
    description: 'repeated spam'
  });
});

test('a failed kick DM still kicks the target and warns the moderator', async () => {
  const target = makeTarget({ sendError: new Error('DMs disabled') });
  const replies = [];

  await handlePrefixCommand({
    content: '!kick @target repeated spam',
    mentions: { members: { first: () => target } },
    author: { id: 'moderator-user', tag: 'moderator' },
    member: { roles: { cache: { has: id => id === 'moderator' } } },
    guild: { id: 'guild-3', name: 'Test Guild' },
    channelId: 'channel-3',
    reply: async payload => replies.push(payload)
  }, '!');

  assert.equal(target.calls[1].reason, 'repeated spam');
  assert.match(replies[0], /DM.*failed/i);
});

test('executeKick rejects targets that are not kickable without sending or kicking', async () => {
  const target = makeTarget({ kickable: false });

  const result = await executeKick({
    guild: { name: 'Test Guild' },
    target,
    reason: 'repeated spam'
  });

  assert.deepEqual(result, { success: false, errorCode: 'TARGET_NOT_KICKABLE' });
  assert.deepEqual(target.calls, []);
});

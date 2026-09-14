const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'schmiks-kick-command-'));
process.env.CONFIG_PATH = path.join(temporaryDirectory, 'config.json');
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'schmiks.db');

const {
  executeKick,
  handleMessageReactionAdd,
  handlePrefixCommand,
  handleSlashCommand
} = require('../commands');
const { database } = require('../database');

function writeRoles() {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    moderatorRoleId: ['moderator'],
    adminRoleId: [],
    reactionCommands: { '🥾': 'kick' }
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

function makeReaction({ emoji = { name: '🥾' }, message, partial = false, fetch } = {}) {
  return { emoji, message, partial, fetch };
}

const longReason = 'x'.repeat(600);
const boundedLongReason = 'x'.repeat(512);

function assertBoundedKickReason(target) {
  assert.equal(target.calls[0].payload.embeds[0].toJSON().description, boundedLongReason);
  assert.equal(target.calls[1].reason, boundedLongReason);
}

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

test('/kick fetches an unresolved target member before kicking', async () => {
  const target = { id: 'uncached-member', ...makeTarget() };
  const fetchedIds = [];
  const replies = [];

  await handleSlashCommand({
    commandName: 'kick',
    options: {
      getMember: () => ({ user: { id: 'uncached-member' } }),
      getString: () => 'repeated spam'
    },
    user: { id: 'moderator-user', tag: 'moderator' },
    member: { roles: ['moderator'] },
    guild: {
      id: 'guild-uncached',
      name: 'Test Guild',
      members: { fetch: async id => {
        fetchedIds.push(id);
        return target;
      } }
    },
    channelId: 'channel-uncached',
    reply: async payload => replies.push(payload)
  });

  assert.deepEqual(fetchedIds, ['uncached-member']);
  assert.equal(target.calls[1].reason, 'repeated spam');
  assert.match(replies[0], /kicked/i);
});

test('/kick audits success when its confirmation reply fails', async t => {
  const target = makeTarget();
  t.mock.method(console, 'error', () => {});

  await handleSlashCommand({
    commandName: 'kick',
    options: {
      getMember: () => target,
      getString: () => 'repeated spam'
    },
    user: { id: 'slash-reply-user', tag: 'moderator' },
    member: { roles: ['moderator'] },
    guild: { id: 'guild-slash-reply', name: 'Test Guild' },
    channelId: 'channel-slash-reply',
    reply: async () => { throw new Error('confirmation unavailable'); }
  });

  assert.equal(target.calls[1].reason, 'repeated spam');
  assert.deepEqual(database.prepare(`
    SELECT interaction_type, success, error_code
    FROM command_events
    WHERE guild_id = 'guild-slash-reply'
  `).all(), [{ interaction_type: 'slash', success: 1, error_code: null }]);
});

test('/kick bounds the DM and Discord audit reason to 512 characters', async () => {
  const target = makeTarget();

  await handleSlashCommand({
    commandName: 'kick',
    options: {
      getMember: () => target,
      getString: () => longReason
    },
    user: { id: 'slash-long-user', tag: 'moderator' },
    member: { roles: ['moderator'] },
    guild: { id: 'guild-slash-long', name: 'Test Guild' },
    channelId: 'channel-slash-long',
    reply: async () => {}
  });

  assertBoundedKickReason(target);
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

test('!kick audits success when its confirmation reply fails', async t => {
  const target = makeTarget();
  t.mock.method(console, 'error', () => {});

  await handlePrefixCommand({
    content: '!kick @target repeated spam',
    mentions: { members: { first: () => target } },
    author: { id: 'prefix-reply-user', tag: 'moderator' },
    member: { roles: { cache: { has: id => id === 'moderator' } } },
    guild: { id: 'guild-prefix-reply', name: 'Test Guild' },
    channelId: 'channel-prefix-reply',
    reply: async () => { throw new Error('confirmation unavailable'); }
  }, '!');

  assert.equal(target.calls[1].reason, 'repeated spam');
  assert.deepEqual(database.prepare(`
    SELECT interaction_type, success, error_code
    FROM command_events
    WHERE guild_id = 'guild-prefix-reply'
  `).all(), [{ interaction_type: 'prefix', success: 1, error_code: null }]);
});

test('!kick bounds the DM and Discord audit reason to 512 characters', async () => {
  const target = makeTarget();

  await handlePrefixCommand({
    content: `!kick @target ${longReason}`,
    mentions: { members: { first: () => target } },
    author: { id: 'prefix-long-user', tag: 'moderator' },
    member: { roles: { cache: { has: id => id === 'moderator' } } },
    guild: { id: 'guild-prefix-long', name: 'Test Guild' },
    channelId: 'channel-prefix-long',
    reply: async () => {}
  }, '!');

  assertBoundedKickReason(target);
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

test('a moderator reaction kicks the message author using the message body as its reason', async () => {
  const target = { id: 'target-user', ...makeTarget() };
  const replies = [];
  const memberFetches = [];
  const guild = {
    id: 'guild-reaction',
    name: 'Test Guild',
    members: {
      fetch: async id => {
        memberFetches.push(id);
        return id === 'moderator-user'
          ? { user: { bot: false }, roles: { cache: { has: roleId => roleId === 'moderator' } } }
          : target;
      }
    }
  };
  const reaction = makeReaction({
    message: {
      guild,
      guildId: guild.id,
      channelId: 'channel-reaction',
      author: { id: target.id },
      content: 'repeated spam',
      reply: async payload => replies.push(payload)
    }
  });

  const handled = await handleMessageReactionAdd(reaction, { id: 'moderator-user', bot: false });

  assert.equal(handled, true);
  assert.deepEqual(memberFetches, ['moderator-user', 'target-user']);
  assert.equal(target.calls[1].reason, 'repeated spam');
  assert.match(replies[0], /kicked/i);
  assert.deepEqual(database.prepare(`
    SELECT guild_id, channel_id, user_id, interaction_type, command_name, success
    FROM command_events
    WHERE interaction_type = 'reaction'
  `).all(), [{
    guild_id: 'guild-reaction',
    channel_id: 'channel-reaction',
    user_id: 'moderator-user',
    interaction_type: 'reaction',
    command_name: 'kick',
    success: 1
  }]);
});

test('a source reply failure does not change a completed reaction kick audit', async () => {
  const target = { id: 'target-user', ...makeTarget() };
  const guild = {
    id: 'guild-reply-failure',
    name: 'Test Guild',
    members: {
      fetch: async id => id === 'moderator-user'
        ? { user: { bot: false }, roles: { cache: { has: roleId => roleId === 'moderator' } } }
        : target
    }
  };
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const handled = await handleMessageReactionAdd(makeReaction({
      message: {
        guild,
        guildId: guild.id,
        channelId: 'channel-reply-failure',
        author: { id: target.id },
        content: 'repeated spam',
        reply: async () => { throw new Error('source message is unavailable'); }
      }
    }), { id: 'moderator-user', bot: false });

    assert.equal(handled, true);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(target.calls[1].reason, 'repeated spam');
  assert.deepEqual(database.prepare(`
    SELECT success, error_code
    FROM command_events
    WHERE guild_id = 'guild-reply-failure'
  `).all(), [{ success: 1, error_code: null }]);
});

test('a reaction to an empty message uses the documented fallback reason', async () => {
  const target = { id: 'target-user', ...makeTarget() };
  const guild = {
    id: 'guild-empty-reaction',
    name: 'Test Guild',
    members: {
      fetch: async id => id === 'moderator-user'
        ? { user: { bot: false }, roles: { cache: { has: roleId => roleId === 'moderator' } } }
        : target
    }
  };

  await handleMessageReactionAdd(makeReaction({
    message: {
      guild,
      guildId: guild.id,
      channelId: 'channel-empty-reaction',
      author: { id: target.id },
      content: '   ',
      reply: async () => {}
    }
  }), { id: 'moderator-user', bot: false });

  assert.equal(target.calls[1].reason, 'You have been kicked from the server, no reason provided');
});

test('a reaction bounds the DM and Discord audit reason to 512 characters', async () => {
  const target = { id: 'target-user', ...makeTarget() };
  const guild = {
    id: 'guild-reaction-long',
    name: 'Test Guild',
    members: {
      fetch: async id => id === 'moderator-user'
        ? { user: { bot: false }, roles: { cache: { has: roleId => roleId === 'moderator' } } }
        : target
    }
  };

  await handleMessageReactionAdd(makeReaction({
    message: {
      guild,
      guildId: guild.id,
      channelId: 'channel-reaction-long',
      author: { id: target.id },
      content: longReason,
      reply: async () => {}
    }
  }), { id: 'moderator-user', bot: false });

  assertBoundedKickReason(target);
});

test('a bot reaction does not perform a kick', async () => {
  const handled = await handleMessageReactionAdd(makeReaction({
    message: {
      get guild() {
        throw new Error('bot reactions must not read the message');
      }
    }
  }), { id: 'bot-user', bot: true });

  assert.equal(handled, false);
});

test('a partial bot user cannot kick after its guild member is fetched', async () => {
  const target = { id: 'target-user', ...makeTarget() };
  const memberFetches = [];
  const guild = {
    id: 'guild-partial-bot',
    name: 'Test Guild',
    members: {
      fetch: async id => {
        memberFetches.push(id);
        return id === 'partial-bot-user'
          ? { user: { bot: true }, roles: { cache: { has: roleId => roleId === 'moderator' } } }
          : target;
      }
    }
  };

  const handled = await handleMessageReactionAdd(makeReaction({
    message: {
      guild,
      guildId: guild.id,
      channelId: 'channel-partial-bot',
      author: { id: target.id },
      content: 'repeated spam',
      reply: async () => {}
    }
  }), { id: 'partial-bot-user', bot: null });

  assert.equal(handled, false);
  assert.deepEqual(memberFetches, ['partial-bot-user']);
  assert.deepEqual(target.calls, []);
});

test('an unauthorized reaction does not perform a kick', async () => {
  const target = { id: 'target-user', ...makeTarget() };
  const guild = {
    id: 'guild-unauthorized-reaction',
    name: 'Test Guild',
    members: {
      fetch: async id => id === 'moderator-user'
        ? { user: { bot: false }, roles: { cache: { has: () => false } } }
        : target
    }
  };

  const handled = await handleMessageReactionAdd(makeReaction({
    message: {
      guild,
      author: { id: target.id },
      content: 'repeated spam',
      reply: async () => {}
    }
  }), { id: 'moderator-user', bot: false });

  assert.equal(handled, false);
  assert.deepEqual(target.calls, []);
});

test('a nonconfigured reaction returns false without side effects', async () => {
  const memberFetches = [];
  const handled = await handleMessageReactionAdd(makeReaction({
    emoji: { name: '❌' },
    message: {
      guild: { members: { fetch: async id => memberFetches.push(id) } },
      author: { id: 'target-user' },
      content: 'repeated spam'
    }
  }), { id: 'moderator-user', bot: false });

  assert.equal(handled, false);
  assert.deepEqual(memberFetches, []);
});

test('a configured custom emoji ID routes the reaction command', async () => {
  const target = { id: 'target-user', ...makeTarget() };
  const guild = {
    id: 'guild-custom-reaction',
    name: 'Test Guild',
    members: {
      fetch: async id => id === 'moderator-user'
        ? { user: { bot: false }, roles: { cache: { has: roleId => roleId === 'moderator' } } }
        : target
    }
  };
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    moderatorRoleId: ['moderator'],
    adminRoleId: [],
    reactionCommands: { 'boot-emoji-id': 'kick' }
  }));

  const handled = await handleMessageReactionAdd(makeReaction({
    emoji: { id: 'boot-emoji-id', name: 'not-configured-by-name' },
    message: {
      guild,
      guildId: guild.id,
      channelId: 'channel-custom-reaction',
      author: { id: target.id },
      content: 'repeated spam',
      reply: async () => {}
    }
  }), { id: 'moderator-user', bot: false });

  assert.equal(handled, true);
  assert.equal(target.calls[1].reason, 'repeated spam');
});

test('a reaction fetches partial reaction and message data before routing', async () => {
  const target = { id: 'target-user', ...makeTarget() };
  const fetches = [];
  const guild = {
    id: 'guild-partial-reaction',
    name: 'Test Guild',
    members: {
      fetch: async id => id === 'moderator-user'
        ? { user: { bot: false }, roles: { cache: { has: roleId => roleId === 'moderator' } } }
        : target
    }
  };
  const completeMessage = {
    guild,
    guildId: guild.id,
    channelId: 'channel-partial-reaction',
    author: { id: target.id },
    content: 'repeated spam',
    reply: async () => {}
  };
  const partialMessage = {
    partial: true,
    fetch: async () => {
      fetches.push('message');
      return completeMessage;
    },
    get author() {
      throw new Error('message was read before fetching');
    }
  };
  const completeReaction = makeReaction({ message: partialMessage });
  const partialReaction = {
    partial: true,
    fetch: async () => {
      fetches.push('reaction');
      return completeReaction;
    },
    get emoji() {
      throw new Error('reaction was read before fetching');
    }
  };

  const handled = await handleMessageReactionAdd(partialReaction, { id: 'moderator-user', bot: false });

  assert.equal(handled, true);
  assert.deepEqual(fetches, ['reaction', 'message']);
  assert.equal(target.calls[1].reason, 'repeated spam');
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'schmiks-logs-command-'));
process.env.CONFIG_PATH = path.join(temporaryDirectory, 'config.json');
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'schmiks.db');
delete process.env.BOT_PREFIX;

fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
  moderatorRoleId: [],
  adminRoleId: ['admin']
}));

const { handleButtonInteraction, handlePrefixCommand, handleSlashCommand } = require('../commands');
const { database, logCommandEvent, logMessageEvent, logGeneralEvent } = require('../database');

test.beforeEach(() => database.exec(`
  DELETE FROM command_events;
  DELETE FROM message_events;
  DELETE FROM general_events;
`));

test.after(() => {
  if (database.open) database.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('an administrator can view command logs with the slash command', async () => {
  logCommandEvent({
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId: 'user-1',
    interactionType: 'slash',
    commandName: 'links',
    success: true,
    durationMs: 12
  });

  const replies = [];
  await handleSlashCommand({
    commandName: 'logs',
    options: { getString: () => 'commands' },
    user: { id: 'admin-user', tag: 'admin' },
    member: { roles: ['admin'] },
    guild: { id: 'guild-1' },
    guildId: 'guild-1',
    channelId: 'channel-1',
    reply: async payload => replies.push(payload)
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, undefined);
  const embed = replies[0].embeds[0].toJSON();
  assert.equal(embed.title, 'Command Logs');
  assert.match(embed.description, /links/);
  assert.match(embed.description, /<@user-1>/);
  assert.match(embed.description, /<#channel-1>/);
  assert.match(embed.description, /Success/);
  assert.equal(embed.footer.text, 'Page 1 of 1 • 1 command');
});

test('command log page buttons navigate a stable snapshot', async () => {
  for (let index = 0; index < 12; index += 1) {
    logCommandEvent({
      guildId: 'guild-2',
      channelId: 'channel-2',
      userId: `user-${index}`,
      interactionType: index % 2 === 0 ? 'prefix' : 'slash',
      commandName: `command-${index}`,
      success: true,
      durationMs: index
    });
  }
  const throughId = database.prepare("SELECT id FROM command_events WHERE command_name = 'command-11'").get().id;

  const replies = [];
  await handleSlashCommand({
    commandName: 'logs',
    options: { getString: () => 'commands' },
    user: { id: 'admin-user', tag: 'admin' },
    member: { roles: ['admin'] },
    guild: { id: 'guild-2' },
    guildId: 'guild-2',
    channelId: 'channel-2',
    reply: async payload => replies.push(payload)
  });

  const nextButton = replies[0].components[0].components[1].toJSON();
  assert.equal(nextButton.custom_id, `logs:commands:1:${throughId}`);
  assert.equal(nextButton.disabled, false);

  logCommandEvent({
    guildId: 'guild-2',
    channelId: 'channel-2',
    userId: 'new-user',
    interactionType: 'slash',
    commandName: 'newer-command',
    success: true,
    durationMs: 1
  });

  const updates = [];
  const handled = await handleButtonInteraction({
    customId: nextButton.custom_id,
    user: { id: 'admin-user', tag: 'admin' },
    member: { roles: ['admin'] },
    guildId: 'guild-2',
    channelId: 'channel-2',
    update: async payload => updates.push(payload),
    reply: async () => {}
  });

  assert.equal(handled, true);
  assert.equal(updates.length, 1);
  const secondPage = updates[0].embeds[0].toJSON();
  assert.equal(secondPage.footer.text, 'Page 2 of 2 • 12 commands');
  assert.match(secondPage.description, /command-1/);
  assert.match(secondPage.description, /command-0/);
  assert.doesNotMatch(secondPage.description, /command-11/);
  assert.doesNotMatch(secondPage.description, /newer-command/);
});

test('an invalid prefix log choice returns usage guidance and records the failure', async () => {
  const replies = [];
  await handlePrefixCommand({
    content: '!logs invalid-choice',
    author: { id: 'admin-user', tag: 'admin' },
    member: { roles: { cache: { has: id => id === 'admin' } } },
    guild: { id: 'guild-3' },
    channelId: 'channel-3',
    reply: async payload => replies.push(payload)
  }, '!');

  assert.deepEqual(replies, ['Usage: !logs <general|messages|commands>']);
  assert.deepEqual(database.prepare(`
    SELECT command_name, success, error_code
    FROM command_events
  `).all(), [{
    command_name: 'logs',
    success: 0,
    error_code: 'INVALID_OPTION'
  }]);
});

test('an administrator can use the prefix command and see category-specific empty states', async () => {
  logCommandEvent({
    guildId: 'guild-4',
    channelId: 'channel-4',
    userId: 'user-4',
    interactionType: 'prefix',
    commandName: 'links',
    success: true,
    durationMs: 4
  });

  const replies = [];
  const message = content => ({
    content,
    author: { id: 'admin-user', tag: 'admin' },
    member: { roles: { cache: { has: id => id === 'admin' } } },
    guild: { id: 'guild-4' },
    channelId: 'channel-4',
    reply: async payload => replies.push(payload)
  });

  await handlePrefixCommand(message('!logs commands'), '!');
  await handlePrefixCommand(message('!logs general'), '!');
  await handlePrefixCommand(message('!logs messages'), '!');

  assert.equal(replies[0].embeds[0].toJSON().title, 'Command Logs');
  const general = replies[1].embeds[0].toJSON();
  const messages = replies[2].embeds[0].toJSON();
  assert.equal(general.title, 'General Logs');
  assert.equal(general.description, 'No general logs have been recorded for this server yet.');
  assert.equal(general.footer.text, 'Page 1 of 1 • 0 events');
  assert.equal(messages.title, 'Message Logs');
  assert.equal(messages.description, 'No message logs have been recorded for this server yet.');
  assert.equal(messages.footer.text, 'Page 1 of 1 • 0 events');
});

test('message logs distinguish edits and deletes and safely bound content and attachments', async () => {
  logMessageEvent({
    guildId: 'guild-message', channelId: 'channel-edit', messageId: 'message-edit', authorId: 'author-edit',
    type: 'message_edit', beforeContent: '*before*', afterContent: '[after](https://unsafe.example)',
    beforeAttachmentUrls: [
      'https://cdn.example/before-1.png',
      'https://cdn.example/before-2.png',
      'https://cdn.example/before-3.png',
      'https://cdn.example/before-4.png',
      'https://cdn.example/before-5.png'
    ],
    afterAttachmentUrls: ['https://cdn.example/after.png'],
    timestamp: '2026-01-01T00:00:00.000Z'
  });
  logMessageEvent({
    guildId: 'guild-message', channelId: 'channel-delete', messageId: 'message-delete', authorId: 'author-delete',
    type: 'message_delete', beforeContent: '# deleted', afterContent: null,
    beforeAttachmentUrls: [], afterAttachmentUrls: null,
    timestamp: '2026-01-01T00:01:00.000Z'
  });

  const replies = [];
  await handleSlashCommand({
    commandName: 'logs', options: { getString: () => 'messages' },
    user: { id: 'admin-user', tag: 'admin' }, member: { roles: ['admin'] },
    guild: { id: 'guild-message' }, guildId: 'guild-message', channelId: 'command-channel',
    reply: async payload => replies.push(payload)
  });

  const embed = replies[0].embeds[0].toJSON();
  assert.equal(embed.title, 'Message Logs');
  assert.match(embed.description, /Message Deleted/);
  assert.match(embed.description, /Message Edited/);
  assert.match(embed.description, /<@author-delete>.*<#channel-delete>/);
  assert.match(embed.description, /<@author-edit>.*<#channel-edit>/);
  assert.match(embed.description, /<t:\d+:R>/);
  assert.match(embed.description, /Before: \\\*before\\\*/);
  assert.ok(embed.description.includes('After: \\[after\\]\\(https://unsafe.example\\)'));
  assert.match(embed.description, /Deleted: \\# deleted/);
  assert.match(embed.description, /Attachment 1/);
  assert.match(embed.description, /3 attachments omitted/);
  assert.equal(embed.footer.text, 'Page 1 of 1 • 2 events');
});

test('general logs distinguish member and voice activity and escape labels', async () => {
  const types = ['member_join', 'member_leave', 'voice_join', 'voice_leave'];
  for (const [index, type] of types.entries()) {
    logGeneralEvent({
      guildId: 'guild-general', userId: `user-${index}`, userLabel: `*~User ${index}~*`, type,
      channelId: type.startsWith('voice') ? `voice-${index}` : null,
      timestamp: `2026-01-01T00:0${index}:00.000Z`
    });
  }

  const replies = [];
  await handleSlashCommand({
    commandName: 'logs', options: { getString: () => 'general' },
    user: { id: 'admin-user', tag: 'admin' }, member: { roles: ['admin'] },
    guild: { id: 'guild-general' }, guildId: 'guild-general', channelId: 'command-channel',
    reply: async payload => replies.push(payload)
  });

  const embed = replies[0].embeds[0].toJSON();
  assert.match(embed.description, /Member Joined/);
  assert.match(embed.description, /Member Left/);
  assert.match(embed.description, /Voice Joined/);
  assert.match(embed.description, /Voice Left/);
  assert.match(embed.description, /<@user-2>.*\\\*\\~User 2\\~\\\*.*<#voice-2>/);
  assert.match(embed.description, /<t:\d+:R>/);
  assert.equal(embed.footer.text, 'Page 1 of 1 • 4 events');
});

test('message rendering never slices accepted attachment links and counts every undisplayed attachment', async () => {
  const beforeUrl = `https://cdn.example/${'before-path-'.repeat(7)}image.png`;
  const afterUrl = `https://cdn.example/${'after-path-'.repeat(8)}image.png`;
  logMessageEvent({
    guildId: 'guild-link-budget', channelId: 'channel', messageId: 'message', authorId: 'author',
    type: 'message_edit', beforeContent: '~~before~~'.repeat(100), afterContent: '~~after~~'.repeat(100),
    beforeAttachmentUrls: [beforeUrl], afterAttachmentUrls: [afterUrl],
    timestamp: '2026-01-01T00:00:00.000Z'
  });

  const replies = [];
  await handleSlashCommand({
    commandName: 'logs', options: { getString: () => 'messages' },
    user: { id: 'admin-user', tag: 'admin' }, member: { roles: ['admin'] },
    guild: { id: 'guild-link-budget' }, guildId: 'guild-link-budget', channelId: 'command-channel',
    reply: async payload => replies.push(payload)
  });

  const description = replies[0].embeds[0].toJSON().description;
  assert.match(description, /Before: \\~\\~before\\~\\~/);
  assert.doesNotMatch(description, /(?<!\\)~~/);
  assert.ok(description.includes(`[Attachment 1](${beforeUrl})`));
  assert.doesNotMatch(description, /\[Attachment \d+\]\([^\n)]*(?:…|$)/);
  assert.match(description, /After attachments: 1 attachment omitted/);
});

test('message and general log buttons navigate stable guild-scoped snapshots', async () => {
  for (let index = 0; index < 12; index += 1) {
    const minute = String(index).padStart(2, '0');
    logMessageEvent({
      guildId: 'guild-pages', channelId: 'message-channel', messageId: `message-${index}`,
      authorId: `message-user-${index}`, type: 'message_edit', beforeContent: `old-${index}`,
      afterContent: `new-${index}`, beforeAttachmentUrls: [], afterAttachmentUrls: [],
      timestamp: `2026-01-01T00:${minute}:00.000Z`
    });
    logGeneralEvent({
      guildId: 'guild-pages', userId: `general-user-${index}`, userLabel: `General ${index}`,
      type: 'member_join', timestamp: `2026-01-01T00:${minute}:00.000Z`
    });
  }
  logMessageEvent({
    guildId: 'other-guild', channelId: 'private-channel', messageId: 'private-message',
    authorId: 'private-author', type: 'message_delete', beforeContent: 'private-message-content',
    beforeAttachmentUrls: [], afterAttachmentUrls: null
  });
  logGeneralEvent({
    guildId: 'other-guild', userId: 'private-member', userLabel: 'Private Member', type: 'member_leave'
  });
  const throughIds = {
    messages: database.prepare("SELECT id FROM message_events WHERE message_id = 'message-11'").get().id,
    general: database.prepare("SELECT id FROM general_events WHERE user_id = 'general-user-11'").get().id
  };

  for (const category of ['messages', 'general']) {
    const replies = [];
    await handleSlashCommand({
      commandName: 'logs', options: { getString: () => category },
      user: { id: 'admin-user', tag: 'admin' }, member: { roles: ['admin'] },
      guild: { id: 'guild-pages' }, guildId: 'guild-pages', channelId: 'command-channel',
      reply: async payload => replies.push(payload)
    });
    const nextButton = replies[0].components[0].components[1].toJSON();
    assert.equal(nextButton.custom_id, `logs:${category}:1:${throughIds[category]}`);

    if (category === 'messages') {
      logMessageEvent({
        guildId: 'guild-pages', channelId: 'message-channel', messageId: 'new-message',
        authorId: 'new-message-user', type: 'message_delete', beforeContent: 'new-message-content',
        beforeAttachmentUrls: [], afterAttachmentUrls: null
      });
    } else {
      logGeneralEvent({ guildId: 'guild-pages', userId: 'new-general-user', type: 'member_join' });
    }

    const updates = [];
    const handled = await handleButtonInteraction({
      customId: nextButton.custom_id, user: { id: 'admin-user', tag: 'admin' },
      member: { roles: ['admin'] }, guildId: 'guild-pages', channelId: 'command-channel',
      update: async payload => updates.push(payload), reply: async () => {}
    });
    assert.equal(handled, true);
    assert.equal(updates.length, 1);
    const page = updates[0].embeds[0].toJSON();
    assert.equal(page.footer.text, 'Page 2 of 2 • 12 events');
    assert.doesNotMatch(page.description, /private|new-message-content|new-general-user/);
    assert.match(page.description, category === 'messages' ? /old-0/ : /general-user-0/);
  }
});

test('non-administrators cannot execute the logs command', async () => {
  const replies = [];
  await handleSlashCommand({
    commandName: 'logs',
    options: { getString: () => 'commands' },
    user: { id: 'member-user', tag: 'member' },
    member: { roles: ['member'] },
    guild: { id: 'guild-5' },
    guildId: 'guild-5',
    channelId: 'channel-5',
    reply: async payload => replies.push(payload)
  });

  assert.deepEqual(replies, [{
    content: 'You do not have permission to use administrator commands.',
    ephemeral: true
  }]);
  assert.equal(database.prepare(`
    SELECT error_code FROM command_events WHERE command_name = 'logs'
  `).get().error_code, 'PERMISSION_DENIED');
});

test('non-administrators cannot operate any log page buttons', async () => {
  for (const category of ['commands', 'messages', 'general']) {
    const replies = [];
    const updates = [];
    const handled = await handleButtonInteraction({
      customId: `logs:${category}:1:12`,
      user: { id: 'member-user', tag: 'member' },
      member: { roles: ['member'] },
      guildId: 'guild-6', channelId: 'channel-6',
      reply: async payload => replies.push(payload), update: async payload => updates.push(payload)
    });

    assert.equal(handled, true);
    assert.equal(updates.length, 0);
    assert.deepEqual(replies, [{
      content: 'You do not have permission to view administrator logs.',
      ephemeral: true
    }]);
  }
});

test('command log embeds stay within Discord limits and remain guild-scoped', async () => {
  for (let index = 0; index < 10; index += 1) {
    logCommandEvent({
      guildId: 'guild-7',
      channelId: 'channel-7',
      userId: `user-${index}`,
      interactionType: 'prefix',
      commandName: `${'very-long-command_'.repeat(100)}${index}`,
      success: false,
      durationMs: index,
      errorCode: 'VERY_LONG_ERROR_'.repeat(500)
    });
  }
  logCommandEvent({
    guildId: 'other-guild',
    channelId: 'private-channel',
    userId: 'private-user',
    interactionType: 'slash',
    commandName: 'private-command',
    success: true
  });

  const replies = [];
  await handleSlashCommand({
    commandName: 'logs',
    options: { getString: () => 'commands' },
    user: { id: 'admin-user', tag: 'admin' },
    member: { roles: ['admin'] },
    guild: { id: 'guild-7' },
    guildId: 'guild-7',
    channelId: 'channel-7',
    reply: async payload => replies.push(payload)
  });

  const embed = replies[0].embeds[0].toJSON();
  assert.equal(embed.description.length <= 4096, true);
  assert.equal(embed.footer.text, 'Page 1 of 1 • 10 commands');
  assert.doesNotMatch(embed.description, /private-command|private-user|private-channel/);
});

test('message and general log embeds remain valid with extremely long untrusted values', async () => {
  const huge = '*[untrusted](value)*'.repeat(1000);
  const hugeUrl = `https://cdn.example/${'segment_'.repeat(1000)}.png`;
  for (let index = 0; index < 10; index += 1) {
    logMessageEvent({
      guildId: 'guild-limits', channelId: `channel-${index}`, messageId: `message-${index}`,
      authorId: `author-${index}`, type: index === 0 ? 'message_delete' : 'message_edit',
      beforeContent: huge, afterContent: index === 0 ? null : huge,
      beforeAttachmentUrls: Array.from({ length: 20 }, () => hugeUrl),
      afterAttachmentUrls: index === 0 ? null : Array.from({ length: 20 }, () => hugeUrl)
    });
    logGeneralEvent({
      guildId: 'guild-limits', userId: `user-${index}`, userLabel: huge,
      type: index % 2 === 0 ? 'voice_join' : 'member_leave', channelId: `voice-${index}`
    });
  }

  for (const category of ['messages', 'general']) {
    const replies = [];
    await handleSlashCommand({
      commandName: 'logs', options: { getString: () => category },
      user: { id: 'admin-user', tag: 'admin' }, member: { roles: ['admin'] },
      guild: { id: 'guild-limits' }, guildId: 'guild-limits', channelId: 'command-channel',
      reply: async payload => replies.push(payload)
    });
    const embed = replies[0].embeds[0].toJSON();
    const totalEmbedText = embed.title.length + embed.description.length + embed.footer.text.length;
    assert.equal(embed.description.length <= 4096, true);
    assert.equal((embed.fields ?? []).length <= 25, true);
    assert.equal((embed.fields ?? []).every(field => field.value.length <= 1024), true);
    assert.equal(totalEmbedText <= 6000, true);
    assert.equal(embed.description.length > 0, true);
    assert.match(embed.description, category === 'messages' ? /Message (?:Edited|Deleted)/ : /(?:Member|Voice) (?:Joined|Left)/);
    if (category === 'messages') {
      assert.match(embed.description, /20 attachments omitted/);
      assert.doesNotMatch(embed.description, /segment_segment_/);
    }
  }
});

test('slash and prefix logs respond safely with category-specific errors when the database is unavailable', async () => {
  database.close();
  const replies = [];
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await handleSlashCommand({
      commandName: 'logs',
      options: { getString: () => 'messages' },
      user: { id: 'admin-user', tag: 'admin' },
      member: { roles: ['admin'] },
      guild: { id: 'guild-8' },
      guildId: 'guild-8',
      channelId: 'channel-8',
      reply: async payload => replies.push(payload)
    });
    await handlePrefixCommand({
      content: '!logs general', author: { id: 'admin-user', tag: 'admin' },
      member: { roles: { cache: { has: id => id === 'admin' } } },
      guild: { id: 'guild-8' }, guildId: 'guild-8', channelId: 'channel-8',
      reply: async payload => replies.push(payload)
    }, '!');
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(replies, [
    { content: 'Could not load message logs.', ephemeral: true },
    { content: 'Could not load general logs.' }
  ]);
});

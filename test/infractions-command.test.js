const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schmiks-infractions-command-'));
process.env.CONFIG_PATH = path.join(directory, 'config.json');
process.env.DATABASE_PATH = path.join(directory, 'test.db');

const { readSlashCommands } = require('../config');
const { database, logInfraction } = require('../database');
const {
  buildInfractionsView,
  handleButtonInteraction,
  handlePrefixCommand,
  handleSlashCommand
} = require('../commands');

test.after(() => {
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('builds public, escaped, snapshot-stable infraction pages', () => {
  for (let index = 0; index < 12; index += 1) {
    logInfraction({
      guildId: 'guild',
      targetUserId: 'target',
      moderatorUserId: `moderator-${index}`,
      type: index % 2 ? 'kick' : 'warn',
      reason: index === 11 ? '**unsafe** reason' : `reason ${index}`,
      occurredAt: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`
    });
  }

  const first = buildInfractionsView('guild', { id: 'target', user: { tag: 'Target' } });
  assert.equal(first.embeds[0].data.title, 'Infractions for Target');
  assert.match(first.embeds[0].data.footer.text, /Page 1 of 2/);
  assert.equal(first.embeds[0].data.description.split('\n\n').length, 10);
  assert.match(first.embeds[0].data.description, /\\\*\\\*unsafe\\\*\\\* reason/);
  assert.match(first.embeds[0].data.description, /<@moderator-11>/);
  assert.match(first.embeds[0].data.description, /<t:\d+:R>/);
  assert.equal(first.components[0].components[0].data.disabled, true);
  assert.match(first.components[0].components[1].data.custom_id, /^infractions:target:1:\d+$/);
  assert.equal('ephemeral' in first, false);

  logInfraction({
    guildId: 'guild', targetUserId: 'target', moderatorUserId: 'new-mod',
    type: 'warn', reason: 'newer', occurredAt: '2026-09-13T00:00:00.000Z'
  });
  const throughId = Number(first.components[0].components[1].data.custom_id.split(':')[3]);
  const second = buildInfractionsView('guild', { id: 'target', user: { tag: 'Target' } }, 1, throughId);
  assert.equal(second.embeds[0].data.description.split('\n\n').length, 2);
  assert.doesNotMatch(second.embeds[0].data.description, /newer/);
});

test('builds an empty public history view', () => {
  const view = buildInfractionsView('guild', { id: 'empty', user: { tag: 'Nobody' } });
  assert.equal(view.embeds[0].data.description, 'No infractions have been recorded for this member.');
  assert.equal(view.embeds[0].data.footer.text, 'Page 1 of 1 • 0 infractions');
  assert.equal('ephemeral' in view, false);
});

test('registers infractions once with a required target user', () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    slashCommands: [{ name: 'infractions', description: 'configured duplicate' }]
  }));
  const commands = readSlashCommands();
  const matches = commands.filter(command => command.name === 'infractions');
  assert.equal(matches.length, 1);
  assert.deepEqual(
    matches[0].options.map(({ name, type, required }) => ({ name, type, required })),
    [{ name: 'target', type: 6, required: true }]
  );
});

test('routes prefix and slash commands with public view payloads', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ moderatorRoleId: ['12345678901234567'] }));
  const target = { id: '23456789012345678', user: { tag: 'Target' } };
  const prefixReplies = [];
  await handlePrefixCommand({
    content: '!infractions <@23456789012345678>',
    guild: { id: 'guild' }, guildId: 'guild', channelId: 'channel',
    author: { id: 'author' },
    member: { roles: ['12345678901234567'] },
    mentions: { members: { first: () => target } },
    reply: async payload => prefixReplies.push(payload)
  }, '!');
  assert.equal(prefixReplies.length, 1);
  assert.equal('ephemeral' in prefixReplies[0], false);

  const slashReplies = [];
  await handleSlashCommand({
    commandName: 'infractions', guildId: 'guild', channelId: 'channel',
    guild: { id: 'guild' }, user: { id: 'author' },
    member: { roles: ['12345678901234567'] },
    options: { getMember: name => name === 'target' ? target : null },
    reply: async payload => slashReplies.push(payload)
  });
  assert.equal(slashReplies.length, 1);
  assert.equal('ephemeral' in slashReplies[0], false);
});

test('authorizes and updates infraction pagination buttons', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ adminRoleId: ['34567890123456789'] }));
  const updates = [];
  const handled = await handleButtonInteraction({
    customId: 'infractions:23456789012345678:0:0',
    guildId: 'guild', channelId: 'channel', user: { id: 'author' },
    guild: { id: 'guild', members: { fetch: async () => ({ id: '23456789012345678', user: { tag: 'Target' } }) } },
    member: { roles: ['34567890123456789'] },
    update: async payload => updates.push(payload),
    reply: async () => assert.fail('authorized button should update')
  });
  assert.equal(handled, true);
  assert.equal(updates[0].embeds[0].data.title, 'Infractions for Target');
  assert.equal('ephemeral' in updates[0], false);
});

test('denies infraction pagination buttons ephemerally', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ moderatorRoleId: ['12345678901234567'] }));
  let reply;
  const handled = await handleButtonInteraction({
    customId: 'infractions:23456789012345678:0:0',
    guildId: 'guild', channelId: 'channel', user: { id: 'author' },
    guild: { id: 'guild' }, member: { roles: [] },
    reply: async payload => { reply = payload; }
  });
  assert.equal(handled, true);
  assert.equal(reply.ephemeral, true);
});

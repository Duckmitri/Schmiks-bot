const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schmiks-ban-command-'));
process.env.CONFIG_PATH = path.join(directory, 'config.json');
process.env.DATABASE_PATH = path.join(directory, 'test.db');

const { database, readInfractionsPage } = require('../database');
const { executeBan, handleSlashCommand, handlePrefixCommand } = require('../commands');

test.after(() => {
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('records a ban with valid length format', async () => {
  const target = { id: 'target-valid', ban: async reason => {} };
  await executeBan({
    guild: { id: 'guild', name: 'Guild' },
    target,
    moderator: { id: 'mod' },
    reason: 'Spam',
    length: '1d'
  });

  const page = readInfractionsPage('guild', 'target-valid');
  assert.equal(page.total, 1);
  const infraction = page.infractions[0];
  assert.equal(infraction.type, 'ban');
  assert.equal(infraction.moderator_user_id, 'mod');
  const expectedReason = 'Spam | Length: 1d';
  assert.equal(infraction.reason, expectedReason);
});

test('records a ban with different length formats', async () => {
  const testCases = ['1w', '1m', '1y', '1d'];
  for (const length of testCases) {
    const target = { id: `target-${length}`, ban: async reason => {} };
    await executeBan({
      guild: { id: 'guild', name: 'Guild' },
      target,
      moderator: { id: 'mod' },
      reason: 'Spam',
      length
    });

    const page = readInfractionsPage('guild', `target-${length}`);
    assert.equal(page.total, 1);
    const infraction = page.infractions[0];
    assert.equal(infraction.type, 'ban');
    assert.equal(infraction.moderator_user_id, 'mod');
    const expectedReason = `Spam | Length: ${length}`;
    assert.equal(infraction.reason, expectedReason);
  }
});

test('rejects invalid length formats', async () => {
  const invalidLengths = ['1', 'd', '1dx', '1dd', '1dz', '1h', '30d', ''];
  for (const length of invalidLengths) {
    const target = { id: `target-${length}`, ban: async reason => {} };
    await assert.rejects(
      executeBan({
        guild: { id: 'guild', name: 'Guild' },
        target,
        moderator: { id: 'mod' },
        reason: 'Spam',
        length
      }),
      /length must be in format: 1d, 1w, 1m, or 1y/
    );
    assert.equal(readInfractionsPage('guild', `target-${length}`).total, 0);
  }
});

test('propagates persistence failure after a successful ban', async () => {
  let banned = false;
  database.exec(`CREATE TRIGGER fail_ban_persistence
    BEFORE INSERT ON infractions BEGIN
      SELECT RAISE(ABORT, 'persistence failed');
    END`);

  try {
    await assert.rejects(executeBan({
      guild: { id: 'guild', name: 'Guild' },
      target: {
        id: 'persistence-failed-target',
        ban: async () => { banned = true; }
      },
      moderator: { id: 'mod' },
      reason: 'Spam',
      length: '1d'
    }), /persistence failed/);
    assert.equal(banned, true);
    assert.equal(readInfractionsPage('guild', 'persistence-failed-target').total, 0);
  } finally {
    database.exec('DROP TRIGGER fail_ban_persistence');
  }
});

test('registers ban with required target, length, and reason options', () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    slashCommands: [{ name: 'ban', description: 'configured duplicate' }]
  }));
  const { readSlashCommands } = require('../config');
  const commands = readSlashCommands();
  const matches = commands.filter(command => command.name === 'ban');
  assert.equal(matches.length, 1);
  assert.deepEqual(
    matches[0].options.map(({ name, type, required }) => ({ name, type, required })),
    [
      { name: 'target', type: 6, required: true },
      { name: 'length', type: 3, required: true },
      { name: 'reason', type: 3, required: true }
    ]
  );
});

test('routes prefix ban command with moderator permissions', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ moderatorRoleId: ['12345678901234567'] }));
  const target = { id: 'target-prefix', user: { tag: 'Target' }, ban: async () => {} };
  let reply;
  await handlePrefixCommand({
    content: '!ban @target-prefix 1d Spam',
    guild: { id: 'guild' }, guildId: 'guild', channelId: 'channel',
    author: { id: 'author' },
    member: { roles: ['12345678901234567'] },
    mentions: { members: { first: () => target } },
    reply: async payload => { reply = payload; }
  }, '!');
  assert.equal(typeof reply, 'string');
  assert.equal(reply, 'The member has been banned for 1d.');
  // Should have recorded the infraction
  const page = readInfractionsPage('guild', 'target-prefix');
  assert.equal(page.total, 1);
});

test('routes slash ban command with moderator permissions', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ moderatorRoleId: ['12345678901234567'] }));
  const target = { id: 'target-slash', user: { tag: 'Target' }, ban: async () => {} };
  let reply;
  await handleSlashCommand({
    commandName: 'ban', guildId: 'guild', channelId: 'channel',
    guild: { id: 'guild' }, user: { id: 'author' },
    member: { roles: ['12345678901234567'] },
    options: {
      getMember: name => name === 'target' ? target : null,
      getString: opt => opt === 'length' ? '1d' : opt === 'reason' ? 'Spam' : null
    },
    reply: async payload => { reply = payload; }
  });
  assert.equal(typeof reply, 'string');
  assert.equal(reply, 'The member has been banned for 1d.');
  // Should have recorded the infraction
  const page = readInfractionsPage('guild', 'target-slash');
  assert.equal(page.total, 1);
});

test('denies ban command without moderator permissions', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ moderatorRoleId: ['12345678901234567'] }));
  let reply;
  const target = { id: 'target-no-perm' };
  const handled = await handlePrefixCommand({
    content: '!ban @target-no-perm 1d Spam',
    guild: { id: 'guild' }, guildId: 'guild', channelId: 'channel',
    author: { id: 'author' },
    member: { roles: [] }, // No moderator role
    mentions: { members: { first: () => target } },
    reply: async payload => { reply = payload; }
  }, '!');
  // The command is considered handled if a reply is sent
  assert.notEqual(reply, undefined);
  assert.equal(reply, 'You do not have permission to use moderator commands.');
  // Should not have recorded the infraction
  const page = readInfractionsPage('guild', 'target-no-perm');
  assert.equal(page.total, 0);
});
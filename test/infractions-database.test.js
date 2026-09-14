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

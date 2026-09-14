const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schmiks-kick-infractions-'));
process.env.DATABASE_PATH = path.join(directory, 'test.db');
const { database, readInfractionsPage } = require('../database');
const { executeKick } = require('../commands');

test.after(() => {
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('records only a successful kick', async () => {
  const target = { id: 'target', kickable: true, send: async () => {}, kick: async () => {} };
  await executeKick({
    guild: { id: 'guild', name: 'Guild' },
    target,
    moderator: { id: 'mod' },
    reason: 'Spam'
  });

  const page = readInfractionsPage('guild', 'target');
  assert.equal(page.total, 1);
  const infraction = page.infractions[0];
  assert.equal(infraction.type, 'kick');
  assert.equal(infraction.moderator_user_id, 'mod');
  assert.equal(infraction.reason, 'Spam');
});

test('does not record a failed kick', async () => {
  const target = {
    id: 'failed-target',
    kickable: true,
    send: async () => {},
    kick: async () => { throw new Error('forbidden'); }
  };

  await assert.rejects(executeKick({
    guild: { id: 'guild', name: 'Guild' },
    target,
    moderator: { id: 'mod' },
    reason: 'Spam'
  }), /forbidden/);
  assert.equal(readInfractionsPage('guild', 'failed-target').total, 0);
});

test('persists the bounded reason when DM delivery fails', async () => {
  let kickedReason;
  const target = {
    id: 'dm-failed-target',
    kickable: true,
    send: async () => { throw new Error('DMs disabled'); },
    kick: async reason => { kickedReason = reason; }
  };

  const result = await executeKick({
    guild: { id: 'guild', name: 'Guild' },
    target,
    moderator: { id: 'mod' },
    reason: 'x'.repeat(600)
  });

  const persistedReason = readInfractionsPage('guild', target.id).infractions[0].reason;
  assert.deepEqual(result, { success: true, dmDelivered: false });
  assert.equal(persistedReason, 'x'.repeat(512));
  assert.equal(kickedReason, persistedReason);
});

test('propagates persistence failure after a successful kick', async () => {
  let kicked = false;
  database.exec(`CREATE TRIGGER fail_kick_persistence
    BEFORE INSERT ON infractions BEGIN
      SELECT RAISE(ABORT, 'persistence failed');
    END`);

  try {
    await assert.rejects(executeKick({
      guild: { id: 'guild', name: 'Guild' },
      target: {
        id: 'persistence-failed-target',
        kickable: true,
        send: async () => {},
        kick: async () => { kicked = true; }
      },
      moderator: { id: 'mod' },
      reason: 'Spam'
    }), /persistence failed/);
    assert.equal(kicked, true);
    assert.equal(readInfractionsPage('guild', 'persistence-failed-target').total, 0);
  } finally {
    database.exec('DROP TRIGGER fail_kick_persistence');
  }
});

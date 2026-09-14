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

  const infraction = readInfractionsPage('guild', 'target').infractions[0];
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

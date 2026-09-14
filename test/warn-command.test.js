const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schmiks-warn-'));
process.env.CONFIG_PATH = path.join(directory, 'config.json');
process.env.DATABASE_PATH = path.join(directory, 'test.db');

const { readSlashCommands } = require('../config');
const { database, readInfractionsPage } = require('../database');
const { executeWarn, renderWarningTemplate } = require('../commands');

test.after(() => {
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('renders supported placeholders without changing unknown placeholders', () => {
  assert.equal(
    renderWarningTemplate('{server}: {reason} / {reason} by {moderator} {unknown}', {
      server: 'Guild', reason: 'Spam', moderator: 'Mod'
    }),
    'Guild: Spam / Spam by Mod {unknown}'
  );
});

test('persists a warning before delivering its configured DM', async () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    warningEmbed: {
      color: '#123456',
      title: '{server}',
      message: '{reason} by {moderator}'
    }
  }));
  let delivered;
  const target = {
    id: 'target-before-dm',
    send: async payload => {
      assert.equal(readInfractionsPage('guild', 'target-before-dm').total, 1);
      delivered = payload.embeds[0].toJSON();
    }
  };

  const result = await executeWarn({
    guild: { id: 'guild', name: 'G'.repeat(300) },
    target,
    moderator: { id: 'mod', tag: 'M'.repeat(4200) },
    reason: 'Spam'
  });

  assert.deepEqual(result, { success: true, dmDelivered: true });
  assert.equal(delivered.color, 0x123456);
  assert.equal(delivered.title.length, 256);
  assert.equal(delivered.description.length, 4096);
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

test('registers warn with required target and reason options', () => {
  const warn = readSlashCommands().find(command => command.name === 'warn');
  assert.ok(warn);
  assert.deepEqual(
    warn.options.map(({ name, type, required }) => ({ name, type, required })),
    [
      { name: 'target', type: 6, required: true },
      { name: 'reason', type: 3, required: true }
    ]
  );
});

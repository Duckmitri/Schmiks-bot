const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const discord = require('discord.js');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'schmiks-bot-events-'));
process.env.CONFIG_PATH = path.join(temporaryDirectory, 'config.json');
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'schmiks.db');
fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
  logging: { channelId: '12345678901234567', delivery: { messageDelete: true } }
}));
const { database, readMessageSnapshot } = require('../database');
const { snapshotMessage } = require('../event-logging');
const botPath = path.resolve(__dirname, '../bot.js');
const botRequire = createRequire(botPath);
let client;
class OfflineClient extends discord.Client {
  constructor(options) { super(options); client = this; }
  async login() {}
}
vm.runInNewContext(fs.readFileSync(botPath, 'utf8'), {
  require: name => name === 'discord.js' ? { ...discord, Client: OfflineClient } : botRequire(name),
  process: { env: { DISCORD_TOKEN: 'offline-test' } },
  console
}, { filename: botPath });

test.after(async () => {
  await client.destroy();
  database.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('bot enables uncached member departures while retaining message partials', async () => {
  assert.ok(client.options.partials.includes(discord.Partials.Message));
  const guild = client.guilds._add({ id: '12345678901234568', member_count: 1 });
  const { member } = client.actions.GuildMemberRemove.handle({
    guild_id: guild.id, user: { id: '12345678901234569', username: 'departed' }
  }, { status: discord.Status.Ready });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(member, 'uncached departure must produce a member');
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM general_events WHERE event_type = 'member_leave'").get().count, 1);
});

test('bulk deletions persist and deliver every message through the snapshot deletion path', async () => {
  const sent = [];
  const guild = { id: 'bulk-guild', channels: { cache: new Map([['12345678901234567', {
    isTextBased: () => true,
    send: async payload => sent.push(payload.embeds[0].toJSON())
  }]]) } };
  const messages = new discord.Collection();
  for (const id of ['bulk-one', 'bulk-two']) {
    const message = { id, guild, channelId: 'source', author: { id: 'author', bot: false }, content: `stored ${id}` };
    await snapshotMessage(message);
    messages.set(id, { ...message, content: 'stale gateway content' });
  }
  const listeners = client.listeners('messageDeleteBulk');
  assert.equal(listeners.length, 1, 'bulk delete listener must be registered');
  await listeners[0](messages);
  assert.deepEqual(database.prepare('SELECT message_id, before_content FROM message_events ORDER BY id').all(), [
    { message_id: 'bulk-one', before_content: 'stored bulk-one' },
    { message_id: 'bulk-two', before_content: 'stored bulk-two' }
  ]);
  assert.equal(sent.length, 2);
  for (const id of messages.keys()) {
    assert.ok(readMessageSnapshot(id, guild.id).deleted_at);
    assert.ok(sent.some(embed => embed.fields.some(field => field.value === `stored ${id}`)));
  }
});

test('a failed bulk item does not prevent later deletions from being persisted', async t => {
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  t.mock.method(console, 'warn', (...args) => errors.push(args));
  const broken = { get guild() { throw new Error('broken item'); } };
  const valid = { id: 'after-failure', guild: { id: 'bulk-guild' }, author: { id: 'author' }, content: 'survives' };
  const listeners = client.listeners('messageDeleteBulk');
  assert.equal(listeners.length, 1, 'bulk delete listener must be registered');
  await listeners[0](new discord.Collection([['broken', broken], [valid.id, valid]]));
  assert.equal(database.prepare('SELECT before_content FROM message_events WHERE message_id = ?').get(valid.id).before_content, 'survives');
  assert.ok(errors.some(args => args.some(value => value instanceof Error && value.message === 'broken item')));
});

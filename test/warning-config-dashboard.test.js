const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const configModule = path.join(root, 'config.js');
const serverModule = path.join(root, 'dashboard', 'server.js');
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'schmiks-warning-'));
process.env.CONFIG_PATH = path.join(tempDirectory, 'config.json');
delete require.cache[require.resolve(configModule)];
delete require.cache[require.resolve(serverModule)];

const {
  readLoggingConfig,
  readWarningEmbedConfig,
  validateWarningEmbedConfig,
  writeDashboardConfig
} = require(configModule);
const app = require(serverModule);

test.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));

test('validates and persists warning embed settings', () => {
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ links: [{ name: 'Docs', url: 'https://example.com' }] }));
  assert.deepEqual(readWarningEmbedConfig(), {
    color: '#FEE75C',
    title: 'Warning from {server}',
    message: '{reason}\n\nModerator: {moderator}'
  });
  assert.throws(
    () => validateWarningEmbedConfig({ color: 'yellow', title: 'Warn', message: '{reason}' }),
    /#RRGGBB/
  );
  assert.throws(
    () => validateWarningEmbedConfig({ color: '#FEE75C', title: ' ', message: '{reason}' }),
    /title/
  );
  assert.throws(
    () => validateWarningEmbedConfig({ color: '#FEE75C', title: 'Warn', message: ' ' }),
    /message/
  );

  const saved = writeDashboardConfig({
    prefix: '!', moderatorRoleIds: [], adminRoleIds: [],
    logging: readLoggingConfig(),
    warningEmbed: { color: '#ffcc00', title: '  {server} warning  ', message: '  {reason} — {moderator}  ' }
  });
  assert.deepEqual(saved.warningEmbed, {
    color: '#FFCC00', title: '{server} warning', message: '{reason} — {moderator}'
  });
  const persisted = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, 'utf8'));
  assert.deepEqual(persisted.warningEmbed, saved.warningEmbed);
  assert.deepEqual(persisted.links, [{ name: 'Docs', url: 'https://example.com' }]);
});

test('caps warning embed title and message lengths', () => {
  const result = validateWarningEmbedConfig({
    color: '#123abc',
    title: ` ${'t'.repeat(300)} `,
    message: ` ${'m'.repeat(4200)} `
  });
  assert.equal(result.title.length, 256);
  assert.equal(result.message.length, 4096);
  assert.equal(result.color, '#123ABC');
});

test('dashboard API round-trips warning embed settings', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const initial = await fetch(`${baseUrl}/api/config`).then(response => response.json());
    assert.deepEqual(initial.warningEmbed, {
      color: '#FFCC00', title: '{server} warning', message: '{reason} — {moderator}'
    });

    const response = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...initial,
        warningEmbed: { color: '#abcdef', title: 'API warning', message: '{reason}' }
      })
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).warningEmbed, {
      color: '#ABCDEF', title: 'API warning', message: '{reason}'
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('dashboard contains the infractions warning controls', () => {
  const html = fs.readFileSync(path.join(root, 'dashboard', 'public', 'index.html'), 'utf8');
  for (const value of ['href="#infractions"', 'id="infractions"', 'aria-label="Change warning color"', 'warningColor', 'warningTitle', 'warningMessage']) {
    assert.match(html, new RegExp(value));
  }
});

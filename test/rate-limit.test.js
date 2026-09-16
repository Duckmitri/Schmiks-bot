const assert = require('node:assert/strict');
const test = require('node:test');

const { createRateLimiter } = require('../rate-limit');

test('a user can act again after two seconds', () => {
  let now = 1_000;
  const allow = createRateLimiter(2_000, () => now);

  assert.equal(allow('user-1'), true);
  assert.equal(allow('user-1'), false);
  assert.equal(allow('user-2'), true);

  now = 3_000;
  assert.equal(allow('user-1'), true);
});

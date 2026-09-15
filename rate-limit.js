function createRateLimiter(windowMs, now = Date.now) {
  const expiresAt = new Map();
  let callCount = 0;
  const CLEAN_UP_INTERVAL = 1000;

  return key => {
    callCount++;
    if (callCount >= CLEAN_UP_INTERVAL) {
      callCount = 0;
      const current = now();
      for (const [entryKey, expiration] of expiresAt.entries()) {
        if (expiration <= current) {
          expiresAt.delete(entryKey);
        }
      }
    }

    const current = now();
    if ((expiresAt.get(key) ?? 0) > current) return false;
    expiresAt.set(key, current + windowMs);
    return true;
  };
}

module.exports = { createRateLimiter };

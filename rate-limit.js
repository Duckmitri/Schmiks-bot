function createRateLimiter(windowMs, now = Date.now) {
  const expiresAt = new Map();

  return key => {
    const current = now();
    if ((expiresAt.get(key) ?? 0) > current) return false;
    expiresAt.set(key, current + windowMs);
    return true;
  };
}

module.exports = { createRateLimiter };

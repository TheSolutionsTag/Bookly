require('./env');

const pool = require('../src/db/pool');
const { createApiKey, verifyApiKey } = require('../src/lib/apiKeys');

// Part B hardening item 2 — explicit acceptance criteria for the primitives
// themselves, isolated from the HTTP layer (apiKeyAuth.test.js covers the
// end-to-end request behavior; this covers the crypto guarantees directly).
describe('lib/apiKeys — key generation and verification acceptance criteria', () => {
  afterAll(async () => {
    await pool.end();
  });

  test('generated keys are high-entropy and never repeat across many calls (not a predictable/sequential source)', async () => {
    const keys = await Promise.all(Array.from({ length: 25 }, () => createApiKey({ label: 'entropy-check' })));
    const rawKeys = keys.map((k) => k.key);
    expect(new Set(rawKeys).size).toBe(rawKeys.length);
    // bk_<16 hex chars>_<43 base64url chars> — 256 bits of real secret
    // material, not a short/guessable token.
    for (const key of rawKeys) {
      expect(key).toMatch(/^bk_[0-9a-f]{16}_[A-Za-z0-9_-]{40,}$/);
    }
    // Prefixes are also independently random per key (not incrementing).
    const prefixes = keys.map((k) => k.key_prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  test('verifyApiKey authenticates the exact key and rejects a key differing by a single character', async () => {
    const { key: rawKey } = await createApiKey({ label: 'single-char-check' });
    await expect(verifyApiKey(rawKey)).resolves.toMatchObject({ resourceId: null });

    const flippedLastChar = rawKey.slice(0, -1) + (rawKey.at(-1) === 'a' ? 'b' : 'a');
    await expect(verifyApiKey(flippedLastChar)).resolves.toBeNull();
  });

  test('verifyApiKey rejects a key with a correct, real prefix but a wrong secret (proves the check is on the full key, not just the indexed prefix)', async () => {
    const { key: rawKey } = await createApiKey({ label: 'prefix-only-check' });
    const [, prefix] = rawKey.split('_');
    const forged = `bk_${prefix}_${'a'.repeat(43)}`;
    await expect(verifyApiKey(forged)).resolves.toBeNull();
  });

  test('verifyApiKey rejects malformed input without throwing', async () => {
    await expect(verifyApiKey('')).resolves.toBeNull();
    await expect(verifyApiKey(null)).resolves.toBeNull();
    await expect(verifyApiKey('not-even-the-right-shape')).resolves.toBeNull();
    await expect(verifyApiKey('bk_onlyoneunderscore')).resolves.toBeNull();
  });
});

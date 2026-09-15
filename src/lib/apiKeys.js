const crypto = require('crypto');
const pool = require('../db/pool');

// bk_<16-char-hex-prefix>_<43-char-base64url-secret> - the prefix is a
// non-secret index accelerator (so verifyApiKey doesn't scan every row);
// the part after it is the actual 256 bits of entropy that makes the key
// unguessable. crypto.randomBytes is a CSPRNG - never Math.random or any
// other predictable/sequential source.
const PREFIX_BYTES = 8;
const SECRET_BYTES = 32;

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest();
}

// Returns the raw key exactly once - callers must show it to the user
// immediately and never persist or log it. Only key_hash (never the raw
// value) is written to the database.
async function createApiKey({ label, resourceId = null, createdBy = null }) {
  const prefix = crypto.randomBytes(PREFIX_BYTES).toString('hex');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const rawKey = `bk_${prefix}_${secret}`;
  const keyHash = hashKey(rawKey).toString('hex');

  const { rows } = await pool.query(
    `INSERT INTO api_keys (key_hash, key_prefix, label, resource_id, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, key_prefix, label, resource_id, created_at`,
    [keyHash, prefix, label, resourceId, createdBy]
  );

  return { ...rows[0], key: rawKey };
}

// Looked up by the non-secret prefix (an indexed equality lookup - not a
// secret comparison, so no timing concern there), then the FULL computed
// hash is compared against the stored hash with crypto.timingSafeEqual -
// never a plain `===`/string-equality check on the hash, which could leak
// which byte first differs through comparison timing.
async function verifyApiKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string' || !rawKey.startsWith('bk_')) return null;
  const parts = rawKey.split('_');
  if (parts.length < 3) return null;
  const prefix = parts[1];

  const { rows } = await pool.query(
    `SELECT id, key_hash, resource_id, revoked_at FROM api_keys WHERE key_prefix = $1`,
    [prefix]
  );
  if (rows.length === 0) return null;

  const candidateHash = hashKey(rawKey);
  const row = rows.find((r) => {
    const storedHash = Buffer.from(r.key_hash, 'hex');
    return storedHash.length === candidateHash.length && crypto.timingSafeEqual(storedHash, candidateHash);
  });
  if (!row) return null;

  // Revocation is checked on THIS lookup, every time - never cached. Every
  // request re-runs verifyApiKey (see middleware/apiKeyAuth.js), so a key
  // revoked mid-session is rejected on its very next request, not just the
  // one it happened to be revoked during.
  if (row.revoked_at) return null;

  // Fire-and-forget - a slow/failed audit write must never block or fail
  // the authenticated request itself.
  pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => {});

  return { id: row.id, resourceId: row.resource_id };
}

async function revokeApiKey(id) {
  const { rows } = await pool.query(
    `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [id]
  );
  return rows.length > 0;
}

async function listApiKeys() {
  const { rows } = await pool.query(
    `SELECT id, key_prefix, label, resource_id, created_at, last_used_at, revoked_at
     FROM api_keys ORDER BY created_at DESC`
  );
  return rows;
}

module.exports = { createApiKey, verifyApiKey, revokeApiKey, listApiKeys };

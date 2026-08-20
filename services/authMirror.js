'use strict';

/**
 * authMirror — keep password-reset writes consistent across BOTH stores (Firestore + Postgres).
 *
 * Why: the web (dineopen.com) runs on the Firestore backend and the desktop/LAN app's online mode
 * runs on the Postgres backend. A reset token minted on one backend, or a new password set on one,
 * would otherwise be invisible to the other — so the emailed link (or a later login) could fail
 * depending on which backend the user lands on. This mirrors the token and the new password to the
 * OTHER store too, so forgot/reset-password works irrespective of which link/backend is used.
 *
 * Fully best-effort: a mirror failure NEVER throws (the primary write already succeeded). The same
 * module runs on both branches — on each, one side is the primary (already written) and the other is
 * the mirror; re-writing the primary is idempotent and harmless.
 *
 * Deploy config:
 *   - Firestore backend (main): set MIRROR_DATABASE_URL (or CLOUD_DATABASE_URL) → the cloud Postgres.
 *   - Postgres backend (pg):    Firebase creds must be present so getFirestoreDb() is a real handle.
 * If the counterpart store isn't configured, the mirror simply no-ops (logged once).
 */
const firebase = require('../firebase');

// Raw Firestore handle: pg branch exposes getFirestoreDb() (bypasses the pgAdapter); on the
// Firestore branch `db` already IS Firestore.
function rawFirestore() {
  try {
    if (typeof firebase.getFirestoreDb === 'function') return firebase.getFirestoreDb();
    return firebase.db;
  } catch (_) { return null; }
}

let _pool = null;
let _pgUnavailable = false;
function pgPool() {
  if (_pgUnavailable) return null;
  const url = process.env.MIRROR_DATABASE_URL || process.env.CLOUD_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) return null;
  if (!_pool) {
    // Lazy require so the Firestore-only backend (which may not bundle `pg`) never crashes on load;
    // the Postgres mirror simply no-ops there until `pg` + a mirror URL are present.
    let Pool;
    try { ({ Pool } = require('pg')); } catch (_) { _pgUnavailable = true; console.warn('[authMirror] pg not installed — Postgres mirror disabled'); return null; }
    _pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 6000, statement_timeout: 8000 });
  }
  return _pool;
}

const USERS_COLLECTION = (firebase.collections && firebase.collections.users) || 'users';

// Write a set of user fields to Firestore (by email). Firestore field names (camelCase).
async function _firestoreUpdate(email, fields) {
  try {
    const fdb = rawFirestore();
    if (!fdb || typeof fdb.collection !== 'function') return;
    const snap = await fdb.collection(USERS_COLLECTION).where('email', '==', email).limit(1).get();
    if (snap.empty) return;
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (Object.keys(clean).length) await snap.docs[0].ref.update(clean);
  } catch (e) { console.warn('[authMirror] Firestore mirror failed:', e.message); }
}

// Write to Postgres app_users (by email). `password` is a real column; the ephemeral reset-token
// fields live in extra_data JSONB (matching how the pgAdapter stores unmapped fields), so pg's
// reset-password lookup (extra_data->>'resetTokenHash') finds a token minted on the other backend.
async function _postgresUpdate(email, { password, tokenJson }) {
  const pool = pgPool();
  if (!pool) return;
  try {
    const sets = [];
    const args = [email];
    if (password !== undefined) { args.push(password); sets.push(`password = $${args.length}`); }
    if (tokenJson) { args.push(JSON.stringify(tokenJson)); sets.push(`extra_data = COALESCE(extra_data, '{}'::jsonb) || $${args.length}::jsonb`); }
    if (!sets.length) return;
    await pool.query(`UPDATE app_users SET ${sets.join(', ')} WHERE lower(email) = lower($1)`, args);
  } catch (e) { console.warn('[authMirror] Postgres mirror failed:', e.message); }
}

// Mirror the reset TOKEN to both stores so the emailed link is valid on whichever backend opens it.
async function mirrorResetToken(email, { resetTokenHash, resetTokenExpiry, resetRequestedAt } = {}) {
  if (!email) return;
  const em = String(email).toLowerCase().trim();
  await Promise.allSettled([
    _firestoreUpdate(em, { resetTokenHash, resetTokenExpiry, resetTokenUsed: false, resetRequestedAt: resetRequestedAt || new Date() }),
    _postgresUpdate(em, { tokenJson: { resetTokenHash, resetTokenExpiry, resetTokenUsed: false } }),
  ]);
}

// Mirror the NEW PASSWORD (+ single-use token invalidation) to both stores so the user can log in
// on either backend afterwards.
async function mirrorNewPassword(email, hashedPassword) {
  if (!email || !hashedPassword) return;
  const em = String(email).toLowerCase().trim();
  await Promise.allSettled([
    _firestoreUpdate(em, { password: hashedPassword, resetTokenUsed: true, resetTokenHash: null, resetTokenExpiry: null, passwordChangedAt: new Date() }),
    _postgresUpdate(em, { password: hashedPassword, tokenJson: { resetTokenUsed: true, resetTokenHash: null, resetTokenExpiry: null } }),
  ]);
}

module.exports = { mirrorResetToken, mirrorNewPassword };

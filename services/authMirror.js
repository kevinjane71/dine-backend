'use strict';

/**
 * authMirror — keep password-reset writes consistent across BOTH backends, over a SIGNED HTTP call.
 *
 * The web runs on the Firestore backend and the app's online mode on the Postgres backend. A reset
 * token minted on one, or a password set on one, is otherwise invisible to the other. Rather than
 * give each backend a driver + credentials for the OTHER database (shipping a Postgres client to the
 * Vercel/Firestore deploy and opening Cloud SQL to it — unreliable + slow), each backend calls the
 * COUNTERPART backend's `/api/auth/internal-mirror`, which writes to ITS OWN database.
 *
 * Security: the request is authenticated with an HMAC-SHA256 signature over (timestamp + fields),
 * keyed by a shared MIRROR_SECRET. The secret itself is NEVER transmitted; the timestamp makes a
 * captured request unreplayable outside a ±5-minute window; the receiver compares in constant time.
 *
 * Config (per deploy): MIRROR_API_URL = counterpart base URL, MIRROR_SECRET = shared secret.
 * Dormant (no-op) if either is unset. Fully best-effort + 5s-bounded — never throws or hangs the
 * primary forgot/reset flow.
 */
const crypto = require('crypto');

// Deterministic string signed by BOTH sides — must be built identically here and in the endpoint.
// `v ?? ''` collapses undefined AND null to '' so the JSON round-trip (which drops undefined and
// keeps null) can't change the signed value.
function canonical(ts, x) {
  return [ts, x.email, x.password, x.resetTokenHash, x.resetTokenExpiry, x.resetTokenUsed]
    .map((v) => String(v ?? '')).join('|');
}

async function post(fields) {
  const url = (process.env.MIRROR_API_URL || '').replace(/\/+$/, '');
  const secret = process.env.MIRROR_SECRET || '';
  if (!url || !secret) return; // counterpart not configured → dormant
  const ts = String(Date.now());
  const sign = crypto.createHmac('sha256', secret).update(canonical(ts, fields)).digest('hex');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000); // never hang the caller
  try {
    const r = await fetch(`${url}/api/auth/internal-mirror`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'x-mirror-ts': ts, 'x-mirror-sign': sign },
      body: JSON.stringify(fields),
    });
    if (!r.ok) console.warn('[authMirror] mirror HTTP', r.status);
  } catch (e) {
    console.warn('[authMirror] mirror failed:', e.message);
  } finally {
    clearTimeout(timer);
  }
}

// Mirror the reset TOKEN to the counterpart so the emailed link validates on whichever backend opens it.
async function mirrorResetToken(email, { resetTokenHash, resetTokenExpiry } = {}) {
  if (!email) return;
  await post({ email: String(email).toLowerCase().trim(), resetTokenHash, resetTokenExpiry, resetTokenUsed: false });
}

// Mirror the NEW PASSWORD (+ single-use token invalidation) so the user can log in on either backend.
async function mirrorNewPassword(email, hashedPassword) {
  if (!email || !hashedPassword) return;
  await post({ email: String(email).toLowerCase().trim(), password: hashedPassword, resetTokenUsed: true, resetTokenHash: null, resetTokenExpiry: null });
}

module.exports = { mirrorResetToken, mirrorNewPassword };

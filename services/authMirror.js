'use strict';

/**
 * authMirror — keep password-reset writes consistent across BOTH backends, over HTTP.
 *
 * The web runs on the Firestore backend and the app's online mode on the Postgres backend. A reset
 * token minted on one, or a password set on one, is otherwise invisible to the other. Rather than
 * give each backend a driver + credentials for the OTHER database (e.g. shipping a Postgres client
 * to the Vercel/Firestore deploy and opening Cloud SQL to it — unreliable + slow), each backend
 * simply calls the COUNTERPART backend's `/api/auth/internal-mirror` endpoint, which writes to ITS
 * OWN database. So the mirror needs nothing but an HTTP request.
 *
 * Config (per deploy): MIRROR_API_URL = the counterpart backend's base URL, MIRROR_SECRET = a shared
 * secret both backends hold. Dormant (no-op) if either is unset. Fully best-effort + time-bounded —
 * a mirror failure NEVER throws, so the primary forgot/reset flow is never broken or slowed beyond
 * the bounded timeout.
 */

async function post(fields) {
  const url = (process.env.MIRROR_API_URL || '').replace(/\/+$/, '');
  const secret = process.env.MIRROR_SECRET || '';
  if (!url || !secret) return; // counterpart not configured → dormant
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000); // never hang the caller
  try {
    const r = await fetch(`${url}/api/auth/internal-mirror`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'x-mirror-secret': secret },
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

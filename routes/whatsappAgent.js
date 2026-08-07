/**
 * WhatsApp AI agent for the DineOpen sales/support number.
 * ---------------------------------------------------------------------------
 * FULLY ISOLATED + FLAG-GATED. It runs only when WA_AI_AGENT_ENABLED === 'true'
 * and is invoked from the webhook inside a single try/catch, so it can NEVER
 * break the existing inbox/lead flow. Default OFF.
 *
 * Behaviour (per product spec):
 *  - Acts ONLY on the DineOpen number's conversations (general leads), inside WA's
 *    24-hour service window (free-form replies).
 *  - Human-feel: replies are DEBOUNCED ~10 min after the customer stops messaging,
 *    sent by a cron (serverless can't hold a timer). Each new message pushes the
 *    reply time out, so we answer once, ~10 min after they finish.
 *  - Intent "menu setup" / greeting / mentions "menu"  ->  AUTO short reply asking
 *    for menu photos/PDF ("send your menu, we'll set up your account").
 *  - Menu photo/PDF received  ->  AUTO in background: ensure an account for THIS
 *    number (create if new, under their name + full phone), then AI-upload the menu
 *    to it via the existing /bulk-upload endpoint, then confirm.
 *  - Any OTHER question  ->  AI DRAFTS a reply and stores it for admin approval;
 *    it is NEVER auto-sent.
 *  - Request to use a DIFFERENT number  ->  escalated for admin approval, never auto.
 *
 * Tenant safety: the account/menu is always tied to the sender's phone (from the
 * webhook, never chosen by the AI).
 *
 * State: Firestore collection `wa_agent_state`, doc id = sender phone (digits only).
 */
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { getDb, collections } = require('../firebase');

// Mint a service JWT for a resolved account so the agent can act AS that owner on the
// existing authed endpoints (bulk-upload, restaurant-create) without their password.
// Same payload shape the app signs ({userId,email,role}) so authenticateToken accepts it.
// Short-lived — only used for this one automated onboarding action.
function mintToken(user) {
  return jwt.sign(
    { userId: user.userId, email: user.email || null, role: user.role || 'owner' },
    process.env.JWT_SECRET,
    { expiresIn: '2h' }
  );
}

const STATE_COLLECTION = 'wa_agent_state';
const DELAY_MS = parseInt(process.env.WA_AGENT_DELAY_MS, 10) || 10 * 60 * 1000; // ~10 min debounce
const HISTORY_MAX = 20;
const INTERNAL_BASE = process.env.BACKEND_URL || `http://127.0.0.1:${process.env.PORT || 3003}`;

const isEnabled = () => process.env.WA_AI_AGENT_ENABLED === 'true';
const isDineOpenNumber = (phoneNumberId) =>
  !!phoneNumberId && phoneNumberId === process.env.DINEOPEN_WHATSAPP_PHONE_NUMBER_ID;

const digits = (s) => String(s || '').replace(/\D/g, '');

function waCreds() {
  return {
    accessToken: process.env.DINEOPEN_WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: process.env.DINEOPEN_WHATSAPP_PHONE_NUMBER_ID,
    businessAccountId: process.env.DINEOPEN_WHATSAPP_BUSINESS_ACCOUNT_ID,
  };
}

async function sendReply(toPhone, text) {
  const whatsappService = require('../services/whatsappService');
  await whatsappService.sendTextMessage(toPhone, text, waCreds());
  // Mirror to the admin inbox log so it shows in the WhatsApp tab.
  try {
    await getDb().collection(collections.automationLogs).add({
      type: 'outgoing', direction: 'outgoing', phone: digits(toPhone),
      message: text, messageType: 'text', by: 'ai-agent',
      timestamp: new Date(), status: 'sent', restaurantId: null,
    });
  } catch (_) {}
}

// Download a WhatsApp media object (image/document) as a Buffer + mime + name.
async function downloadMedia(mediaId) {
  const token = process.env.DINEOPEN_WHATSAPP_ACCESS_TOKEN;
  const meta = await axios.get(`https://graph.facebook.com/v22.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` }, timeout: 20000,
  });
  const url = meta.data.url;
  const mime = meta.data.mime_type || 'image/jpeg';
  const bin = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer', timeout: 30000,
  });
  const ext = mime.includes('pdf') ? 'pdf' : (mime.split('/')[1] || 'jpg');
  return { buffer: Buffer.from(bin.data), mime, name: `menu-${mediaId}.${ext}` };
}

// ── State helpers ──────────────────────────────────────────────────────────
async function loadState(phone) {
  const ref = getDb().collection(STATE_COLLECTION).doc(digits(phone));
  const snap = await ref.get();
  return { ref, data: snap.exists ? snap.data() : null };
}

// ── Entry point from the webhook (per inbound message) ──────────────────────
async function onInbound({ message, contact, phoneNumberId }) {
  if (!isEnabled() || !isDineOpenNumber(phoneNumberId)) return;
  if (!message || !message.from) return;

  const phone = digits(message.from);
  const name = contact?.profile?.name || '';
  const text = message.text?.body
    || message.interactive?.list_reply?.title
    || message.interactive?.button_reply?.title
    || message.button?.text || '';

  // Menu media = an image or a PDF/document.
  const media = [];
  if (message.type === 'image' && message.image?.id) media.push({ id: message.image.id, kind: 'image' });
  if (message.type === 'document' && message.document?.id) media.push({ id: message.document.id, kind: 'document' });

  const { ref, data } = await loadState(phone);
  const state = data || { phone, name, stage: 'new', history: [], pendingMedia: [], createdAt: new Date() };
  if (name && !state.name) state.name = name;

  state.history = [...(state.history || []), { role: 'user', text, at: Date.now() }].slice(-HISTORY_MAX);
  if (media.length) {
    state.pendingMedia = [...(state.pendingMedia || []), ...media];
    state.stage = 'menu_media';
  }
  // Debounce: (re)schedule the reply ~10 min after this latest message.
  state.replyDueAt = new Date(Date.now() + DELAY_MS);
  state.status = 'pending';
  state.updatedAt = new Date();
  await ref.set(state, { merge: true });
}

// ── Cron: process conversations whose debounce timer is due ─────────────────
// Wire a Cloud Scheduler job every 1 min -> POST /api/whatsapp-ordering/agent/process-due
async function processDue() {
  if (!isEnabled()) return { processed: 0, skipped: 'disabled' };
  const db = getDb();
  const now = new Date();
  const dueSnap = await db.collection(STATE_COLLECTION)
    .where('status', '==', 'pending')
    .where('replyDueAt', '<=', now)
    .limit(20).get();

  let processed = 0;
  for (const doc of dueSnap.docs) {
    const state = doc.data();
    // Claim it so overlapping cron ticks don't double-send.
    await doc.ref.set({ status: 'processing', replyDueAt: null }, { merge: true });
    try {
      if ((state.pendingMedia || []).length > 0) {
        await runMenuFlow(doc.ref, state);
      } else {
        await runReplyFlow(doc.ref, state);
      }
      processed++;
    } catch (e) {
      console.error('[wa-agent] processDue error for', state.phone, e.message);
      await doc.ref.set({ status: 'idle', lastError: e.message }, { merge: true });
    }
  }
  return { processed };
}

// Reply flow (no media): classify intent, then auto-reply or draft-for-approval.
async function runReplyFlow(ref, state) {
  const intent = await classifyIntent(state);
  if (intent.type === 'menu_setup' || intent.type === 'greeting') {
    await sendReply(state.phone,
      "Hi! 👋 To set up your restaurant on DineOpen, just send your *menu photos or PDF* here. " +
      "We'll create your account on this number and add your menu — then you can start using it right away.");
    await ref.set({ status: 'idle', stage: 'awaiting_menu', updatedAt: new Date() }, { merge: true });
    return;
  }
  if (intent.type === 'different_number') {
    // Never auto-act on a different number — escalate for admin approval.
    await ref.set({
      status: 'needs_approval',
      draft: { text: intent.draft || '', reason: 'customer asked to use a different number', createdAt: new Date() },
      updatedAt: new Date(),
    }, { merge: true });
    return;
  }
  // Any OTHER question -> draft a reply for the admin to approve (never auto-send).
  await ref.set({
    status: 'needs_approval',
    draft: { text: intent.draft || '', reason: 'general question', createdAt: new Date() },
    updatedAt: new Date(),
  }, { merge: true });
}

// Menu flow (media present): ensure account for this phone, then AI-upload the menu.
async function runMenuFlow(ref, state) {
  const phone = state.phone;
  // 1. Ensure an account exists for THIS number (create if new).
  const acct = await resolveOrCreateAccount(phone, state.name);
  if (!acct || !acct.restaurantId || !acct.token) {
    await sendReply(phone, "Thanks! We received your menu — our team will finish setting up your account shortly.");
    await ref.set({ status: 'needs_approval', draft: { reason: 'account setup needs review', createdAt: new Date() }, updatedAt: new Date() }, { merge: true });
    return;
  }
  // 2. Download the menu media and AI-upload it to THIS restaurant only.
  const files = [];
  for (const m of (state.pendingMedia || []).slice(0, 10)) {
    try { files.push(await downloadMedia(m.id)); } catch (e) { console.error('[wa-agent] media dl failed', e.message); }
  }
  let added = 0;
  if (files.length) {
    added = await uploadMenu(acct.restaurantId, acct.token, files);
  }
  // 3. Confirm.
  await sendReply(phone, added > 0
    ? `✅ Done! Your account is ready and ${added} items were added from your menu. You can start using DineOpen now — we'll message your login details next.`
    : `✅ Your account is ready! We couldn't read items automatically from that file — please resend a clearer menu photo/PDF and we'll add them.`);
  await ref.set({ status: 'idle', stage: 'onboarded', resolvedRestaurantId: acct.restaurantId, pendingMedia: [], updatedAt: new Date() }, { merge: true });
}

// ── Intent classification + draft (OpenAI) ──────────────────────────────────
async function classifyIntent(state) {
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const history = (state.history || []).map(h => `${h.role}: ${h.text}`).join('\n').slice(-2000);
    const sys = `You are DineOpen's WhatsApp assistant. Classify the customer's latest intent and, ONLY for a general question, draft a SHORT helpful reply (1-3 sentences, friendly, no emojis spam).
Return strict JSON: {"type":"menu_setup|greeting|other|different_number","draft":"..."}.
- "menu_setup": they want to set up / add / upload their menu, or mention menu.
- "greeting": hi/hello/interested with no specific question.
- "different_number": they ask to register/use a phone number different from the one they are messaging from.
- "other": any other question (pricing, features, support, etc.) — put your drafted reply in "draft".`;
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: history }],
      response_format: { type: 'json_object' }, temperature: 0.3, max_tokens: 300,
    });
    const parsed = JSON.parse(res.choices[0].message.content || '{}');
    if (!['menu_setup', 'greeting', 'other', 'different_number'].includes(parsed.type)) parsed.type = 'other';
    return parsed;
  } catch (e) {
    console.error('[wa-agent] classify failed, defaulting to draft-for-approval:', e.message);
    return { type: 'other', draft: '' };
  }
}

// ── Account resolve/create (reuses existing endpoints — no schema reimplementation)
async function resolveOrCreateAccount(phone, name) {
  const db = getDb();
  // 1. Already registered on this phone? -> mint a token for that owner (works for
  //    ANY existing account, WA-created or not — fixes the "returning account" gap).
  const existing = await db.collection(collections.users).where('phone', '==', phone).limit(1).get();
  if (!existing.empty) {
    const doc = existing.docs[0];
    const d = doc.data();
    const token = mintToken({ userId: doc.id, email: d.email, role: d.role });
    let restaurantId = await findRestaurantId(doc.id);
    if (!restaurantId) {
      // account exists but no restaurant yet -> create one with the minted token
      const rest = await internalPost('/api/restaurants', { name: name || d.name || `Restaurant ${phone.slice(-4)}`, phone, businessType: 'restaurant' }, token);
      restaurantId = rest?.restaurant?.id || rest?.id || null;
    }
    return restaurantId ? { userId: doc.id, restaurantId, token } : null;
  }
  // 2. New: create the account via the real register endpoint, then MINT our own token
  //    (don't depend on register's response containing one), then create the restaurant.
  const email = `wa${phone}@wa.dineopen.com`;
  const password = `Wa!${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  const displayName = name || `Restaurant ${phone.slice(-4)}`;
  const reg = await internalPost('/api/auth/register', {
    email, password, name: displayName, phone, restaurantName: displayName, role: 'owner', source: 'whatsapp',
  });
  // Resolve the new userId (from the response, else look it up by the email we just used).
  let userId = reg?.userId || reg?.user?.id || null;
  if (!userId) {
    const u = await db.collection(collections.users).where('email', '==', email).limit(1).get();
    if (!u.empty) userId = u.docs[0].id;
  }
  if (!userId) return null;
  const token = mintToken({ userId, email, role: 'owner' });
  let restaurantId = reg?.restaurant?.id || reg?.restaurantId || await findRestaurantId(userId);
  if (!restaurantId) {
    const rest = await internalPost('/api/restaurants', { name: displayName, phone, businessType: 'restaurant' }, token);
    restaurantId = rest?.restaurant?.id || rest?.id || null;
  }
  return restaurantId ? { userId, restaurantId, token } : null;
}

async function findRestaurantId(userId) {
  const db = getDb();
  try {
    const links = await db.collection(collections.userRestaurants).where('userId', '==', userId).limit(1).get();
    if (!links.empty) return links.docs[0].data().restaurantId;
  } catch (_) {}
  try {
    const rs = await db.collection(collections.restaurants).where('ownerId', '==', userId).limit(1).get();
    if (!rs.empty) return rs.docs[0].id;
  } catch (_) {}
  return null;
}

async function uploadMenu(restaurantId, token, files) {
  try {
    const FormData = require('form-data');
    const form = new FormData();
    for (const f of files) form.append('menuFiles', f.buffer, { filename: f.name, contentType: f.mime });
    const res = await axios.post(`${INTERNAL_BASE}/api/menus/bulk-upload/${restaurantId}`, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
      timeout: 120000, maxBodyLength: Infinity, maxContentLength: Infinity,
    });
    return res.data?.itemsAdded ?? res.data?.count ?? (res.data?.menuItems?.length) ?? 0;
  } catch (e) {
    console.error('[wa-agent] uploadMenu failed:', e.response?.data?.error || e.message);
    return 0;
  }
}

async function internalPost(path, body, token) {
  try {
    const res = await axios.post(`${INTERNAL_BASE}${path}`, body, {
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      timeout: 30000,
    });
    return res.data;
  } catch (e) {
    console.error(`[wa-agent] POST ${path} failed:`, e.response?.data?.error || e.message);
    return null;
  }
}
module.exports = { onInbound, processDue, isEnabled, mintToken, resolveOrCreateAccount };

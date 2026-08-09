/**
 * WhatsApp AI agent for the DineOpen sales/support number.
 * ---------------------------------------------------------------------------
 * FULLY ISOLATED + FLAG-GATED. It is ENABLED BY DEFAULT (live) and only disabled
 * when WA_AI_AGENT_ENABLED === 'false'. It is invoked from the webhook inside a
 * single try/catch, so it can NEVER break the existing inbox/lead flow.
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

// Roles the agent must NEVER auto-act on / mint a token for (privilege-escalation guard).
const ELEVATED_ROLES = new Set(['super-admin', 'admin', 'sub-admin']);

// Mint a service JWT for a resolved account so the agent can act AS that owner on the
// existing authed endpoints (bulk-upload, restaurant-create) without their password.
// SECURITY: role is FORCED to 'owner' (never elevated) + a `via:'wa-agent'` audit claim,
// and it's very short-lived (15 min) — just long enough for the one onboarding action.
// Ownership checks on the endpoints still scope it to that user's own restaurant only.
function mintToken(user) {
  return jwt.sign(
    { userId: user.userId, email: user.email || null, role: 'owner', via: 'wa-agent' },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
}

// ── Per-phone daily rate limits (abuse guard on the automated actions) ───────
const RL = {
  replies: parseInt(process.env.WA_AGENT_MAX_REPLIES_DAY, 10) || 15,
  menus: parseInt(process.env.WA_AGENT_MAX_MENUS_DAY, 10) || 3,
  accounts: parseInt(process.env.WA_AGENT_MAX_ACCOUNTS_DAY, 10) || 1,
};
function todayStr() { const d = new Date(); return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`; }
// Returns { ok, rl } — increments `kind` for today if under the cap.
function checkRate(state, kind) {
  const day = todayStr();
  const rl = (state.rl && state.rl.day === day) ? { ...state.rl } : { day, replies: 0, menus: 0, accounts: 0 };
  if ((rl[kind] || 0) >= (RL[kind] || 0)) return { ok: false, rl };
  rl[kind] = (rl[kind] || 0) + 1;
  return { ok: true, rl };
}

const STATE_COLLECTION = 'wa_agent_state';
const DELAY_MS = parseInt(process.env.WA_AGENT_DELAY_MS, 10) || 10 * 60 * 1000; // ~10 min debounce
const HISTORY_MAX = 20;
const INTERNAL_BASE = process.env.BACKEND_URL || `http://127.0.0.1:${process.env.PORT || 3003}`;

const isEnabled = () => process.env.WA_AI_AGENT_ENABLED !== 'false';
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
  const now = Date.now();
  // Query by status only (single-field = auto-indexed) and filter replyDueAt in JS.
  // A compound where(status)+where(replyDueAt) needs a composite index that isn't
  // provisioned — without it the whole cron query throws and NO reply ever sends.
  const pendingSnap = await db.collection(STATE_COLLECTION)
    .where('status', '==', 'pending')
    .limit(50).get();
  const dueDocs = pendingSnap.docs.filter((d) => {
    const r = d.data().replyDueAt;
    const t = r?.toDate ? r.toDate().getTime() : (r ? new Date(r).getTime() : 0);
    return t && t <= now;
  }).slice(0, 20);

  let processed = 0;
  for (const doc of dueDocs) {
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

const SETUP_PROMPT =
  "Hi! 👋 Welcome to DineOpen. To finish setting up your restaurant, just send your *menu photos or PDF* here — " +
  "we'll add all the items to your menu automatically and you can start using it right away.";

// Reply flow (no media): classify intent, then auto-reply ONLY for genuine DineOpen prospects.
// The shared number also carries restaurants' own diners, so we stay silent for them.
async function runReplyFlow(ref, state) {
  const ctx = await lookupPhoneContext(state.phone);
  const intent = await classifyIntent(state, ctx);

  // (1) Restaurant's own diner reaching us via the shared number → NEVER auto-reply. Stay silent
  //     so we don't spam a restaurant's customer with a DineOpen sales pitch.
  if (intent.type === 'restaurant_customer') {
    await ref.set({ status: 'idle', stage: 'ignored_diner', updatedAt: new Date() }, { merge: true });
    return;
  }

  // (2) Clear DineOpen prospect/owner (or an explicit menu-setup / signup) → auto-help.
  const isSignup = intent.type === 'dineopen_signup' || intent.type === 'menu_setup';
  // A bare "greeting" is only auto-answered when it does NOT look like a diner (i.e. the phone is
  // not a known restaurant customer, or it IS a DineOpen owner). Otherwise treat it as a diner.
  const greetingFromLead = intent.type === 'greeting' && (ctx.isDineOpenOwner || !ctx.isRestaurantCustomer);

  if (isSignup || greetingFromLead) {
    const { ok, rl } = checkRate(state, 'replies');
    if (!ok) { await ref.set({ status: 'idle', rl, updatedAt: new Date() }, { merge: true }); return; } // over daily cap -> silent
    // Use the model's personalized welcome (acknowledges their restaurant name) when it drafted one,
    // else fall back to the standard setup prompt.
    const reply = (isSignup && intent.draft && intent.draft.trim()) ? intent.draft.trim() : SETUP_PROMPT;
    await sendReply(state.phone, reply);
    await ref.set({ status: 'idle', stage: 'awaiting_menu', rl, updatedAt: new Date() }, { merge: true });
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

  // (3) A greeting that looks like it's from a diner → stay silent (don't draft noise).
  if (intent.type === 'greeting') {
    await ref.set({ status: 'idle', stage: 'ignored_diner', updatedAt: new Date() }, { merge: true });
    return;
  }

  // (4) Any OTHER genuine DineOpen question -> draft a reply for the admin to approve (never auto-send).
  await ref.set({
    status: 'needs_approval',
    draft: { text: intent.draft || '', reason: 'general question', createdAt: new Date() },
    updatedAt: new Date(),
  }, { merge: true });
}

// Menu flow (media present): ensure account for this phone, then AI-upload the menu.
async function runMenuFlow(ref, state) {
  const phone = state.phone;

  // Shared-number guard: a restaurant's diner may send an image (a food photo, a receipt) that is
  // NOT a menu for onboarding. Only auto-create an account + upload when the sender looks like a
  // DineOpen prospect/owner — never for someone who only appears as a restaurant's customer.
  const ctx = await lookupPhoneContext(phone);
  if (!ctx.isDineOpenOwner && ctx.isRestaurantCustomer) {
    const intent = await classifyIntent(state, ctx);
    const looksLikeSetup = intent.type === 'dineopen_signup' || intent.type === 'menu_setup';
    if (!looksLikeSetup) {
      // Treat as a diner's image → do not onboard, do not reply. Drop the pending media.
      await ref.set({ status: 'idle', stage: 'ignored_diner', pendingMedia: [], updatedAt: new Date() }, { merge: true });
      return;
    }
  }

  // Abuse guard: cap automated menu processing per phone per day.
  const { ok, rl } = checkRate(state, 'menus');
  if (!ok) {
    await sendReply(phone, "Thanks! We've received your menus — our team will finish setting up your account shortly.");
    await ref.set({ status: 'needs_approval', rl, draft: { reason: 'menu rate limit hit', createdAt: new Date() }, pendingMedia: [], updatedAt: new Date() }, { merge: true });
    return;
  }
  // 1. Ensure an account exists for THIS number (create if new).
  const acct = await resolveOrCreateAccount(phone, state.name);
  if (acct && acct.escalate) {
    // privileged account matched this phone -> never auto-act; hand to a human.
    await ref.set({ status: 'needs_approval', rl, draft: { reason: 'privileged account matched — manual setup', createdAt: new Date() }, updatedAt: new Date() }, { merge: true });
    return;
  }
  if (!acct || !acct.restaurantId || !acct.token) {
    await sendReply(phone, "Thanks! We received your menu — our team will finish setting up your account shortly.");
    await ref.set({ status: 'needs_approval', rl, draft: { reason: 'account setup needs review', createdAt: new Date() }, updatedAt: new Date() }, { merge: true });
    return;
  }
  // 2. Download the menu media and AI-upload it to THIS restaurant only.
  const files = [];
  for (const m of (state.pendingMedia || []).slice(0, 10)) {
    try { files.push(await downloadMedia(m.id)); } catch (e) { console.error('[wa-agent] media dl failed', e.message); }
  }
  // Default is APPEND (preserve the old menu). Only REPLACE when the customer explicitly asks
  // (e.g. "replace my menu", "reset", "start over") — then the old menu is soft-deleted first.
  const convoText = (state.history || []).map(h => (h && h.text) || '').join(' ').toLowerCase();
  const wantsReplace = /\breplace\b|\breset\b|start over|overwrite|clear (the |my )?menu|delete (the |my )?(old |current )?menu/.test(convoText);

  let added = 0;
  if (files.length) {
    added = await uploadMenu(acct.restaurantId, acct.token, files, { replace: wantsReplace });
  }
  // 3. Confirm.
  await sendReply(phone, added > 0
    ? `✅ Done! Your account is ready and ${added} items were ${wantsReplace ? 'set as your new menu (previous menu replaced)' : 'added to your menu'}. You can start using DineOpen now — we'll message your login details next.`
    : `✅ Your account is ready! We couldn't read items automatically from that file — please resend a clearer menu photo/PDF and we'll add them.`);
  await ref.set({ status: 'idle', stage: 'onboarded', resolvedRestaurantId: acct.restaurantId, pendingMedia: [], rl, updatedAt: new Date() }, { merge: true });
}

// ── Intent classification + draft (OpenAI) ──────────────────────────────────
// The DineOpen number is SHARED: it receives both (a) prospects/owners who want to set up or
// use DineOpen, and (b) the ordinary CUSTOMERS of restaurants that message their diners through
// our number. We must ONLY auto-engage (a). `ctx` carries what we know about the sender's phone
// so the model (and the caller's guard) can tell the two apart.
const VALID_INTENTS = ['dineopen_signup', 'menu_setup', 'greeting', 'restaurant_customer', 'other', 'different_number'];
async function classifyIntent(state, ctx = {}) {
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const history = (state.history || []).map(h => `${h.role}: ${h.text}`).join('\n').slice(-2000);
    const ctxLine = `Sender context: ${ctx.isDineOpenOwner ? 'ALREADY owns a DineOpen account' : 'no DineOpen owner account found'}; ${ctx.isRestaurantCustomer ? 'appears in a restaurant\'s CUSTOMER list (likely a diner of an existing restaurant)' : 'not found as any restaurant\'s customer'}.`;
    const sys = `You are DineOpen's WhatsApp assistant on DineOpen's SHARED business number. This number is used by two very different groups:
  (1) RESTAURANT OWNERS / PROSPECTS who want to sign up for or set up DineOpen (the POS/restaurant software), and
  (2) ordinary DINERS who are messaging a specific restaurant that uses our shared number to talk to its customers (ordering food, asking about their bill/order/table/delivery, replying to a promo).
Your job: classify the LATEST message and, where noted, draft a SHORT friendly reply (1-3 sentences, minimal emojis).
${ctxLine}
Return strict JSON: {"type":"dineopen_signup|menu_setup|greeting|restaurant_customer|other|different_number","draft":"..."}.
- "dineopen_signup": they want to onboard/set up their OWN restaurant on DineOpen, say they signed up on DineOpen, ask for help setting up their menu/account, or are interested in DineOpen POS. Put a warm reply in "draft" that welcomes them (use their restaurant name if they mentioned one) and asks them to send their menu photo or PDF so you can add it.
- "menu_setup": they explicitly want to add/upload/set up their menu. Draft = ask them to send the menu photo/PDF.
- "greeting": a bare hi/hello with NO indication of whether they are a prospect or a diner.
- "restaurant_customer": the message is a DINER talking to a restaurant — ordering food, asking about their order/bill/delivery/table/reservation, replying to a restaurant's message. NOT about the DineOpen product. Leave "draft" empty.
- "different_number": they ask to register/use a phone number different from the one they message from. Leave draft empty.
- "other": a genuine DineOpen product question (pricing, features, support) that isn't clearly a signup — put a helpful drafted reply in "draft".
When unsure between a prospect and a diner, prefer "restaurant_customer" (we must not spam diners).`;
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: history }],
      response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 300,
    });
    const parsed = JSON.parse(res.choices[0].message.content || '{}');
    if (!VALID_INTENTS.includes(parsed.type)) parsed.type = 'other';
    return parsed;
  } catch (e) {
    console.error('[wa-agent] classify failed, defaulting to draft-for-approval:', e.message);
    return { type: 'other', draft: '' };
  }
}

// What do we already know about this phone number? Used to guard the shared-number problem:
// a number that is only a restaurant's CUSTOMER (and not a DineOpen owner) is almost certainly
// a diner, so we stay silent unless the message itself is a clear DineOpen signup.
async function lookupPhoneContext(phone) {
  const db = getDb();
  const p = digits(phone);
  const ctx = { isDineOpenOwner: false, isRestaurantCustomer: false };
  try {
    const u = await db.collection(collections.users).where('phone', '==', p).limit(1).get();
    if (!u.empty) ctx.isDineOpenOwner = true;
    else {
      // some owner phones are stored with a country-code/plus variant — cheap second try
      const u2 = await db.collection(collections.users).where('phone', '==', '+' + p).limit(1).get();
      if (!u2.empty) ctx.isDineOpenOwner = true;
    }
  } catch (_) {}
  try {
    const c = await db.collection(collections.customers).where('phone', 'in', [p, '+' + p]).limit(1).get();
    if (!c.empty) ctx.isRestaurantCustomer = true;
  } catch (_) {}
  return ctx;
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
    // SECURITY: never auto-act on a privileged account (super-admin/admin/sub-admin) —
    // escalate to a human instead. Prevents a spoofed/matching phone from getting an
    // agent-driven action on an elevated account.
    if (ELEVATED_ROLES.has(String(d.role || '').toLowerCase())) return { escalate: true };
    const token = mintToken({ userId: doc.id, email: d.email });
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

// Extract → persist the menu, using the SAME two endpoints the web dashboard uses (unchanged):
//   1) /bulk-upload  — AI-extracts items from the files (does NOT save)
//   2) /bulk-save    — persists them; APPENDS by default (old menu preserved)
// `replace` (only when the customer explicitly asks) soft-deletes the current menu first via
// /bulk-delete (restorable); bulk-save then drops the soft-deleted rows → clean replace.
async function uploadMenu(restaurantId, token, files, { replace = false } = {}) {
  try {
    const authHeaders = { Authorization: `Bearer ${token}` };
    // 1. Extract only.
    const FormData = require('form-data');
    const form = new FormData();
    for (const f of files) form.append('menuFiles', f.buffer, { filename: f.name, contentType: f.mime });
    const ex = await axios.post(`${INTERNAL_BASE}/api/menus/bulk-upload/${restaurantId}`, form, {
      headers: { ...form.getHeaders(), ...authHeaders },
      timeout: 120000, maxBodyLength: Infinity, maxContentLength: Infinity,
    });
    const extractedMenus = ex.data?.data || [];
    const menuItems = extractedMenus.flatMap(m => (m && Array.isArray(m.menuItems)) ? m.menuItems : []);
    const categories = ex.data?.extractedCategories || [];
    if (!menuItems.length) return 0; // nothing readable in the file

    // 2. Replace only on explicit request: soft-delete the current menu (restorable). Best-effort
    //    — if it fails we fall back to appending rather than losing the customer's upload.
    if (replace) {
      try {
        await axios.delete(`${INTERNAL_BASE}/api/menus/${restaurantId}/bulk-delete`, { headers: authHeaders, timeout: 60000 });
      } catch (delErr) {
        console.error('[wa-agent] menu replace (bulk-delete) failed, appending instead:', delErr.response?.data?.error || delErr.message);
      }
    }

    // 3. Persist — appends (bulk-save keeps existing active items, drops soft-deleted ones).
    const save = await axios.post(`${INTERNAL_BASE}/api/menus/bulk-save/${restaurantId}`,
      { menuItems, categories },
      { headers: { ...authHeaders, 'Content-Type': 'application/json' }, timeout: 120000 });
    return save.data?.savedCount ?? menuItems.length;
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
// ── Draft approval workflow (Step 2 — used by the dine-admin WhatsApp tab) ────
// The agent stores a drafted reply (status 'needs_approval') for any "other" question or
// escalation; a human approves/edits/sends or dismisses it. These are NOT flag-gated so
// admins can always clear the queue, and don't create/modify customer accounts.

// List conversations waiting for admin approval, newest first.
async function listDrafts(limit = 50) {
  const snap = await getDb().collection(STATE_COLLECTION)
    .where('status', '==', 'needs_approval')
    .limit(limit).get();
  const rows = snap.docs.map((d) => {
    const s = d.data();
    return {
      phone: s.phone,
      name: s.name || '',
      reason: s.draft?.reason || '',
      draftText: s.draft?.text || '',
      lastMessage: (s.history || []).filter(h => h.role === 'user').slice(-1)[0]?.text || '',
      history: (s.history || []).slice(-6),
      createdAt: s.draft?.createdAt || s.updatedAt || null,
    };
  });
  rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return rows;
}

// Approve: send the (optionally edited) text on WhatsApp, then clear the draft.
async function approveDraft(phone, textOverride, approvedBy) {
  const p = digits(phone);
  const { ref, data } = await loadState(p);
  if (!data) return { ok: false, error: 'conversation not found' };
  const text = (textOverride && String(textOverride).trim()) || data.draft?.text || '';
  if (!text) return { ok: false, error: 'no reply text' };
  await sendReply(p, text);
  await ref.set({
    status: 'idle', draft: null,
    lastApproved: { text, by: approvedBy || 'admin', at: new Date() },
    history: [...(data.history || []), { role: 'assistant', text, at: Date.now(), approvedBy: approvedBy || 'admin' }].slice(-HISTORY_MAX),
    updatedAt: new Date(),
  }, { merge: true });
  return { ok: true, sent: text };
}

// Dismiss: drop the draft without sending.
async function dismissDraft(phone, by) {
  const p = digits(phone);
  const { ref, data } = await loadState(p);
  if (!data) return { ok: false, error: 'conversation not found' };
  await ref.set({ status: 'idle', draft: null, lastDismiss: { by: by || 'admin', at: new Date() }, updatedAt: new Date() }, { merge: true });
  return { ok: true };
}

module.exports = {
  onInbound, processDue, isEnabled, mintToken, resolveOrCreateAccount, checkRate, RL, ELEVATED_ROLES,
  listDrafts, approveDraft, dismissDraft,
};

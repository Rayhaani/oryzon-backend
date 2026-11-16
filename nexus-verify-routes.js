/* ============================================================
   nexus-verify-routes.js  - Oryzon "Get Verified" backend module
   Mount with ONE block in server.js (after the other routes):

     const mountVerify = require('./nexus-verify-routes');
     mountVerify(app, {
       admin,                                   // your initialised firebase-admin
       adminUids: [ADMIN_UID],
       cronSecret: process.env.VERIFY_CRON_SECRET,     // long random string (for /verify/cron/expire)
       deleteDocs: keys => Promise.all(keys.map(k => s3.deleteObject({ Bucket: VERIFICATION_BUCKET, Key: k }).promise())),
       payments: { mode: 'free' }               // 'free' now. Later: { mode: 'paid', provider: 'paystack', secretKey: process.env.PAYSTACK_SECRET_KEY, publicBase: 'https://rayhaani.github.io/Oryzon' }
     });

   Collections (all already covered by your Firestore rules, written only by this module through the Admin SDK):
     verificationRequests/{id}  the application (private; the owner may read their own)
     entitlements/{entityKey}   the active plan of an account/page/store (owner reads their own)
     publicBadges/{entityKey}   what everyone sees: { type, tier }  (no personal data)
   Flow:  user submits  ->  admin approves or rejects  ->
          free mode: badge is active at once (no expiry while launch is free)
          paid mode: status "awaiting_payment" + checkout link; the provider's webhook activates it.
   ID documents are deleted from the private bucket as soon as a decision is made (or the request is withdrawn).
   ============================================================ */
'use strict';
const crypto = require('crypto');

const TIERS = { standard: 2.99, plus: 11.99, premium: 34.99, max: 119.99 };      // USD per month, same numbers as the page
const ANNUAL_MONTHS_CHARGED = 10;
const TYPES = ['individual', 'business'];
const ENTITY_IDS = ['account', 'svc', 'store', 'page', 'channel', 'group'];
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const DAY = 86400000;

function priceOf(tier, cycle) { const m = TIERS[tier]; return cycle === 'annual' ? Math.round(m * ANNUAL_MONTHS_CHARGED * 100) / 100 : m; }
function addPeriod(ms, cycle) { const d = new Date(ms); if (cycle === 'annual') d.setUTCFullYear(d.getUTCFullYear() + 1); else d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime(); }

/* ---------- payment providers (used only when payments.mode === 'paid'; NOT tested against a live account) ---------- */
function makeProvider(cfg) {
  const fetchJson = async (url, opts) => { const r = await fetch(url, opts); const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error('provider_error'); e.status = 502; e.detail = j; throw e; } return j; };
  if (cfg.provider === 'paystack') return {
    name: 'paystack',
    async createCheckout({ reference, amountUSD, email, callbackUrl, metadata }) {
      const j = await fetchJson('https://api.paystack.co/transaction/initialize', { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.secretKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, amount: Math.round(amountUSD * 100), currency: cfg.currency || 'USD', reference, callback_url: callbackUrl, metadata }) });   // amount is in the currency's smallest unit
      return { url: j.data.authorization_url, reference };
    },
    parseWebhook(rawBody, headers) {       // Paystack signs the RAW body with your secret key (HMAC SHA512) in x-paystack-signature
      const sig = headers['x-paystack-signature'] || '';
      const mine = crypto.createHmac('sha512', cfg.secretKey).update(rawBody).digest('hex');
      if (!sig || sig.length !== mine.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mine))) return null;
      const ev = JSON.parse(rawBody.toString('utf8'));
      return ev.event === 'charge.success' ? { reference: ev.data && ev.data.reference, paid: true } : { paid: false };
    }
  };
  if (cfg.provider === 'flutterwave') return {
    name: 'flutterwave',
    async createCheckout({ reference, amountUSD, email, callbackUrl, metadata }) {
      const j = await fetchJson('https://api.flutterwave.com/v3/payments', { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.secretKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tx_ref: reference, amount: amountUSD, currency: cfg.currency || 'USD', redirect_url: callbackUrl, customer: { email }, meta: metadata }) });
      return { url: j.data.link, reference };
    },
    parseWebhook(rawBody, headers) {       // Flutterwave sends your own "secret hash" (set in the dashboard) in the verif-hash header
      const sig = headers['verif-hash'] || '';
      if (!cfg.webhookHash || sig.length !== cfg.webhookHash.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(cfg.webhookHash))) return null;
      const ev = JSON.parse(rawBody.toString('utf8'));
      const d = ev.data || {};
      return (d.status === 'successful') ? { reference: d.tx_ref, paid: true } : { paid: false };
    }
  };
  return null;
}

function create(deps) {
  const { admin, adminUids = [], cronSecret = '', deleteDocs = null } = deps;
  const payCfg = deps.payments || { mode: 'free' };
  const paid = payCfg.mode === 'paid';
  const provider = paid ? makeProvider(payCfg) : null;
  if (paid && !provider) throw new Error('payments.mode is "paid" but provider is not "paystack" or "flutterwave"');
  const db = () => admin.firestore();
  const FV = () => admin.firestore.FieldValue;

  async function authUser(req) {
    const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) { const e = new Error('unauthenticated'); e.status = 401; throw e; }
    try { return await admin.auth().verifyIdToken(m[1]); } catch (_) { const e = new Error('unauthenticated'); e.status = 401; throw e; }
  }
  const isAdmin = tok => !!tok && (tok.admin === true || adminUids.includes(tok.uid));
  const bad = (msg, status = 400) => { const e = new Error(msg); e.status = status; return e; };
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); } catch (e) { const s = e.status || 500; if (s === 500) console.error('[verify]', e); res.status(s).json({ error: s === 500 ? 'server_error' : e.message }); }
  };
  const ms = t => (t && t.toMillis ? t.toMillis() : (typeof t === 'number' ? t : null));
  const entityKey = (uid, entityId, ref) => entityId === 'account' ? 'u_' + uid : entityId + '_' + uid + (ref ? '_' + ref : '');
  const OPEN = ['pending', 'awaiting_payment'];

  async function dropDocs(r) {
    const keys = Object.values(r.docs || {}).filter(Boolean);
    if (keys.length && deleteDocs) { try { await deleteDocs(keys); } catch (e) { console.error('[verify] doc delete failed', e.message); return false; } }
    return true;
  }

  /* what the page needs about one entity */
  async function stateOf(uid, key) {
    const [ent, q] = await Promise.all([db().collection('entitlements').doc(key).get(), db().collection('verificationRequests').where('entityKey', '==', key).get()]);
    const reqs = q.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => r.ownerUid === uid).sort((a, b) => (ms(b.submittedAt) || 0) - (ms(a.submittedAt) || 0));
    const last = reqs[0] || null;
    const e = ent.exists ? ent.data() : null;
    if (e && e.ownerUid === uid && e.status === 'active') return { status: 'verified', type: e.type, tier: e.tier, cycle: e.cycle, approvedAt: ms(e.startedAt), renewsAt: ms(e.renewsAt), cancelling: !!e.cancelling, free: !e.renewsAt };
    if (!last) return { status: 'none' };
    if (last.status === 'pending') return { status: 'pending', type: last.type, tier: last.tier, cycle: last.cycle, submittedAt: ms(last.submittedAt), requestId: last.id };
    if (last.status === 'awaiting_payment') return { status: 'awaiting_payment', type: last.type, tier: last.tier, cycle: last.cycle, checkoutUrl: last.checkout && last.checkout.url, requestId: last.id };
    if (last.status === 'rejected') return { status: 'rejected', type: last.type, tier: last.tier, cycle: last.cycle, reason: last.reason || '' };
    return { status: 'none' };     // withdrawn / expired / cancelled-and-ended
  }

  const mine = wrap(async (req, res) => {
    const u = await authUser(req);
    const entityId = clip(req.query && req.query.entity, 20) || 'account';
    if (!ENTITY_IDS.includes(entityId)) throw bad('bad_entity');
    const key = entityKey(u.uid, entityId, clip(req.query && req.query.ref, 60).replace(/[^A-Za-z0-9_-]/g, ''));
    res.json({ ok: true, entityKey: key, paymentsEnabled: paid, state: await stateOf(u.uid, key) });
  });

  const request = wrap(async (req, res) => {
    const u = await authUser(req); const b = req.body || {};
    const entityId = clip(b.entityId, 20) || 'account';
    if (!ENTITY_IDS.includes(entityId)) throw bad('bad_entity');
    const type = b.type; if (!TYPES.includes(type)) throw bad('bad_type');
    if ((entityId === 'account') !== (type === 'individual')) throw bad('type_does_not_match_entity');
    const tier = b.tier; if (!TIERS[tier]) throw bad('bad_tier');
    const cycle = b.cycle === 'annual' ? 'annual' : 'monthly';
    const key = entityKey(u.uid, entityId, clip(b.ref, 60).replace(/[^A-Za-z0-9_-]/g, ''));
    const st = await stateOf(u.uid, key);
    if (st.status === 'verified' || st.status === 'pending' || st.status === 'awaiting_payment') throw bad('already_' + st.status, 409);

    const docs = {};
    for (const k of ['front', 'back', 'selfie', 'bizDoc']) {
      const v = b.docs && b.docs[k]; if (!v) continue;
      if (typeof v !== 'string' || !v.startsWith(u.uid + '/') || v.length > 200) throw bad('bad_document');     // only files this user uploaded
      docs[k] = v;
    }
    const data = { ownerUid: u.uid, entityKey: key, entityId, entityRef: clip(b.ref, 60), type, tier, cycle, status: 'pending', submittedAt: FV().serverTimestamp(), docs, price: { currency: 'USD', total: priceOf(tier, cycle) }, email: clip(u.email, 120), username: clip(b.username, 40) };
    if (type === 'individual') {
      const id = b.identity || {};
      if (!clip(id.legalName, 100).trim() || !clip(id.docType, 40) || !clip(id.country, 60).trim() || !docs.front || !docs.selfie) throw bad('missing_identity');
      if (id.docType !== 'Passport' && !docs.back) throw bad('missing_id_back');
      data.identity = { legalName: clip(id.legalName, 100), docType: clip(id.docType, 40), country: clip(id.country, 60) };
    } else {
      const bz = b.business || {};
      if (!clip(bz.name, 120).trim() || !clip(bz.category, 60) || !/\S+@\S+\.\S+/.test(clip(bz.email, 120)) || !docs.bizDoc) throw bad('missing_business');
      data.business = { name: clip(bz.name, 120), category: clip(bz.category, 60), email: clip(bz.email, 120), site: clip(bz.site, 200) };
    }
    const ref = await db().collection('verificationRequests').add(data);
    res.json({ ok: true, id: ref.id, state: { status: 'pending', type, tier, cycle, submittedAt: Date.now(), requestId: ref.id } });
  });

  const withdraw = wrap(async (req, res) => {
    const u = await authUser(req); const id = clip(req.body && req.body.id, 40);
    const ref = db().collection('verificationRequests').doc(id); const s = await ref.get();
    if (!s.exists || s.data().ownerUid !== u.uid) throw bad('not_found', 404);
    const r = s.data(); if (!OPEN.includes(r.status)) throw bad('not_open', 409);
    await ref.update({ status: 'withdrawn', decidedAt: FV().serverTimestamp() });
    await dropDocs(r); res.json({ ok: true });
  });

  const cancel = wrap(async (req, res) => {     // stop renewing; the badge stays until the period ends
    const u = await authUser(req); const key = clip(req.body && req.body.entityKey, 120);
    const ref = db().collection('entitlements').doc(key); const s = await ref.get();
    if (!s.exists || s.data().ownerUid !== u.uid || s.data().status !== 'active') throw bad('not_found', 404);
    await ref.update({ cancelling: true });
    if (!s.data().renewsAt) { await ref.update({ status: 'ended', endedAt: FV().serverTimestamp() }); await db().collection('publicBadges').doc(key).delete(); }   // free-launch plan has no period: ends now
    res.json({ ok: true });
  });

  /* ---------- activation (used by admin approve in free mode, and by the payment webhook) ---------- */
  async function activate(reqId, how) {
    const rref = db().collection('verificationRequests').doc(reqId); const s = await rref.get(); const r = s.data();
    const now = Date.now();
    const renewsAt = how === 'free' ? null : addPeriod(now, r.cycle);
    await db().collection('entitlements').doc(r.entityKey).set({ ownerUid: r.ownerUid, type: r.type, tier: r.tier, cycle: r.cycle, status: 'active', cancelling: false, startedAt: FV().serverTimestamp(), renewsAt: renewsAt ? new Date(renewsAt) : null, requestId: reqId, via: how });
    await db().collection('publicBadges').doc(r.entityKey).set({ type: r.type, tier: r.tier });
    await rref.update({ status: 'active', activatedAt: FV().serverTimestamp(), via: how });
  }

  /* ---------- admin ---------- */
  const adminList = wrap(async (req, res) => {
    const u = await authUser(req); if (!isAdmin(u)) throw bad('forbidden', 403);
    const status = ['pending', 'awaiting_payment', 'active', 'rejected'].includes(req.query && req.query.status) ? req.query.status : 'pending';
    const q = await db().collection('verificationRequests').where('status', '==', status).get();
    const items = q.docs.map(d => { const r = d.data(); return { id: d.id, type: r.type, tier: r.tier, cycle: r.cycle, entityId: r.entityId, entityRef: r.entityRef, username: r.username, email: r.email, identity: r.identity || null, business: r.business || null, docs: r.docs || {}, price: r.price, submittedAt: ms(r.submittedAt), reason: r.reason || '', ownerUid: r.ownerUid }; })
      .sort((a, b) => (a.submittedAt || 0) - (b.submittedAt || 0)).slice(0, 100);
    res.json({ ok: true, items, paymentsEnabled: paid });
  });

  const adminDecision = wrap(async (req, res) => {
    const u = await authUser(req); if (!isAdmin(u)) throw bad('forbidden', 403);
    const b = req.body || {}; const id = clip(b.id, 40);
    const rref = db().collection('verificationRequests').doc(id); const s = await rref.get();
    if (!s.exists) throw bad('not_found', 404);
    const r = s.data(); if (r.status !== 'pending') throw bad('not_pending', 409);
    if (b.decision === 'reject') {
      const reason = clip(b.reason, 300).trim(); if (!reason) throw bad('reason_required');
      await rref.update({ status: 'rejected', reason, decidedAt: FV().serverTimestamp(), decidedBy: u.uid });
      await dropDocs(r); return res.json({ ok: true, status: 'rejected' });
    }
    if (b.decision !== 'approve') throw bad('bad_decision');
    await rref.update({ decidedAt: FV().serverTimestamp(), decidedBy: u.uid });
    if (!paid) { await activate(id, 'free'); await dropDocs(r); return res.json({ ok: true, status: 'active' }); }
    const reference = 'vr_' + id + '_' + Date.now().toString(36);
    const co = await provider.createCheckout({ reference, amountUSD: r.price.total, email: r.email, callbackUrl: (payCfg.publicBase || '') + '/get-verified.html', metadata: { requestId: id } });
    await rref.update({ status: 'awaiting_payment', checkout: { provider: provider.name, url: co.url, reference } });
    await dropDocs(r); res.json({ ok: true, status: 'awaiting_payment' });
  });

  /* ---------- payment webhook (only does anything in paid mode; needs req.rawBody, see server.js line 11) ---------- */
  const webhook = async (req, res) => {
    try {
      if (!paid) return res.status(404).json({ error: 'payments_off' });
      const raw = req.rawBody; if (!raw) return res.status(400).json({ error: 'no_raw_body' });
      const ev = provider.parseWebhook(raw, req.headers || {});
      if (!ev) return res.status(401).json({ error: 'bad_signature' });
      if (!ev.paid || !ev.reference) return res.json({ ok: true });
      const q = await db().collection('verificationRequests').where('checkout.reference', '==', ev.reference).get();
      if (q.empty) return res.json({ ok: true });
      const d = q.docs[0]; if (d.data().status === 'awaiting_payment') await activate(d.id, provider.name);      // idempotent: a repeated webhook does nothing
      res.json({ ok: true });
    } catch (e) { console.error('[verify webhook]', e); res.status(500).json({ error: 'server_error' }); }
  };

  /* ---------- expiry: remove badges whose paid period has ended (call every few hours from cron-job.org) ---------- */
  async function expireDue(nowMs = Date.now()) {
    const q = await db().collection('entitlements').where('status', '==', 'active').get(); let n = 0;
    for (const d of q.docs) { const e = d.data(); const r = ms(e.renewsAt); if (r && r < nowMs) { await d.ref.update({ status: 'expired', endedAt: FV().serverTimestamp() }); await db().collection('publicBadges').doc(d.id).delete(); n++; } }
    return n;
  }
  const cronExpire = wrap(async (req, res) => {
    const s = (req.headers && (req.headers['x-cron-secret'] || '')) || '';
    if (!cronSecret || s !== cronSecret) throw bad('forbidden', 403);
    res.json({ ok: true, expired: await expireDue() });
  });

  return { mine, request, withdraw, cancel, adminList, adminDecision, webhook, cronExpire, expireDue, activate, priceOf, entityKey };
}

module.exports = function mountVerify(app, deps) {
  const h = create(deps);
  app.get('/verify/mine', h.mine);
  app.post('/verify/request', h.request);
  app.post('/verify/withdraw', h.withdraw);
  app.post('/verify/cancel', h.cancel);
  app.get('/verify/admin/list', h.adminList);
  app.post('/verify/admin/decision', h.adminDecision);
  app.post('/verify/webhook', h.webhook);
  app.post('/verify/cron/expire', h.cronExpire);
  return h;
};
module.exports.create = create;

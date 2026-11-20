/* ============================================================
   nexus-telehealth-routes.js — per-visit telehealth: doctor-set fee, fee snapshot on each request, slot protection, cancel.
   Works on top of the existing collections (doctors, consultRequests). The doctor still accepts/declines and shares the call
   link through the existing /health/consult/respond. Mount with ONE block in server.js (after mountDoctorVerify):

     const mountTelehealth = require('./nexus-telehealth-routes');
     mountTelehealth(app, { admin, payments: { mode: 'free' } });

   Routes (Firebase login token required):
     GET  /telehealth/config            -> limits, currency, whether payments are on
     POST /telehealth/doctor/settings   -> a verified doctor sets { fee, duration, accepting }
     POST /telehealth/request           -> patient asks for a consultation; the doctor's fee is copied onto the request
     POST /telehealth/cancel            -> the patient cancels a request / booking that has not happened yet
   PAYMENTS: only mode 'free' exists. Nobody is charged: the fee is recorded on the request (payment.status 'not_charged') so the
   day payments are switched on there is a clean price history. Charging money, holding it, a platform commission and paying
   doctors out are NOT built here (they need a live payment account and a business decision on commission and refunds).
   ============================================================ */
'use strict';

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const DURATIONS = [15, 30, 45, 60];
const MAX_FEE = 500;          // USD per visit; a guard against typing mistakes
const ACTIVE = ['requested', 'accepted'];

function create(deps) {
  const { admin, payments = { mode: 'free' } } = deps;
  if (payments.mode !== 'free') throw new Error('nexus-telehealth-routes: only payments.mode "free" is implemented');
  const db = () => admin.firestore();
  const FV = () => admin.firestore.FieldValue;

  async function authUser(req) {
    const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) { const e = new Error('unauthenticated'); e.status = 401; throw e; }
    try { return await admin.auth().verifyIdToken(m[1]); } catch (_) { const e = new Error('unauthenticated'); e.status = 401; throw e; }
  }
  const bad = (msg, status = 400) => { const e = new Error(msg); e.status = status; return e; };
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); } catch (e) { const s = e.status || 500; if (s === 500) console.error('[telehealth]', e); res.status(s).json({ error: s === 500 ? 'server_error' : e.message }); }
  };
  async function notify(uid, title, body, data = {}) {
    try {
      const s = await db().collection('pushTokens').doc(uid).get();
      const tokens = (s.exists && s.data().tokens) || [];
      if (tokens.length) await admin.messaging().sendEachForMulticast({ tokens, notification: { title, body }, data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])), webpush: { fcmOptions: { link: '/health.html' } } });
    } catch (_) { /* a failed push never blocks the action */ }
  }

  const config = wrap(async (req, res) => {
    await authUser(req);
    res.json({ ok: true, currency: 'USD', maxFee: MAX_FEE, durations: DURATIONS, paymentsEnabled: false });
  });

  const doctorSettings = wrap(async (req, res) => {
    const u = await authUser(req); const b = req.body || {};
    const ref = db().collection('doctors').doc(u.uid), s = await ref.get();
    if (!s.exists || s.data().verified !== true) throw bad('not_a_doctor', 403);
    const fee = Number(b.fee), duration = Number(b.duration);
    if (!Number.isFinite(fee) || fee < 0 || fee > MAX_FEE) throw bad('bad_fee');
    if (!DURATIONS.includes(duration)) throw bad('bad_duration');
    if (typeof b.accepting !== 'boolean') throw bad('bad_request');
    const price = Math.round(fee * 100) / 100;
    await ref.update({ price, duration, availability: b.accepting ? 'today' : 'ahead', accepting: b.accepting });
    res.json({ ok: true, price, duration, accepting: b.accepting });
  });

  const request = wrap(async (req, res) => {
    const u = await authUser(req); const b = req.body || {};
    const dref = await db().collection('doctors').doc(clip(b.doctorId, 128)).get();
    if (!dref.exists || dref.data().verified !== true) throw bad('doctor_not_found', 404);
    if (dref.id === u.uid) throw bad('cannot_book_self');
    const d = dref.data();
    if (d.accepting === false) throw bad('not_accepting', 409);
    const slot = new Date(b.slotISO);
    if (isNaN(slot) || slot.getTime() < Date.now() - 60000 || slot.getTime() > Date.now() + 90 * 864e5) throw bad('bad_slot');
    slot.setSeconds(0, 0);
    const mine = await db().collection('consultRequests').where('patientUid', '==', u.uid).where('status', '==', 'requested').get();
    if (mine.size >= 5) throw bad('too_many_pending', 429);
    const same = await db().collection('consultRequests').where('doctorId', '==', dref.id).where('slot', '==', slot.toISOString()).get();
    if (same.docs.some(x => ACTIVE.includes(x.data().status))) throw bad('slot_taken', 409);
    const fee = Math.max(0, Number(d.price) || 0);
    const ref = await db().collection('consultRequests').add({
      doctorId: dref.id, patientUid: u.uid, patientName: clip(u.name || 'Patient', 60), slot: slot.toISOString(), mode: clip(b.mode, 40), notes: clip(b.notes, 2000),
      status: 'requested', fee, currency: 'USD', durationMin: Number(d.duration) || 30, payment: { status: fee > 0 ? 'not_charged' : 'free' }, createdAt: FV().serverTimestamp()
    });
    await notify(dref.id, 'New consultation request', 'A patient requested a consultation. Open Nexus Medical City.', { type: 'consult', id: ref.id });
    res.json({ ok: true, id: ref.id, fee, currency: 'USD', charged: false });
  });

  const cancel = wrap(async (req, res) => {
    const u = await authUser(req);
    const ref = db().collection('consultRequests').doc(clip((req.body || {}).id, 128)), s = await ref.get();
    if (!s.exists) throw bad('not_found', 404);
    const r = s.data(); if (r.patientUid !== u.uid) throw bad('forbidden', 403);
    if (!ACTIVE.includes(r.status)) throw bad('cannot_cancel', 409);
    if (new Date(r.slot).getTime() < Date.now()) throw bad('already_past', 409);
    await ref.update({ status: 'cancelled', cancelledAt: FV().serverTimestamp() });
    await notify(r.doctorId, 'Consultation cancelled', 'A patient cancelled a consultation request.', { type: 'consult', id: s.id });
    res.json({ ok: true });
  });

  return { config, doctorSettings, request, cancel };
}

module.exports = function mountTelehealth(app, deps) {
  const h = create(deps);
  app.get('/telehealth/config', h.config);
  app.post('/telehealth/doctor/settings', h.doctorSettings);
  app.post('/telehealth/request', h.request);
  app.post('/telehealth/cancel', h.cancel);
  return h;
};
module.exports.create = create;

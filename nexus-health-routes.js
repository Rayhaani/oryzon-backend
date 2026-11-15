/* ============================================================
   nexus-health-routes.js  — Nexus Medical City backend module
   Drop into your Render/Express project and mount with ONE line:

     const mountHealth = require('./nexus-health-routes');
     mountHealth(app, {
       admin,                                   // your initialised firebase-admin
       express,                                 // so we can use express.json() if you did not already
       adminUids: (process.env.HEALTH_ADMIN_UIDS || '').split(',').filter(Boolean),
       cronSecret: process.env.HEALTH_CRON_SECRET,   // long random string
       selfSchedule: false                      // true = run the reminder tick every minute inside this process
     });

   Env: HEALTH_ADMIN_UIDS (your Firebase uid, comma separated), HEALTH_CRON_SECRET.
   Collections used: doctorApplications, doctors, consultRequests, pushTokens, reminders, chwRecords/{uid}/entries, healthBackups.
   Every handler is a plain (req,res) function and is exported for testing (module.exports.handlers).
   ============================================================ */
'use strict';

const FREQ = { 'Once daily': [0], 'Twice daily': [0, 720], 'Three times daily': [0, 480, 960], 'Weekly': [0] };
const SPECIALTIES = ['General Practitioner', 'Cardiology', 'Pediatrics', 'Dermatology', 'Psychiatry', 'Gynecology', 'Neurology', 'Orthopedics', 'Ophthalmology', 'ENT', 'Dentistry', 'Other'];
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const pad = n => (n < 10 ? '0' : '') + n;

function create(deps) {
  const { admin, adminUids = [], cronSecret = '' } = deps;
  const db = () => admin.firestore();
  const FV = () => admin.firestore.FieldValue;

  async function authUser(req) {
    const h = req.headers && (req.headers.authorization || req.headers.Authorization) || '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) { const e = new Error('unauthenticated'); e.status = 401; throw e; }
    try { return await admin.auth().verifyIdToken(m[1]); }
    catch (_) { const e = new Error('unauthenticated'); e.status = 401; throw e; }
  }
  const isAdmin = tok => !!tok && (tok.admin === true || adminUids.includes(tok.uid));
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { const s = e.status || 500; if (s === 500) console.error('[health]', e); res.status(s).json({ error: s === 500 ? 'server_error' : e.message }); }
  };
  const bad = (msg, status = 400) => { const e = new Error(msg); e.status = status; return e; };

  /* ---------- push ---------- */
  async function tokensOf(uid) {
    const s = await db().collection('pushTokens').doc(uid).get();
    return (s.exists && s.data().tokens) || [];
  }
  async function notify(uid, title, body, data = {}) {
    const tokens = await tokensOf(uid);
    if (!tokens.length) return { sent: 0 };
    const r = await admin.messaging().sendEachForMulticast({
      tokens, notification: { title, body }, data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      webpush: { fcmOptions: { link: '/health.html' } }
    });
    const dead = [];
    r.responses.forEach((x, i) => { if (!x.success && /registration-token-not-registered|invalid-argument|invalid-registration/.test((x.error && x.error.code) || '')) dead.push(tokens[i]); });
    if (dead.length) await db().collection('pushTokens').doc(uid).set({ tokens: tokens.filter(t => !dead.includes(t)) }, { merge: true });
    return { sent: r.successCount };
  }

  const pushToken = wrap(async (req, res) => {
    const u = await authUser(req); const t = clip(req.body && req.body.token, 4096);
    if (t.length < 20) throw bad('bad_token');
    const cur = await tokensOf(u.uid);
    const next = [t, ...cur.filter(x => x !== t)].slice(0, 5);
    await db().collection('pushTokens').doc(u.uid).set({ tokens: next, updatedAt: FV().serverTimestamp() }, { merge: true });
    res.json({ ok: true });
  });

  /* ---------- background medication reminders (no medicine names are stored) ---------- */
  const remindersSync = wrap(async (req, res) => {
    const u = await authUser(req); const b = req.body || {};
    const ref = db().collection('reminders').doc(u.uid);
    if (!b.enabled) { await ref.delete(); return res.json({ ok: true, enabled: false }); }
    const list = Array.isArray(b.reminders) ? b.reminders.slice(0, 20) : [];
    const clean = list.map(r => ({ id: clip(r.id, 20), time: /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time) ? r.time : null, freq: FREQ[r.freq] ? r.freq : null, startDow: Number.isInteger(r.startDow) ? r.startDow % 7 : 0 })).filter(r => r.id && r.time && r.freq);
    const tz = Math.max(-840, Math.min(840, parseInt(b.tzOffsetMin, 10) || 0));    // minutes EAST of UTC (e.g. Lagos = 60)
    await ref.set({ reminders: clean, tzOffsetMin: tz, lastFired: {}, updatedAt: FV().serverTimestamp() });
    res.json({ ok: true, enabled: true, count: clean.length });
  });

  function dueNow(doc, nowMs) {
    const local = new Date(nowMs + (doc.tzOffsetMin || 0) * 60000);
    const day = local.getUTCFullYear() + '-' + pad(local.getUTCMonth() + 1) + '-' + pad(local.getUTCDate());
    const mins = local.getUTCHours() * 60 + local.getUTCMinutes(), dow = local.getUTCDay();
    const due = [];
    (doc.reminders || []).forEach(r => {
      if (r.freq === 'Weekly' && r.startDow !== dow) return;
      const [h, m] = r.time.split(':').map(Number);
      FREQ[r.freq].forEach((off, i) => {
        const at = (h * 60 + m + off) % 1440, key = day + '|' + r.id + '|' + i;
        if (mins >= at && mins - at <= 10 && !(doc.lastFired || {})[key]) due.push(key);
      });
    });
    return { day, due };
  }
  async function tick(nowMs = Date.now()) {
    const snap = await db().collection('reminders').get();
    let sent = 0;
    for (const d of snap.docs) {
      const doc = d.data(); const { day, due } = dueNow(doc, nowMs);
      if (!due.length) continue;
      const fired = {}; Object.keys(doc.lastFired || {}).forEach(k => { if (k.startsWith(day)) fired[k] = 1; }); due.forEach(k => fired[k] = 1);
      await d.ref.update({ lastFired: fired });                                   // mark first: never double-send
      const r = await notify(d.id, 'Nexus Medical City', 'Time to take your medication', { type: 'med' });
      sent += r.sent;
    }
    return sent;
  }
  const cronTick = wrap(async (req, res) => {
    const s = (req.headers && (req.headers['x-cron-secret'] || '')) || '';
    if (!cronSecret || s !== cronSecret) throw bad('forbidden', 403);
    res.json({ ok: true, sent: await tick() });
  });

  /* ---------- doctors ---------- */
  const adminListApplications = wrap(async (req, res) => {
    const u = await authUser(req); if (!isAdmin(u)) throw bad('forbidden', 403);
    const snap = await db().collection('doctorApplications').where('status', '==', 'pending').limit(50).get();
    const out = [];
    for (const d of snap.docs) {
      const a = d.data(); const docs = [];
      for (const f of (a.files || [])) {
        try { const [url] = await admin.storage().bucket().file(f.path).getSignedUrl({ action: 'read', expires: Date.now() + 15 * 60000 }); docs.push({ label: f.label, url }); } catch (_) {}
      }
      out.push({ uid: d.id, name: a.name, specialty: a.specialty, country: a.country, licenceNumber: a.licenceNumber, licenceBody: a.licenceBody, years: a.years, bio: a.bio, docs });
    }
    res.json({ applications: out });
  });

  const adminDoctorReview = wrap(async (req, res) => {
    const u = await authUser(req); if (!isAdmin(u)) throw bad('forbidden', 403);
    const { uid, decision } = req.body || {}; const note = clip(req.body && req.body.note, 500);
    if (!uid || !['approve', 'reject'].includes(decision)) throw bad('bad_request');
    const ref = db().collection('doctorApplications').doc(uid); const s = await ref.get();
    if (!s.exists || s.data().status !== 'pending') throw bad('not_pending', 409);
    const a = s.data();
    if (decision === 'approve') {
      const name = clip(a.name, 80); const parts = name.replace(/^dr\.?\s+/i, '').split(/\s+/);
      const hue = [...uid].reduce((n, c) => n + c.charCodeAt(0), 0) % 360;
      await db().collection('doctors').doc(uid).set({
        name: /^dr/i.test(name) ? name : 'Dr. ' + name, specialty: SPECIALTIES.includes(a.specialty) ? a.specialty : 'Other', country: clip(a.country, 2),
        bio: clip(a.bio, 600), years: Math.min(70, parseInt(a.years, 10) || 0), verified: true, verifiedAt: FV().serverTimestamp(),
        initials: ((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || ''), accentA: `hsl(${hue},70%,60%)`, accentB: `hsl(${(hue + 60) % 360},70%,60%)`,
        lat: typeof a.lat === 'number' ? a.lat : null, lng: typeof a.lng === 'number' ? a.lng : null, availability: 'ahead', duration: 30
      });
      const user = await admin.auth().getUser(uid);
      await admin.auth().setCustomUserClaims(uid, { ...(user.customClaims || {}), doctor: true });
    }
    await ref.update({ status: decision === 'approve' ? 'approved' : 'rejected', reviewNote: note, reviewedAt: FV().serverTimestamp(), reviewedBy: u.uid });
    await notify(uid, 'Nexus Medical City', decision === 'approve' ? 'Your doctor application was approved.' : 'Your doctor application needs attention. Open Nexus Medical City.');
    res.json({ ok: true });
  });

  /* ---------- consultation requests (no payment; the doctor accepts and shares a call link) ---------- */
  const consultRequest = wrap(async (req, res) => {
    const u = await authUser(req); const b = req.body || {};
    const doc = await db().collection('doctors').doc(clip(b.doctorId, 128)).get();
    if (!doc.exists) throw bad('doctor_not_found', 404);
    if (doc.id === u.uid) throw bad('cannot_book_self');
    const slot = new Date(b.slotISO); if (isNaN(slot) || slot.getTime() < Date.now() - 60000 || slot.getTime() > Date.now() + 90 * 864e5) throw bad('bad_slot');
    const pend = await db().collection('consultRequests').where('patientUid', '==', u.uid).where('status', '==', 'requested').get();
    if (pend.size >= 5) throw bad('too_many_pending', 429);
    const ref = await db().collection('consultRequests').add({
      doctorId: doc.id, patientUid: u.uid, patientName: clip(u.name || 'Patient', 60), slot: slot.toISOString(),
      mode: clip(b.mode, 40), notes: clip(b.notes, 2000), status: 'requested', createdAt: FV().serverTimestamp()
    });
    await notify(doc.id, 'New consultation request', 'A patient requested a consultation. Open Nexus Medical City.', { type: 'consult', id: ref.id });
    res.json({ ok: true, id: ref.id });
  });

  const consultRespond = wrap(async (req, res) => {
    const u = await authUser(req); const b = req.body || {};
    const ref = db().collection('consultRequests').doc(clip(b.id, 128)); const s = await ref.get();
    if (!s.exists) throw bad('not_found', 404);
    const r = s.data(); if (r.doctorId !== u.uid) throw bad('forbidden', 403);
    if (r.status !== 'requested') throw bad('already_answered', 409);
    const accept = b.decision === 'accept'; if (!accept && b.decision !== 'decline') throw bad('bad_request');
    const link = clip(b.link, 300);
    if (accept && !/^https:\/\//i.test(link)) throw bad('call_link_required');
    await ref.update({ status: accept ? 'accepted' : 'declined', callLink: accept ? link : null, doctorMessage: clip(b.message, 500), answeredAt: FV().serverTimestamp() });
    await notify(r.patientUid, 'Nexus Medical City', accept ? 'Your consultation request was accepted.' : 'Your consultation request was declined.', { type: 'consult', id: s.id });
    res.json({ ok: true });
  });

  /* ---------- CHW records: store-and-forward from the worker's phone (offline-first) ----------
     Only the Admin SDK touches chwRecords (clients cannot read/write it directly). The worker can only reach their own. */
  const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
  const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) && v >= lo && v <= hi ? v : null; };
  function cleanChw(r) {
    if (!r || typeof r !== 'object' || !ID_RE.test(r.id || '')) return null;
    const ts = Number(r.created); if (!Number.isFinite(ts) || ts < 1e12 || ts > Date.now() + 864e5) return null;
    const type = r.type === 'person' || r.type === 'visit' ? r.type : null; if (!type) return null;
    if (r.deleted) return { id: r.id, type, created: ts, deleted: true };            // tombstone: no personal data kept
    if (type === 'person') {
      if (r.consent !== true) return null;                                          // never store a person who did not agree
      return { id: r.id, type, name: clip(r.name, 80), yob: num(r.yob, 1900, new Date().getFullYear()), sex: ['f', 'm', 'o'].includes(r.sex) ? r.sex : '', area: clip(r.area, 80), pregnant: !!r.pregnant, consent: true, created: ts, deleted: false };
    }
    if (!ID_RE.test(r.pid || '')) return null;
    return { id: r.id, type, pid: r.pid, sys: num(r.sys, 50, 300), dia: num(r.dia, 30, 200), glu: num(r.glu, 10, 900), gluType: ['fasting', 'random'].includes(r.gluType) ? r.gluType : '', wt: num(r.wt, 1, 300), temp: num(r.temp, 30, 45), note: clip(r.note, 300), created: ts, deleted: false };
  }
  const chwSync = wrap(async (req, res) => {
    const u = await authUser(req);
    const list = Array.isArray(req.body && req.body.records) ? req.body.records.slice(0, 100) : [];
    const saved = [], rejected = [], batch = db().batch(), col = db().collection('chwRecords').doc(u.uid).collection('entries');
    list.forEach(r => { const c = cleanChw(r); if (!c) { rejected.push((r && r.id) || null); return; } batch.set(col.doc(c.id), { ...c, syncedAt: FV().serverTimestamp() }); saved.push(c.id); });
    if (saved.length) { batch.set(db().collection('chwRecords').doc(u.uid), { updatedAt: FV().serverTimestamp() }, { merge: true }); await batch.commit(); }
    res.json({ ok: true, saved, rejected });
  });
  const chwList = wrap(async (req, res) => {
    const u = await authUser(req);
    const snap = await db().collection('chwRecords').doc(u.uid).collection('entries').limit(2000).get();
    res.json({ records: snap.docs.map(d => { const x = d.data(); delete x.syncedAt; return x; }) });
  });

  /* ---------- impact: REAL counts from stored records only (admin only). Nothing estimated. ---------- */
  const adminImpact = wrap(async (req, res) => {
    const u = await authUser(req); if (!isAdmin(u)) throw bad('forbidden', 403);
    const n = async q => (await q.count().get()).data().count;
    const c = name => db().collection(name);
    const workers = await c('chwRecords').limit(500).get();
    let people = 0, visits = 0;
    for (const w of workers.docs) {
      const e = c('chwRecords').doc(w.id).collection('entries');
      people += await n(e.where('type', '==', 'person').where('deleted', '==', false));
      visits += await n(e.where('type', '==', 'visit').where('deleted', '==', false));
    }
    res.json({
      generatedAt: new Date().toISOString(),
      doctors: { verified: await n(c('doctors').where('verified', '==', true)), pending: await n(c('doctorApplications').where('status', '==', 'pending')), rejected: await n(c('doctorApplications').where('status', '==', 'rejected')) },
      consultations: { requested: await n(c('consultRequests')), accepted: await n(c('consultRequests').where('status', '==', 'accepted')), declined: await n(c('consultRequests').where('status', '==', 'declined')) },
      medicineReminderUsers: await n(c('reminders')),
      backupUsers: await n(c('healthBackups')),
      chw: { workers: workers.size, workersCapped: workers.size >= 500, peopleRegistered: people, visitsRecorded: visits }
    });
  });

  /* ---------- optional encrypted backup: the phone encrypts with the user's passphrase; the server stores ciphertext only ---------- */
  const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
  const backupPut = wrap(async (req, res) => {
    const u = await authUser(req); const b = req.body || {};
    const it = Number(b.it);
    if (b.v !== 1 || !Number.isInteger(it) || it < 100000 || it > 2000000) throw bad('bad_request');
    if (typeof b.salt !== 'string' || b.salt.length !== 24 || !B64.test(b.salt)) throw bad('bad_request');
    if (typeof b.iv !== 'string' || b.iv.length !== 16 || !B64.test(b.iv)) throw bad('bad_request');
    if (typeof b.ct !== 'string' || b.ct.length < 24 || b.ct.length > 900000 || !B64.test(b.ct)) throw bad('bad_request');
    await db().collection('healthBackups').doc(u.uid).set({ v: 1, it, salt: b.salt, iv: b.iv, ct: b.ct, bytes: b.ct.length, updatedAt: FV().serverTimestamp() });
    res.json({ ok: true });
  });
  const backupGet = wrap(async (req, res) => {
    const u = await authUser(req); const s = await db().collection('healthBackups').doc(u.uid).get();
    if (!s.exists) return res.json({ exists: false });
    const d = s.data(); const t = d.updatedAt && d.updatedAt.toMillis ? d.updatedAt.toMillis() : null;
    res.json({ exists: true, v: d.v, it: d.it, salt: d.salt, iv: d.iv, ct: d.ct, updatedAt: t });
  });
  const backupDelete = wrap(async (req, res) => {
    const u = await authUser(req); await db().collection('healthBackups').doc(u.uid).delete(); res.json({ ok: true });
  });

  /* ---------- delete my server-side health data ---------- */
  const deleteMine = wrap(async (req, res) => {
    const u = await authUser(req);
    await Promise.all([db().collection('reminders').doc(u.uid).delete(), db().collection('pushTokens').doc(u.uid).delete(), db().collection('healthBackups').doc(u.uid).delete()]);
    const root = db().collection('chwRecords').doc(u.uid);                                // right to erasure covers CHW records too
    if (typeof db().recursiveDelete === 'function') await db().recursiveDelete(root);
    else { const snap = await root.collection('entries').get(); await Promise.all(snap.docs.map(d => d.ref.delete())); await root.delete(); }
    res.json({ ok: true });
  });

  return { pushToken, remindersSync, cronTick, adminListApplications, adminDoctorReview, consultRequest, consultRespond, deleteMine, chwSync, chwList, adminImpact, cleanChw, backupPut, backupGet, backupDelete, tick, dueNow };
}

module.exports = function mountHealth(app, deps) {
  const h = create(deps);
  if (deps.express && !deps.skipJson) { app.use('/health/backup', deps.express.json({ limit: '1mb' })); app.use('/health', deps.express.json({ limit: '100kb' })); }   // the backup route must be mounted first: it carries an encrypted blob
  app.post('/health/push/token', h.pushToken);
  app.post('/health/reminders/sync', h.remindersSync);
  app.post('/health/cron/tick', h.cronTick);
  app.get('/health/admin/applications', h.adminListApplications);
  app.post('/health/admin/doctor-review', h.adminDoctorReview);
  app.post('/health/consult/request', h.consultRequest);
  app.post('/health/consult/respond', h.consultRespond);
  app.put('/health/backup', h.backupPut);
  app.get('/health/backup', h.backupGet);
  app.post('/health/backup/delete', h.backupDelete);
  app.post('/health/chw/sync', h.chwSync);
  app.get('/health/chw/list', h.chwList);
  app.get('/health/admin/impact', h.adminImpact);
  app.post('/health/me/delete', h.deleteMine);
  if (deps.selfSchedule) setInterval(() => h.tick().catch(e => console.error('[health tick]', e)), 60000);
  return h;
};
module.exports.create = create;

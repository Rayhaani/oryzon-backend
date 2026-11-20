/* ============================================================
   nexus-doctor-verify-routes.js — health-professional verification (separate from get-verified)
   Mount with ONE block in server.js (after mountHealth):

     const mountDoctorVerify = require('./nexus-doctor-verify-routes');
     mountDoctorVerify(app, {
       admin,
       adminUids: [ADMIN_UID],
       deleteDocs: keys => Promise.all(keys.map(k => s3.deleteObject({ Bucket: VERIFICATION_BUCKET, Key: k }).promise()))
     });

   Routes (all need a Firebase login token):
     GET  /doctor-verify/status            -> the caller's own application status
     POST /doctor-verify/apply             -> submit (documents were uploaded first through /upload-verification)
     GET  /doctor-verify/admin/list?status -> admin only
     POST /doctor-verify/admin/decision    -> admin only: approve / reject
   Writes doctorApplications/{uid}; on approval writes doctors/{uid} (what the Health directory reads)
   and sets the custom claim doctor:true. ID, selfie and licence photos live in the PRIVATE bucket and are
   deleted as soon as the admin decides. Everything is written with the Admin SDK (no rules changes).
   ============================================================ */
'use strict';

const SPECIALTIES = ['General Practitioner', 'Cardiology', 'Pediatrics', 'Dermatology', 'Psychiatry', 'Gynecology', 'Neurology', 'Orthopedics', 'Ophthalmology', 'ENT', 'Dentistry', 'Other'];
const ID_TYPES = ['Passport', 'Driver’s license', 'National ID card'];
const DOC_PREFIX = { front: 'id_', back: 'id-back_', selfie: 'selfie_', licence: 'licence_' };
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

function create(deps) {
  const { admin, adminUids = [], deleteDocs = async () => {} } = deps;
  const db = () => admin.firestore();
  const FV = () => admin.firestore.FieldValue;
  const col = () => db().collection('doctorApplications');

  async function authUser(req) {
    const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) { const e = new Error('unauthenticated'); e.status = 401; throw e; }
    try { return await admin.auth().verifyIdToken(m[1]); } catch (_) { const e = new Error('unauthenticated'); e.status = 401; throw e; }
  }
  const isAdmin = t => !!t && (t.admin === true || adminUids.includes(t.uid));
  const bad = (msg, status = 400) => { const e = new Error(msg); e.status = status; return e; };
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); } catch (e) { const s = e.status || 500; if (s === 500) console.error('[doctor-verify]', e); res.status(s).json({ error: s === 500 ? 'server_error' : e.message }); }
  };
  const ms = v => (v && typeof v.toMillis === 'function') ? v.toMillis() : (typeof v === 'number' ? v : null);

  async function notify(uid, title, body) {
    try {
      const s = await db().collection('pushTokens').doc(uid).get();
      const tokens = (s.exists && s.data().tokens) || [];
      if (tokens.length) await admin.messaging().sendEachForMulticast({ tokens, notification: { title, body }, webpush: { fcmOptions: { link: '/health.html' } } });
    } catch (_) { /* a failed push never blocks a decision */ }
  }

  /* ---------- the applicant ---------- */
  const status = wrap(async (req, res) => {
    const u = await authUser(req);
    const s = await col().doc(u.uid).get();
    if (!s.exists) return res.json({ ok: true, status: 'none' });
    const a = s.data();
    res.json({ ok: true, status: a.status, reviewNote: a.status === 'rejected' ? (a.reviewNote || '') : '', submittedAt: ms(a.submittedAt), reviewedAt: ms(a.reviewedAt), name: a.name || '', specialty: a.specialty || '' });
  });

  const apply = wrap(async (req, res) => {
    const u = await authUser(req); const b = req.body || {};
    const name = clip(b.name, 80), specialty = clip(b.specialty, 40), country = String(b.country == null ? '' : b.country).trim().toUpperCase();
    const licenceNumber = clip(b.licenceNumber, 40), licenceBody = clip(b.licenceBody, 80), bio = clip(b.bio, 600);
    const years = Number.isFinite(Number(b.years)) ? Math.round(Number(b.years)) : NaN;
    const idn = b.identity || {}; const legalName = clip(idn.legalName, 80), idType = clip(idn.docType, 30), idCountry = clip(idn.country, 60);
    if (name.length < 2 || !SPECIALTIES.includes(specialty) || !/^[A-Z]{2}$/.test(country) || licenceNumber.length < 3 || licenceBody.length < 2 || !(years >= 0 && years <= 70) || bio.length < 10) throw bad('missing_profile');
    if (legalName.length < 2 || !ID_TYPES.includes(idType) || idCountry.length < 2) throw bad('missing_identity');
    if (b.consent !== true) throw bad('consent_required');

    const d = b.docs || {}; const need = idType === 'Passport' ? ['front', 'selfie', 'licence'] : ['front', 'back', 'selfie', 'licence'];
    const docs = {};
    for (const k of Object.keys(DOC_PREFIX)) {
      const v = d[k];
      if (!v) { if (need.includes(k)) throw bad('bad_document'); continue; }
      if (typeof v !== 'string' || v.length > 200 || v.includes('..') || !v.startsWith(u.uid + '/' + DOC_PREFIX[k])) throw bad('bad_document');
      docs[k] = v;
    }
    if (!need.every(k => docs[k])) throw bad('bad_document');

    const ref = col().doc(u.uid), s = await ref.get();
    if (s.exists) { const st = s.data().status; if (st === 'pending') throw bad('already_pending', 409); if (st === 'approved') throw bad('already_approved', 409); }
    const data = { name, specialty, country, licenceNumber, licenceBody, years, bio, legalName, idType, idCountry, docs, files: [], status: 'pending', submittedAt: FV().serverTimestamp(), via: 'doctor-verify' };
    if (typeof b.lat === 'number' && typeof b.lng === 'number' && Math.abs(b.lat) <= 90 && Math.abs(b.lng) <= 180) { data.lat = +b.lat.toFixed(3); data.lng = +b.lng.toFixed(3); }
    await ref.set(data);
    res.json({ ok: true, status: 'pending' });
  });

  /* ---------- admin ---------- */
  const adminList = wrap(async (req, res) => {
    const u = await authUser(req); if (!isAdmin(u)) throw bad('forbidden', 403);
    const st = ['pending', 'approved', 'rejected'].includes(req.query && req.query.status) ? req.query.status : 'pending';
    const snap = await col().where('status', '==', st).limit(50).get();
    const items = snap.docs.filter(d => d.data().via === 'doctor-verify').map(d => { const a = d.data(); return { uid: d.id, name: a.name, legalName: a.legalName, idType: a.idType, idCountry: a.idCountry, specialty: a.specialty, country: a.country, licenceNumber: a.licenceNumber, licenceBody: a.licenceBody, years: a.years, bio: a.bio, docs: st === 'pending' ? (a.docs || {}) : {}, submittedAt: ms(a.submittedAt), reviewNote: a.reviewNote || '' }; });
    res.json({ ok: true, items });
  });

  const adminDecision = wrap(async (req, res) => {
    const u = await authUser(req); if (!isAdmin(u)) throw bad('forbidden', 403);
    const { uid, decision } = req.body || {}; const note = clip(req.body && req.body.reason, 500);
    if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{6,128}$/.test(uid) || !['approve', 'reject'].includes(decision)) throw bad('bad_request');
    if (decision === 'reject' && !note) throw bad('reason_required');
    const ref = col().doc(uid), s = await ref.get();
    if (!s.exists || s.data().status !== 'pending') throw bad('not_pending', 409);
    const a = s.data();
    if (decision === 'approve') {
      const nm = clip(a.name, 80), parts = nm.replace(/^dr\.?\s+/i, '').split(/\s+/);
      const hue = [...uid].reduce((n, c) => n + c.charCodeAt(0), 0) % 360;
      await db().collection('doctors').doc(uid).set({
        name: /^dr/i.test(nm) ? nm : 'Dr. ' + nm, specialty: SPECIALTIES.includes(a.specialty) ? a.specialty : 'Other', country: clip(a.country, 2),
        bio: clip(a.bio, 600), years: Math.min(70, parseInt(a.years, 10) || 0), verified: true, verifiedAt: FV().serverTimestamp(),
        initials: ((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || ''), accentA: `hsl(${hue},70%,60%)`, accentB: `hsl(${(hue + 60) % 360},70%,60%)`,
        lat: typeof a.lat === 'number' ? a.lat : null, lng: typeof a.lng === 'number' ? a.lng : null, availability: 'ahead', duration: 30
      });
      const user = await admin.auth().getUser(uid);
      await admin.auth().setCustomUserClaims(uid, { ...(user.customClaims || {}), doctor: true });
    }
    const keys = Object.values(a.docs || {}).filter(k => typeof k === 'string');
    await ref.update({ status: decision === 'approve' ? 'approved' : 'rejected', reviewNote: decision === 'reject' ? note : '', reviewedAt: FV().serverTimestamp(), reviewedBy: u.uid, docs: {}, docsDeletedAt: FV().serverTimestamp() });
    try { await deleteDocs(keys); } catch (e) { console.error('[doctor-verify] could not delete documents', e && e.message); }   // the decision is already saved; deletion is retried by hand if this logs
    await notify(uid, 'Nexus Medical City', decision === 'approve' ? 'Your health-professional verification was approved.' : 'Your verification needs attention. Open Nexus Medical City.');
    res.json({ ok: true });
  });

  return { status, apply, adminList, adminDecision };
}

module.exports = function mountDoctorVerify(app, deps) {
  const h = create(deps);
  app.get('/doctor-verify/status', h.status);
  app.post('/doctor-verify/apply', h.apply);
  app.get('/doctor-verify/admin/list', h.adminList);
  app.post('/doctor-verify/admin/decision', h.adminDecision);
  return h;
};
module.exports.create = create;

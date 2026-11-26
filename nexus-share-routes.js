/* ============================================================
   nexus-share-routes.js — "Open API": a person SHARES a FHIR R4 snapshot of their own Health Passport through a time-limited link.
   Health data stays on the person's phone. Only when THEY press "Create share link" is a snapshot of what THEY ticked copied here,
   readable by anyone holding the secret link until it expires (1–72 h) or they revoke it. Nothing is shared automatically.

   Mount with ONE block in server.js (after mountTelehealth):
     const mountShare = require('./nexus-share-routes');
     mountShare(app, { admin });

   Routes
     POST /share/create   (login)  { bundle, ttlHours }  -> { token, url, expiresAt, id }
     GET  /share/mine     (login)                         -> active links of the caller
     POST /share/revoke   (login)  { id }                 -> link stops working at once
     GET  /fhir/share/:token       (NO login; the token is the key) -> the FHIR Bundle (application/fhir+json)
     GET  /fhir/metadata           (public)               -> a small CapabilityStatement
   HONESTY: this is a read-only share link that returns a FHIR R4 Bundle. It is NOT a full FHIR server, it is not HL7-certified,
   and it has no search, no write and no app-registration (SMART on FHIR). Treat it as a safe way to hand a snapshot to a clinic.
   ============================================================ */
'use strict';
const crypto = require('crypto');

const ALLOWED = ['Patient', 'Observation', 'AllergyIntolerance', 'Condition', 'MedicationStatement', 'MedicationRequest', 'Immunization', 'RelatedPerson'];
const MAX_BYTES = 90 * 1024, MAX_ENTRIES = 150, MAX_ACTIVE = 5;
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

function create(deps) {
  const { admin, baseUrl } = deps;
  const col = () => admin.firestore().collection('sharedPassports');
  async function authUser(req) {
    const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || ''; const m = /^Bearer (.+)$/.exec(h);
    if (!m) { const e = new Error('unauthenticated'); e.status = 401; throw e; }
    try { return await admin.auth().verifyIdToken(m[1]); } catch (_) { const e = new Error('unauthenticated'); e.status = 401; throw e; }
  }
  const bad = (msg, status = 400) => { const e = new Error(msg); e.status = status; return e; };
  const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { const s = e.status || 500; if (s === 500) console.error('[share]', e); res.status(s).json({ error: s === 500 ? 'server_error' : e.message }); } };
  const hits = new Map();
  const limited = ip => { const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000); a.push(now); hits.set(ip, a); if (hits.size > 5000) hits.delete(hits.keys().next().value); return a.length > 60; };

  function validate(b) {
    if (!b || b.resourceType !== 'Bundle' || !Array.isArray(b.entry) || !b.entry.length || b.entry.length > MAX_ENTRIES) throw bad('bad_bundle');
    for (const e of b.entry) { const r = e && e.resource; if (!r || !ALLOWED.includes(r.resourceType)) throw bad('bad_bundle'); }
    if (!b.entry.some(e => e.resource.resourceType === 'Patient')) throw bad('bad_bundle');
    const s = JSON.stringify(b); if (Buffer.byteLength(s) > MAX_BYTES) throw bad('too_large', 413); return s;
  }

  const make = wrap(async (req, res) => {
    const u = await authUser(req), body = req.body || {};
    const json = validate(body.bundle);
    const ttl = Math.min(72, Math.max(1, Math.round(Number(body.ttlHours) || 24)));
    const mine = await col().where('ownerUid', '==', u.uid).get(); const now = Date.now(); let active = 0;
    for (const d of mine.docs) { const x = d.data(); if (x.revoked || x.expiresAt < now) { try { await col().doc(d.id).delete(); } catch (_) {} } else active++; }
    if (active >= MAX_ACTIVE) throw bad('too_many_links', 429);
    const token = crypto.randomBytes(24).toString('base64url'), id = sha(token);
    await col().doc(id).set({ ownerUid: u.uid, bundle: json, createdAt: now, expiresAt: now + ttl * 3600e3, accessCount: 0, revoked: false });
    const base = baseUrl || (req.protocol + '://' + (req.get ? req.get('host') : 'localhost'));
    res.json({ ok: true, id, token, url: base + '/fhir/share/' + token, expiresAt: now + ttl * 3600e3 });
  });

  const mineList = wrap(async (req, res) => {
    const u = await authUser(req), now = Date.now(); const s = await col().where('ownerUid', '==', u.uid).get();
    res.json({ ok: true, items: s.docs.map(d => ({ id: d.id, ...d.data() })).filter(x => !x.revoked && x.expiresAt > now).map(x => ({ id: x.id, createdAt: x.createdAt, expiresAt: x.expiresAt, accessCount: x.accessCount || 0 })) });
  });

  const revoke = wrap(async (req, res) => {
    const u = await authUser(req), id = String((req.body || {}).id || '');
    if (!/^[a-f0-9]{64}$/.test(id)) throw bad('bad_request');
    const ref = col().doc(id), s = await ref.get(); if (!s.exists || s.data().ownerUid !== u.uid) throw bad('not_found', 404);
    await ref.update({ revoked: true, bundle: '' }); res.json({ ok: true });
  });

  const read = wrap(async (req, res) => {
    if (limited(req.ip || 'x')) throw bad('slow_down', 429);
    const t = String(req.params.token || ''); if (!TOKEN_RE.test(t)) throw bad('not_found', 404);
    const ref = col().doc(sha(t)), s = await ref.get(); if (!s.exists) throw bad('not_found', 404);
    const x = s.data(); if (x.revoked) throw bad('not_found', 404);
    if (x.expiresAt < Date.now()) { try { await ref.delete(); } catch (_) {} throw bad('expired', 410); }
    try { await ref.update({ accessCount: (x.accessCount || 0) + 1, lastAccessAt: Date.now() }); } catch (_) {}
    res.set('Content-Type', 'application/fhir+json; charset=utf-8'); res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex'); res.send(x.bundle);
  });

  const metadata = (req, res) => res.set('Content-Type', 'application/fhir+json').json({
    resourceType: 'CapabilityStatement', status: 'active', date: '2026-11-01', kind: 'capability', fhirVersion: '4.0.1', format: ['json'],
    description: 'Nexus Health Passport share link: read-only FHIR R4 Bundle snapshot released by the patient. Not a full FHIR server.',
    rest: [{ mode: 'server', documentation: 'Read-only. A snapshot is fetched with GET /fhir/share/{token}. No search, no write.' }]
  });

  return { make, mineList, revoke, read, metadata, validate };
}
module.exports = function mountShare(app, deps) {
  const h = create(deps);
  app.post('/share/create', h.make); app.get('/share/mine', h.mineList); app.post('/share/revoke', h.revoke);
  app.get('/fhir/share/:token', h.read); app.get('/fhir/metadata', h.metadata);
  return h;
};
module.exports.create = create;

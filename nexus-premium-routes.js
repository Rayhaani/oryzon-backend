/* ============================================================
   nexus-premium-routes.js  - Nexus Health Plus / Premium backend
   Mount with ONE block in server.js (after mountHealth / mountVerify):

     const mountPremium = require('./nexus-premium-routes');
     mountPremium(app, {
       admin,
       adminUids: [ADMIN_UID],
       callModel: (model, messages, maxTokens, temp) => callGroqWithFailover(model, messages, maxTokens, temp),
       textModel: TEXT_MODEL_CHAIN.simple,
       visionModel: process.env.MEAL_VISION_MODEL || 'qwen/qwen3.8-27b',
       payments: { mode: 'free' }            // 'free' = nobody is charged yet (trial + admin grant only)
     });

   Data (all in your Realtime Database, written ONLY by this module through the Admin SDK, so no rules change is needed):
     subscriptions/{uid}                 { plan:'plus'|'premium', isPro:bool, status, source, startedAt, renewsAt, trialUsed }
                                         (isPro is kept in sync so your existing /ai-triage photo gate keeps working: isPro === plan 'premium')
     usage/{uid}/{YYYY-MM}/{key}         monthly counters (mealScan, coach)
     nutrition/{uid}/log/{date}/{id}     meals       nutrition/{uid}/goals   daily goals
     nutrition/{uid}/fasting             current fast

   Everything about plans, prices and limits is in PLANS below - change numbers in ONE place.
   ============================================================ */
'use strict';

/* ---------- THE ONE PLACE TO EDIT PLANS, PRICES AND LIMITS ---------- */
const PLANS = {
  free:    { rank: 0, price: null,                          caps: { mealScan: 3,   coach: 5   }, features: { logging: true, macros: false, fasting: false, insights: false, noAds: false, photoAI: false } },
  plus:    { rank: 1, price: { month: 9.99,  year: 79.99  }, caps: { mealScan: 60,  coach: 100 }, features: { logging: true, macros: true,  fasting: true,  insights: true,  noAds: true,  photoAI: false } },
  premium: { rank: 2, price: { month: 19.99, year: 149.99 }, caps: { mealScan: 200, coach: 400 }, features: { logging: true, macros: true,  fasting: true,  insights: true,  noAds: true,  photoAI: true  } }
};
const TRIAL = { plan: 'plus', days: 14 };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const DAY = 86400000;
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 10) / 10)) : 0; };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const monthKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);

const RED_FLAGS = /(chest pain|can'?t breathe|cannot breathe|difficulty breathing|suicid|kill myself|end my life|overdose|severe bleeding|unconscious|stroke|seizure|poison)/i;

function create(deps) {
  const { admin, adminUids = [], callModel, textModel, visionModel } = deps;
  const payCfg = deps.payments || { mode: 'free' };
  const rtdb = () => admin.database();
  const bad = (msg, status = 400) => { const e = new Error(msg); e.status = status; return e; };
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); } catch (e) { const s = e.status || 500; if (s === 500) console.error('[premium]', e); res.status(s).json({ error: s === 500 ? 'server_error' : e.message, ...(e.extra || {}) }); }
  };
  async function authUser(req) {
    const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) throw bad('unauthenticated', 401);
    try { return await admin.auth().verifyIdToken(m[1]); } catch (_) { throw bad('unauthenticated', 401); }
  }
  const isAdmin = t => !!t && (t.admin === true || adminUids.includes(t.uid));

  /* ---------- plan resolution ---------- */
  function resolve(sub, now = Date.now()) {
    let plan = 'free', status = 'none', renewsAt = null, source = null;
    if (sub) {
      plan = PLANS[sub.plan] ? sub.plan : (sub.isPro === true ? 'premium' : 'free');     // old accounts that only have isPro:true count as premium
      renewsAt = typeof sub.renewsAt === 'number' ? sub.renewsAt : null;
      source = sub.source || null;
      status = sub.status || (plan === 'free' ? 'none' : 'active');
      if (plan !== 'free' && renewsAt && renewsAt < now) { plan = 'free'; status = 'expired'; }       // expiry is computed on read, no cron needed
    }
    return { plan, status, renewsAt, source, trialUsed: !!(sub && sub.trialUsed) };
  }
  async function planOf(uid) { const s = await rtdb().ref('subscriptions/' + uid).once('value'); return resolve(s.val()); }
  async function writeSub(uid, patch) {
    const ref = rtdb().ref('subscriptions/' + uid);
    const cur = (await ref.once('value')).val() || {};
    const next = { ...cur, ...patch };
    next.isPro = next.plan === 'premium' && (!next.renewsAt || next.renewsAt > Date.now());     // keeps /ai-triage image gate working
    await ref.set(next);
    return next;
  }

  /* ---------- usage metering (atomic; refunded if the AI call fails) ---------- */
  async function consume(uid, key, cap) {
    if (!cap || cap <= 0) throw Object.assign(bad('limit_reached', 402), { extra: { used: 0, cap: cap || 0, key } });
    const ref = rtdb().ref('usage/' + uid + '/' + monthKey() + '/' + key);
    let over = false;
    const r = await ref.transaction(cur => { const n = Number(cur) || 0; if (n >= cap) { over = true; return; } return n + 1; });
    if (over || !r.committed) throw Object.assign(bad('limit_reached', 402), { extra: { cap, key } });
    return async () => { try { await ref.transaction(cur => Math.max(0, (Number(cur) || 0) - 1)); } catch (_) {} };
  }
  async function usageOf(uid) { const s = await rtdb().ref('usage/' + uid + '/' + monthKey()).once('value'); return s.val() || {}; }

  /* ---------- status ---------- */
  const status = async (req, res) => {
    const u = await authUser(req); const p = await planOf(u.uid); const use = await usageOf(u.uid); const def = PLANS[p.plan];
    res.json({
      ok: true, plan: p.plan, status: p.status, renewsAt: p.renewsAt, source: p.source,
      trialAvailable: !p.trialUsed && p.plan === 'free', trialDays: TRIAL.days,
      features: def.features, caps: def.caps, usage: { mealScan: use.mealScan || 0, coach: use.coach || 0 },
      prices: { plus: PLANS.plus.price, premium: PLANS.premium.price }, planCaps: { free: PLANS.free.caps, plus: PLANS.plus.caps, premium: PLANS.premium.caps }, paymentsEnabled: payCfg.mode === 'paid'
    });
  };
  const trial = async (req, res) => {
    const u = await authUser(req); const p = await planOf(u.uid);
    if (p.trialUsed) throw bad('trial_used', 409);
    if (p.plan !== 'free') throw bad('already_subscribed', 409);
    const next = await writeSub(u.uid, { plan: TRIAL.plan, status: 'trialing', source: 'trial', startedAt: Date.now(), renewsAt: Date.now() + TRIAL.days * DAY, trialUsed: true });
    res.json({ ok: true, plan: next.plan, renewsAt: next.renewsAt });
  };
  const adminGrant = async (req, res) => {
    const u = await authUser(req); if (!isAdmin(u)) throw bad('forbidden', 403);
    const b = req.body || {}; const uid = clip(b.uid, 128); const plan = b.plan;
    if (!uid || !/^[A-Za-z0-9_-]+$/.test(uid)) throw bad('bad_uid');
    if (plan === 'free') { await writeSub(uid, { plan: 'free', status: 'none', source: 'admin', renewsAt: null }); return res.json({ ok: true }); }
    if (!PLANS[plan]) throw bad('bad_plan');
    const days = b.days == null ? null : Number(b.days);
    if (days != null && !(days > 0 && days <= 3650)) throw bad('bad_days');
    const next = await writeSub(uid, { plan, status: 'active', source: 'admin', startedAt: Date.now(), renewsAt: days ? Date.now() + days * DAY : null });
    res.json({ ok: true, plan: next.plan, renewsAt: next.renewsAt });
  };

  /* ---------- Meal Scan (vision AI) ---------- */
  const SCAN_PROMPT = 'You are a nutrition estimator. Look at the meal photo and list each distinct food or drink you can see with a reasonable portion estimate. ' +
    'Reply with ONLY a JSON object, no markdown: {"items":[{"name":string,"grams":number,"kcal":number,"protein":number,"carbs":number,"fat":number}],"confidence":"low"|"medium"|"high","notes":string}. ' +
    'Protein, carbs and fat are grams. If the image is not food, return {"items":[],"confidence":"low","notes":"No food found"}. These are estimates; never claim precision.';
  function parseScan(raw) {
    const m = String(raw || '').replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    let j; try { j = JSON.parse(m[0]); } catch (_) { return null; }
    if (!j || !Array.isArray(j.items)) return null;
    const items = j.items.slice(0, 12).map(i => ({ name: clip(i && i.name, 60), grams: num(i && i.grams, 0, 3000), kcal: num(i && i.kcal, 0, 5000), protein: num(i && i.protein, 0, 500), carbs: num(i && i.carbs, 0, 800), fat: num(i && i.fat, 0, 500) })).filter(i => i.name);
    const total = items.reduce((t, i) => ({ kcal: t.kcal + i.kcal, protein: t.protein + i.protein, carbs: t.carbs + i.carbs, fat: t.fat + i.fat }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
    Object.keys(total).forEach(k => total[k] = Math.round(total[k] * 10) / 10);
    return { items, total, confidence: ['low', 'medium', 'high'].includes(j.confidence) ? j.confidence : 'low', notes: clip(j.notes, 200) };
  }
  const mealScan = async (req, res) => {
    const u = await authUser(req); const p = await planOf(u.uid);
    const image = String((req.body || {}).image || '');
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(image);
    if (!m) throw bad('bad_image');
    if (Math.floor(m[2].length * 3 / 4) > MAX_IMAGE_BYTES) throw bad('image_too_large', 413);
    const refund = await consume(u.uid, 'mealScan', PLANS[p.plan].caps.mealScan);
    let raw;
    try { raw = await callModel(visionModel, [{ role: 'system', content: SCAN_PROMPT }, { role: 'user', content: [{ type: 'text', text: 'Estimate this meal.' }, { type: 'image_url', image_url: { url: image } }] }], 700, 0.2); }
    catch (e) { await refund(); console.error('[premium] vision failed', e.message); throw bad('ai_unavailable', 503); }
    const out = parseScan(raw);
    if (!out) { await refund(); throw bad('could_not_read_meal', 422); }
    res.json({ ok: true, ...out, estimate: true });
  };

  /* ---------- Nutrition log, goals, fasting ---------- */
  const mealRef = (uid, date) => rtdb().ref('nutrition/' + uid + '/log/' + date);
  const addLog = async (req, res) => {
    const u = await authUser(req); const b = req.body || {};
    if (!isDate(b.date)) throw bad('bad_date');
    const name = clip(b.name, 80).trim(); if (!name) throw bad('missing_name');
    const entry = { name, meal: ['breakfast', 'lunch', 'dinner', 'snack'].includes(b.meal) ? b.meal : 'snack', kcal: num(b.kcal, 0, 6000), protein: num(b.protein, 0, 500), carbs: num(b.carbs, 0, 800), fat: num(b.fat, 0, 500), source: ['manual', 'scan'].includes(b.source) ? b.source : 'manual', at: Date.now() };
    const ref = mealRef(u.uid, b.date).push(); await ref.set(entry);
    res.json({ ok: true, id: ref.key, entry });
  };
  const dayLog = async (req, res) => {
    const u = await authUser(req); const date = req.query && req.query.date; if (!isDate(date)) throw bad('bad_date');
    const p = await planOf(u.uid); const val = (await mealRef(u.uid, date).once('value')).val() || {};
    const entries = Object.keys(val).map(id => ({ id, ...val[id] })).sort((a, b) => a.at - b.at);
    const tot = entries.reduce((t, e) => ({ kcal: t.kcal + e.kcal, protein: t.protein + e.protein, carbs: t.carbs + e.carbs, fat: t.fat + e.fat }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
    const g = (await rtdb().ref('nutrition/' + u.uid + '/goals').once('value')).val() || {};
    const macros = PLANS[p.plan].features.macros;
    res.json({ ok: true, date, entries, totals: macros ? tot : { kcal: tot.kcal }, goals: macros ? g : { kcal: g.kcal || null }, macrosLocked: !macros });
  };
  const delLog = async (req, res) => {
    const u = await authUser(req); const { date, id } = req.params; if (!isDate(date) || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw bad('bad_request');
    await mealRef(u.uid, date).child(id).remove(); res.json({ ok: true });
  };
  const setGoals = async (req, res) => {
    const u = await authUser(req); const p = await planOf(u.uid); const b = req.body || {};
    const goals = { kcal: num(b.kcal, 500, 10000) || null };
    if (PLANS[p.plan].features.macros) { goals.protein = num(b.protein, 0, 600) || null; goals.carbs = num(b.carbs, 0, 1000) || null; goals.fat = num(b.fat, 0, 600) || null; }
    else if (['protein', 'carbs', 'fat'].some(k => b[k] != null && b[k] !== '')) throw Object.assign(bad('plan_required', 402), { extra: { need: 'plus' } });
    const ref = rtdb().ref('nutrition/' + u.uid + '/goals'); const cur = (await ref.once('value')).val() || {};
    await ref.set({ ...cur, ...goals }); res.json({ ok: true, goals: { ...cur, ...goals } });
  };
  const needFeature = async (uid, f) => { const p = await planOf(uid); if (!PLANS[p.plan].features[f]) throw Object.assign(bad('plan_required', 402), { extra: { need: 'plus', feature: f } }); return p; };
  const fastGet = async (req, res) => { const u = await authUser(req); await needFeature(u.uid, 'fasting'); const f = (await rtdb().ref('nutrition/' + u.uid + '/fasting').once('value')).val(); res.json({ ok: true, fast: f || null }); };
  const fastStart = async (req, res) => {
    const u = await authUser(req); await needFeature(u.uid, 'fasting');
    const hours = Math.round(Number((req.body || {}).hours)); if (!(hours >= 1 && hours <= 72)) throw bad('bad_hours');
    const f = { startedAt: Date.now(), hours, endsAt: Date.now() + hours * 3600000 };
    await rtdb().ref('nutrition/' + u.uid + '/fasting').set(f); res.json({ ok: true, fast: f });
  };
  const fastStop = async (req, res) => { const u = await authUser(req); await needFeature(u.uid, 'fasting'); await rtdb().ref('nutrition/' + u.uid + '/fasting').remove(); res.json({ ok: true }); };

  /* ---------- Insights (nutrition part; needs Plus) ---------- */
  const insights = async (req, res) => {
    const u = await authUser(req); await needFeature(u.uid, 'insights');
    const days = Math.min(90, Math.max(7, parseInt(req.query && req.query.days, 10) || 7));
    const all = (await rtdb().ref('nutrition/' + u.uid + '/log').once('value')).val() || {};
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * DAY).toISOString().slice(0, 10); const day = all[d] || {};
      const t = Object.values(day).reduce((a, e) => ({ kcal: a.kcal + e.kcal, protein: a.protein + e.protein, carbs: a.carbs + e.carbs, fat: a.fat + e.fat }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
      out.push({ date: d, logged: Object.keys(day).length > 0, ...t });
    }
    const logged = out.filter(d => d.logged);
    const avg = k => logged.length ? Math.round(logged.reduce((s, d) => s + d[k], 0) / logged.length) : 0;
    res.json({ ok: true, days: out, daysLogged: logged.length, average: { kcal: avg('kcal'), protein: avg('protein'), carbs: avg('carbs'), fat: avg('fat') } });
  };

  /* ---------- AI Coach ---------- */
  const COACH_PROMPT = 'You are Nexus Coach, a supportive wellness coach for nutrition, sleep habits, movement and routines. You are NOT a doctor: never diagnose, never prescribe, never change medication advice. ' +
    'Give short, practical, encouraging answers (under 150 words) grounded in the data provided when it is relevant. If the person describes symptoms or asks a medical question, tell them to use the Health assistant or see a clinician. ' +
    'Answer in the language the person writes in.';
  const coach = async (req, res) => {
    const u = await authUser(req); const p = await planOf(u.uid); const b = req.body || {};
    const message = clip(b.message, 800).trim(); if (!message) throw bad('missing_message');
    if (RED_FLAGS.test(message)) return res.json({ ok: true, emergency: true, reply: 'This sounds like it could be serious. Please contact your local emergency number or go to the nearest emergency service now. If you can, tell someone near you.' });
    const history = (Array.isArray(b.history) ? b.history : []).slice(-8).map(m => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', content: clip(m && m.content, 600) }));
    const refund = await consume(u.uid, 'coach', PLANS[p.plan].caps.coach);
    let ctx = '';
    try {
      const all = (await rtdb().ref('nutrition/' + u.uid + '/log').once('value')).val() || {};
      const g = (await rtdb().ref('nutrition/' + u.uid + '/goals').once('value')).val() || {};
      const lines = []; for (let i = 6; i >= 0; i--) { const d = new Date(Date.now() - i * DAY).toISOString().slice(0, 10); const es = Object.values(all[d] || {}); if (es.length) lines.push(d + ': ' + Math.round(es.reduce((s, e) => s + e.kcal, 0)) + ' kcal, ' + Math.round(es.reduce((s, e) => s + e.protein, 0)) + ' g protein'); }
      if (lines.length) ctx = '\n\nThe person\'s logged intake, last 7 days:\n' + lines.join('\n'); if (g.kcal) ctx += '\nDaily calorie goal: ' + g.kcal;
    } catch (_) {}
    let reply;
    try { reply = await callModel(textModel, [{ role: 'system', content: COACH_PROMPT + ctx }, ...history, { role: 'user', content: message }], 500, 0.5); }
    catch (e) { await refund(); console.error('[premium] coach failed', e.message); throw bad('ai_unavailable', 503); }
    const use = await usageOf(u.uid);
    res.json({ ok: true, reply: clip(reply, 2000), usage: { used: use.coach || 0, cap: PLANS[p.plan].caps.coach } });
  };

  return { status, trial, adminGrant, mealScan, addLog, dayLog, delLog, setGoals, fastGet, fastStart, fastStop, insights, coach, resolve, PLANS, parseScan };
}

module.exports = function mountPremium(app, deps) {
  const h = create(deps); const w = fn => async (req, res) => { try { await fn(req, res); } catch (e) { const s = e.status || 500; if (s === 500) console.error('[premium]', e); res.status(s).json({ error: s === 500 ? 'server_error' : e.message, ...(e.extra || {}) }); } };
  app.get('/premium/status', w(h.status));
  app.post('/premium/trial', w(h.trial));
  app.post('/premium/admin/grant', w(h.adminGrant));
  app.post('/premium/meal-scan', w(h.mealScan));
  app.post('/premium/nutrition/log', w(h.addLog));
  app.get('/premium/nutrition/day', w(h.dayLog));
  app.delete('/premium/nutrition/log/:date/:id', w(h.delLog));
  app.post('/premium/nutrition/goals', w(h.setGoals));
  app.get('/premium/fasting', w(h.fastGet));
  app.post('/premium/fasting/start', w(h.fastStart));
  app.post('/premium/fasting/stop', w(h.fastStop));
  app.get('/premium/insights', w(h.insights));
  app.post('/premium/coach', w(h.coach));
  return h;
};
module.exports.create = create;
module.exports.PLANS = PLANS;

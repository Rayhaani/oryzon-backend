/* ============================================================
   health-premium.js — Nexus Health+ (additive; load AFTER health-care.js)
   One card on the Health home opens a full-screen panel with 3 tabs:
     Plans · Nutrition (log, Meal Scan, macros, fasting) · Coach (AI)
   Everything is decided by the backend (/premium/*): this file only shows what the server says.
   Prices, limits and plan names come from the server, so nothing is hard-coded here.
   Needs: nexus-premium-routes.js mounted on the backend.
   ============================================================ */
(function () {
  'use strict';
  if (window.__nxPremium) return; window.__nxPremium = 1;

  var BACKEND = 'https://oryzon-backend-ed1q.onrender.com';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var toast = function (m) { try { window.showToast(m); } catch (e) {} };
  var today = function () { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  var money = function (n) { return '$' + (Math.round(n * 100) / 100).toString(); };
  var S = { tab: 'plans', st: null, day: null, fast: null, scan: null, chat: [], busy: false, ins: null };

  /* ---------- styles (injected once, scoped with .nxp-) ---------- */
  var CSS = '.nxp-tabs{display:flex;gap:8px;margin:0 0 16px;overflow-x:auto}.nxp-tab{flex:0 0 auto;padding:9px 16px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:none;color:rgba(255,255,255,.55);font-size:13px;font-weight:700;cursor:pointer}.nxp-tab.on{color:#fde08d;border-color:#fde08d}' +
    '.nxp-card{background:#121212;border-radius:20px;padding:16px;margin-bottom:12px;box-shadow:6px 6px 14px #000,-4px -4px 10px #1b1b1b}.nxp-pill{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#fde08d;border:1px solid rgba(253,224,141,.4);border-radius:99px;padding:3px 9px}' +
    '.nxp-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.07);font-size:13px;color:rgba(255,255,255,.85)}.nxp-row:last-child{border:0}.nxp-k{color:rgba(255,255,255,.5)}.nxp-lock{color:#fde08d;font-size:11px;font-weight:800;text-transform:uppercase}' +
    '.nxp-btn{display:block;width:100%;text-align:center;border:0;border-radius:999px;padding:14px;font-size:14px;font-weight:800;cursor:pointer;background:#fde08d;color:#1a1400;margin-top:10px}.nxp-btn.c{background:#00f2ff;color:#001}.nxp-btn.o{background:none;color:#fff;border:1px solid rgba(255,255,255,.18)}.nxp-btn[disabled]{opacity:.5}' +
    '.nxp-bar{height:8px;border-radius:9px;background:rgba(255,255,255,.08);overflow:hidden;margin-top:6px}.nxp-bar i{display:block;height:100%;background:#00f2ff}.nxp-big{font-size:30px;font-weight:800;color:#fff}.nxp-sub{font-size:12px;color:rgba(255,255,255,.5);line-height:1.5}' +
    '.nxp-bub{font-size:14px;line-height:1.5;padding:10px 13px;border-radius:18px;margin-bottom:8px;max-width:88%;white-space:pre-wrap}.nxp-u{background:rgba(0,242,255,.14);margin-left:auto;color:#fff}.nxp-a{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:rgba(255,255,255,.9)}' +
    '.nxp-in{display:flex;gap:8px;margin-top:10px}.nxp-in input{flex:1}.nxp-in button{width:auto;padding:0 18px;margin:0}.nxp-warn{font-size:11px;color:rgba(255,255,255,.45);margin-top:10px;line-height:1.5}' +
    '.nxp-g2{display:grid;grid-template-columns:1fr 1fr;gap:8px}.nxp-g2>*,.nxp-in>*{min-width:0}#nxPrem .nx-field{box-sizing:border-box;width:100%}.nxp-plan.cur{border:1px solid #00f2ff}';
  function injectCss() { if ($('nxpCss')) return; var s = document.createElement('style'); s.id = 'nxpCss'; s.textContent = CSS; document.head.appendChild(s); }

  /* ---------- backend ---------- */
  async function api(path, method, body) {
    var u = await window._authReadyPromise; if (!u) throw Object.assign(new Error('login'), { status: 401 });
    var t = await u.getIdToken();
    var r = await fetch(BACKEND + path, { method: method || 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: body ? JSON.stringify(body) : undefined });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(j.error || 'failed'); e.status = r.status; e.data = j; throw e; }
    return j;
  }
  var ERR = { login: 'Please log in first.', limit_reached: 'You have used all of this month\'s uses of this feature.', plan_required: 'This feature needs Nexus Health+.', ai_unavailable: 'The AI is busy right now. Please try again in a moment.', could_not_read_meal: 'We could not read that photo. Try a clearer photo of the food.', image_too_large: 'That photo is too large.', bad_image: 'Please choose a photo (JPG, PNG or WebP).', trial_used: 'Your free trial was already used.', missing_name: 'Please enter a name.' };
  var errMsg = function (e) { return ERR[e.message] || 'Something went wrong. Please try again.'; };

  /* ---------- shell ---------- */
  var SHELL = '<div id="nxPrem" class="nx-modal hidden" role="dialog" aria-modal="true"><div class="nx-modal-inner"><header class="nxh-bar"><button type="button" class="back-trigger" aria-label="Back" onclick="nxPremium.close()"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 4L7 12l10 8"/></svg></button><div class="header-left-dock"><div class="header-details"><div class="group-title-row"><span class="group-title">Nexus Health+</span></div><div class="group-subtitle" id="nxpSub"></div></div></div></header><div class="nxp-tabs" id="nxpTabs"></div><div id="nxpBody"></div></div></div>';
  function ensureUI() {
    var pc = $('page-content'); if (!pc) return; injectCss();
    if (!$('nxPrem')) pc.insertAdjacentHTML('beforeend', SHELL);
    var anchor = document.querySelector('.feature-card[onclick*="openProfiles"]');
    if (anchor && !document.querySelector('[data-nx-prem]')) anchor.insertAdjacentHTML('beforebegin', '<div class="feature-card" data-nx-prem="1" style="--card-accent:#fde08d;" onclick="nxPremium.open()" role="button" tabindex="0" onkeydown="if(event.key===\'Enter\')nxPremium.open()"><div class="fi-box"><i class="fa-solid fa-gem" style="color:#fde08d"></i></div><h3 class="futuristic-font text-[13px] font-bold">Nexus Health+</h3><p class="text-[12px] text-gray-500 mt-1">Nutrition, Meal Scan &amp; AI Coach</p></div>');
  }

  /* ---------- tabs ---------- */
  var TABS = [['plans', 'Plans'], ['nutrition', 'Nutrition'], ['coach', 'Coach']];
  function render() {
    $('nxpTabs').innerHTML = TABS.map(function (t) { return '<button type="button" class="nxp-tab' + (S.tab === t[0] ? ' on' : '') + '" onclick="nxPremium.tab(\'' + t[0] + '\')">' + t[1] + '</button>'; }).join('');
    var st = S.st; $('nxpSub').textContent = st ? (st.plan === 'free' ? 'Free plan' : (st.plan === 'plus' ? 'Plus' : 'Premium') + (st.status === 'trialing' ? ' · trial' : '')) : '';
    if (!st) { $('nxpBody').innerHTML = '<div class="nxp-sub">Loading…</div>'; return; }
    if (S.tab === 'plans') plans(); else if (S.tab === 'nutrition') nutrition(); else coach();
  }

  /* ---------- Plans ---------- */
  function feat(label, plan) { return '<div class="nxp-row"><span>' + label + '</span><span class="nxp-lock">' + plan + '</span></div>'; }
  function plans() {
    var st = S.st, p = st.prices || {}, pc = st.planCaps || { plus: {}, premium: {} }, b = '';
    b += '<div class="nxp-sub" style="margin-bottom:14px">Free is always yours: medication reminders, backup, emergency info and the doctor directory.</div>';
    b += '<div class="nxp-card">' + feat('Meal Scan, macros &amp; goals', 'Plus') + feat('Intermittent fasting', 'Plus') + feat('Nutrition insights', 'Plus') + feat('AI Coach (' + pc.plus.coach + ' messages / month)', 'Plus') + feat('No ads', 'Plus') + feat('Medical photo &amp; lab-report analysis', 'Premium') + feat('AI Coach (' + pc.premium.coach + ' messages / month)', 'Premium') + '</div>';
    ['plus', 'premium'].forEach(function (k) {
      var pr = p[k]; if (!pr) return; var cur = st.plan === k;
      b += '<div class="nxp-card nxp-plan' + (cur ? ' cur' : '') + '"><div style="display:flex;justify-content:space-between"><b style="color:#fff;text-transform:capitalize">' + k + '</b>' + (cur ? '<span class="nxp-pill">Your plan</span>' : (k === 'plus' ? '<span class="nxp-pill">Popular</span>' : '')) + '</div>' +
        '<div class="nxp-big">' + money(pr.month) + '<span class="nxp-sub"> / month</span></div><div class="nxp-sub">or ' + money(pr.year) + ' / year</div></div>';
    });
    if (st.trialAvailable) b += '<button class="nxp-btn" id="nxpTrial" onclick="nxPremium.trial()">Start ' + st.trialDays + '-day free trial of Plus</button>';
    else if (st.plan === 'free') b += '<div class="nxp-sub" style="text-align:center">Subscriptions open soon. You will be able to subscribe right here.</div>';
    if (st.plan !== 'free' && st.renewsAt) b += '<div class="nxp-sub" style="text-align:center;margin-top:10px">' + (st.status === 'trialing' ? 'Trial ends ' : 'Access until ') + esc(new Date(st.renewsAt).toLocaleDateString()) + '</div>';
    if (!st.paymentsEnabled) b += '<div class="nxp-warn">Payments are not switched on yet, so nobody is charged.</div>';
    $('nxpBody').innerHTML = b;
  }

  /* ---------- Nutrition ---------- */
  async function loadDay() { try { S.day = await api('/premium/nutrition/day?date=' + today()); } catch (e) { S.day = { entries: [], totals: { kcal: 0 }, goals: {}, macrosLocked: true, err: 1 }; } }
  function nutrition() {
    var st = S.st, d = S.day; if (!d) { $('nxpBody').innerHTML = '<div class="nxp-sub">Loading…</div>'; loadDay().then(render); return; }
    var f = st.features, t = d.totals || {}, g = d.goals || {}, kc = Math.round(t.kcal || 0), pct = g.kcal ? Math.min(100, Math.round(kc / g.kcal * 100)) : 0, b = '';
    b += '<div class="nxp-card"><div class="nxp-big">' + kc + '<span class="nxp-sub"> kcal today' + (g.kcal ? ' of ' + g.kcal : '') + '</span></div>' + (g.kcal ? '<div class="nxp-bar"><i style="width:' + pct + '%"></i></div>' : '');
    if (f.macros) b += '<div class="nxp-row"><span class="nxp-k">Protein</span><span>' + Math.round(t.protein || 0) + (g.protein ? ' / ' + g.protein : '') + ' g</span></div><div class="nxp-row"><span class="nxp-k">Carbs</span><span>' + Math.round(t.carbs || 0) + (g.carbs ? ' / ' + g.carbs : '') + ' g</span></div><div class="nxp-row"><span class="nxp-k">Fat</span><span>' + Math.round(t.fat || 0) + (g.fat ? ' / ' + g.fat : '') + ' g</span></div>';
    else b += '<div class="nxp-row"><span class="nxp-k">Protein, carbs &amp; fat</span><span class="nxp-lock">Plus</span></div>';
    b += '</div>';
    var left = Math.max(0, st.caps.mealScan - st.usage.mealScan);
    b += '<input id="nxpFile" type="file" accept="image/*" capture="environment" style="display:none" onchange="nxPremium.pick(this)"><button class="nxp-btn c" onclick="document.getElementById(\'nxpFile\').click()"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Reading your meal…' : 'Scan a meal') + ' <span style="font-weight:600">· ' + left + ' left this month</span></button>';
    if (S.scan) b += scanCard(S.scan);
    b += '<div class="nxp-card" style="margin-top:12px"><div class="nxp-sub" style="margin-bottom:8px">Add manually</div><input id="nxpName" class="nx-field" placeholder="Food or drink" maxlength="80"><div class="nxp-g2" style="margin-top:8px"><input id="nxpKcal" class="nx-field" type="number" inputmode="decimal" placeholder="kcal">' + (f.macros ? '<input id="nxpPro" class="nx-field" type="number" inputmode="decimal" placeholder="Protein g">' : '<span></span>') + '</div>' + (f.macros ? '<div class="nxp-g2" style="margin-top:8px"><input id="nxpCarb" class="nx-field" type="number" inputmode="decimal" placeholder="Carbs g"><input id="nxpFat" class="nx-field" type="number" inputmode="decimal" placeholder="Fat g"></div>' : '') + '<button class="nxp-btn o" onclick="nxPremium.addManual()">Add</button></div>';
    if (d.entries.length) b += '<div class="nxp-card"><div class="nxp-sub" style="margin-bottom:4px">Today</div>' + d.entries.map(function (e) { return '<div class="nxp-row"><span>' + esc(e.name) + (e.source === 'scan' ? ' <span class="nxp-k">· scan</span>' : '') + '</span><span>' + Math.round(e.kcal) + ' kcal <button class="nx-link" style="display:inline;margin:0 0 0 8px;font-size:12px" onclick="nxPremium.del(\'' + esc(e.id) + '\')">remove</button></span></div>'; }).join('') + '</div>';
    b += '<div class="nxp-card"><div class="nxp-sub" style="margin-bottom:8px">Daily goal</div><div class="nxp-g2"><input id="nxpGk" class="nx-field" type="number" inputmode="numeric" placeholder="kcal" value="' + esc(g.kcal || '') + '">' + (f.macros ? '<input id="nxpGp" class="nx-field" type="number" inputmode="numeric" placeholder="Protein g" value="' + esc(g.protein || '') + '">' : '<span class="nxp-lock" style="align-self:center">Macro goals · Plus</span>') + '</div>' + (f.macros ? '<div class="nxp-g2" style="margin-top:8px"><input id="nxpGc" class="nx-field" type="number" inputmode="numeric" placeholder="Carbs g" value="' + esc(g.carbs || '') + '"><input id="nxpGf" class="nx-field" type="number" inputmode="numeric" placeholder="Fat g" value="' + esc(g.fat || '') + '"></div>' : '') + '<button class="nxp-btn o" onclick="nxPremium.saveGoals()">Save goal</button></div>';
    b += fastCard(f) + insightsCard(f);
    b += '<div class="nxp-warn">Calories and nutrients from photos are estimates, not exact measurements. Not medical advice.</div>';
    $('nxpBody').innerHTML = b;
  }
  function scanCard(sc) {
    return '<div class="nxp-card" style="margin-top:12px"><div style="display:flex;justify-content:space-between"><b style="color:#fff">We found</b><span class="nxp-pill">' + esc(sc.confidence) + ' confidence</span></div>' +
      sc.items.map(function (i) { return '<div class="nxp-row"><span>' + esc(i.name) + ' <span class="nxp-k">~' + Math.round(i.grams) + ' g</span></span><span>' + Math.round(i.kcal) + ' kcal</span></div>'; }).join('') +
      '<div class="nxp-row"><b>Total (estimate)</b><b>' + Math.round(sc.total.kcal) + ' kcal</b></div>' + (sc.notes ? '<div class="nxp-sub">' + esc(sc.notes) + '</div>' : '') +
      (sc.items.length ? '<button class="nxp-btn" onclick="nxPremium.saveScan()">Add to today</button>' : '') + '<button class="nxp-btn o" onclick="nxPremium.dropScan()">Discard</button></div>';
  }
  function fastCard(f) {
    if (!f.fasting) return '<div class="nxp-card"><div class="nxp-row"><span>Intermittent fasting</span><span class="nxp-lock">Plus</span></div></div>';
    var x = S.fast;
    if (x && x.fast) { var left = Math.max(0, x.fast.endsAt - Date.now()), h = Math.floor(left / 3600000), m = Math.floor(left % 3600000 / 60000); return '<div class="nxp-card"><b style="color:#fff">Fasting ' + x.fast.hours + ' h</b><div class="nxp-big">' + (left ? h + 'h ' + m + 'm left' : 'Done!') + '</div><div class="nxp-bar"><i style="width:' + Math.min(100, Math.round((1 - left / (x.fast.hours * 3600000)) * 100)) + '%"></i></div><button class="nxp-btn o" onclick="nxPremium.fastStop()">End fast</button></div>'; }
    if (!x) { api('/premium/fasting').then(function (r) { S.fast = r; render(); }).catch(function () { S.fast = { fast: null }; }); return '<div class="nxp-card"><div class="nxp-sub">Loading fasting…</div></div>'; }
    return '<div class="nxp-card"><b style="color:#fff">Intermittent fasting</b><div class="nxp-g2" style="margin-top:10px">' + [12, 14, 16, 18].map(function (h) { return '<button class="nxp-btn o" style="margin:0" onclick="nxPremium.fastStart(' + h + ')">' + h + ' hours</button>'; }).join('') + '</div></div>';
  }
  function insightsCard(f) {
    if (!f.insights) return '<div class="nxp-card"><div class="nxp-row"><span>Nutrition insights</span><span class="nxp-lock">Plus</span></div></div>';
    if (!S.ins) { api('/premium/insights?days=7').then(function (r) { S.ins = r; render(); }).catch(function () { S.ins = { days: [], average: {}, daysLogged: 0 }; }); return '<div class="nxp-card"><div class="nxp-sub">Loading insights…</div></div>'; }
    var i = S.ins, max = Math.max.apply(null, i.days.map(function (d) { return d.kcal; }).concat([1]));
    return '<div class="nxp-card"><b style="color:#fff">Last 7 days</b><div style="height:70px;display:flex;align-items:flex-end;gap:6px;margin:10px 0">' + i.days.map(function (d) { return '<i style="flex:1;height:' + Math.max(4, Math.round(d.kcal / max * 100)) + '%;background:#00f2ff;opacity:' + (d.logged ? .8 : .15) + ';border-radius:5px"></i>'; }).join('') + '</div><div class="nxp-sub">' + (i.daysLogged ? 'Average on days you logged: ' + i.average.kcal + ' kcal · ' + i.average.protein + ' g protein' : 'Log meals to see your trend.') + '</div></div>';
  }

  /* ---------- Coach ---------- */
  function coach() {
    var st = S.st, cap = st.caps.coach, used = st.usage.coach, b = '';
    b += '<div class="nxp-card"><div class="nxp-sub">AI usage this month</div><div class="nxp-bar"><i style="width:' + Math.min(100, Math.round(used / Math.max(1, cap) * 100)) + '%"></i></div><div class="nxp-row" style="border:0"><span>' + used + ' of ' + cap + ' messages</span>' + (st.plan !== 'premium' ? '<span class="nxp-lock">More with a plan</span>' : '') + '</div></div>';
    b += '<div id="nxpChat">' + (S.chat.length ? S.chat.map(function (m) { return '<div class="nxp-bub ' + (m.role === 'user' ? 'nxp-u' : 'nxp-a') + '">' + esc(m.content) + '</div>'; }).join('') : '<div class="nxp-sub">Ask about meals, routines, sleep habits or motivation. For symptoms, use the Health assistant.</div>') + (S.busy ? '<div class="nxp-bub nxp-a">…</div>' : '') + '</div>';
    b += '<div class="nxp-in"><input id="nxpMsg" class="nx-field" maxlength="800" placeholder="Message your coach" onkeydown="if(event.key===\'Enter\')nxPremium.send()"><button class="nxp-btn c" onclick="nxPremium.send()"' + (S.busy ? ' disabled' : '') + '>Send</button></div>';
    b += '<div class="nxp-warn">General wellness guidance, not a diagnosis. In an emergency call your local emergency number.</div>';
    $('nxpBody').innerHTML = b;
  }

  /* ---------- image helper: shrink on the phone first (saves data and AI cost) ---------- */
  function shrink(file) {
    return new Promise(function (res, rej) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () { var m = 1024, r = Math.min(1, m / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = Math.round(img.width * r); c.height = Math.round(img.height * r); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.8)); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('bad_image')); }; img.src = url;
    });
  }

  /* ---------- actions ---------- */
  async function refresh() { try { S.st = await api('/premium/status'); } catch (e) { if (e.status === 401) toast(ERR.login); S.st = S.st || null; } render(); }
  window.nxPremium = {
    open: async function () { ensureUI(); $('nxPrem').classList.remove('hidden'); document.body.style.overflow = 'hidden'; S.day = null; S.fast = null; S.ins = null; render(); await refresh(); },
    close: function () { var m = $('nxPrem'); if (m) m.classList.add('hidden'); document.body.style.overflow = 'auto'; },
    tab: function (t) { S.tab = t; render(); },
    trial: async function () { var b = $('nxpTrial'); if (b) b.disabled = true; try { await api('/premium/trial', 'POST', {}); toast('Your free trial has started.'); S.day = null; await refresh(); } catch (e) { toast(errMsg(e)); if (b) b.disabled = false; } },
    pick: async function (inp) {
      var f = inp.files && inp.files[0]; inp.value = ''; if (!f || S.busy) return; S.busy = true; S.scan = null; render();
      try { var img = await shrink(f); var r = await api('/premium/meal-scan', 'POST', { image: img }); S.scan = r; if (!r.items.length) toast('No food found in that photo.'); }
      catch (e) { toast(errMsg(e)); }
      S.busy = false; await refresh();
    },
    dropScan: function () { S.scan = null; render(); },
    saveScan: async function () {
      var sc = S.scan; if (!sc) return;
      try { for (var i = 0; i < sc.items.length; i++) { var x = sc.items[i]; await api('/premium/nutrition/log', 'POST', { date: today(), name: x.name, kcal: x.kcal, protein: x.protein, carbs: x.carbs, fat: x.fat, source: 'scan' }); } S.scan = null; S.day = null; S.ins = null; toast('Added to today.'); render(); }
      catch (e) { toast(errMsg(e)); }
    },
    addManual: async function () {
      var v = function (id) { var e = $(id); return e ? e.value : ''; };
      try { await api('/premium/nutrition/log', 'POST', { date: today(), name: v('nxpName'), kcal: v('nxpKcal'), protein: v('nxpPro'), carbs: v('nxpCarb'), fat: v('nxpFat'), source: 'manual' }); S.day = null; S.ins = null; render(); }
      catch (e) { toast(errMsg(e)); }
    },
    del: async function (id) { try { await api('/premium/nutrition/log/' + today() + '/' + encodeURIComponent(id), 'DELETE'); S.day = null; S.ins = null; render(); } catch (e) { toast(errMsg(e)); } },
    saveGoals: async function () {
      var v = function (id) { var e = $(id); return e ? e.value : ''; };
      try { await api('/premium/nutrition/goals', 'POST', { kcal: v('nxpGk'), protein: v('nxpGp'), carbs: v('nxpGc'), fat: v('nxpGf') }); S.day = null; toast('Goal saved.'); render(); }
      catch (e) { toast(errMsg(e)); }
    },
    fastStart: async function (h) { try { var r = await api('/premium/fasting/start', 'POST', { hours: h }); S.fast = r; render(); } catch (e) { toast(errMsg(e)); } },
    fastStop: async function () { try { await api('/premium/fasting/stop', 'POST', {}); S.fast = { fast: null }; render(); } catch (e) { toast(errMsg(e)); } },
    send: async function () {
      var i = $('nxpMsg'), m = i && i.value.trim(); if (!m || S.busy) return; i.value = ''; S.chat.push({ role: 'user', content: m }); S.busy = true; render();
      try {
        var r = await api('/premium/coach', 'POST', { message: m, history: S.chat.slice(0, -1).slice(-8) });
        S.chat.push({ role: 'assistant', content: r.reply }); if (r.usage) S.st.usage.coach = r.usage.used;
      } catch (e) {
        if (e.message === 'limit_reached') S.chat.push({ role: 'assistant', content: 'You have used all of this month\'s coach messages.' });
        else S.chat.push({ role: 'assistant', content: errMsg(e) });
      }
      S.busy = false; render();
    }
  };

  ensureUI();
  try { new MutationObserver(function () { if ($('page-content') && !$('nxPrem')) ensureUI(); }).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
})();

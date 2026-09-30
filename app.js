"use strict";
/* ---------- roster: owner-only, comes from roster.js in the repo ---------- */
const ROSTER = (window.ROSTER || []).map((p, i) => ({ id: p.id || String(p.name).toLowerCase().replace(/\W+/g, '-'), name: p.name, subtitle: p.subtitle || '', description: p.description || '', image: p.image || '', snapchat: String(p.snapchat || '').replace(/^@/, '').trim(), createdAt: i }));

/* ---------- storage adapters (votes only) ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { throw new Error('storage-full'); } }
};
const localAdapter = (() => {
  let vcb = [];
  const votes = () => LS.get('chad:votes', {});
  return {
    mode: 'local', userId: 'local', canWrite: true,
    onRoster(cb) { setTimeout(() => cb(ROSTER), 0); },
    onVotes(cb) { vcb.push(cb); setTimeout(() => cb(votes()), 0); },
    async setMyVote(doc) { const v = votes(); v.local = doc; LS.set('chad:votes', v); vcb.forEach(f => f(v)); }
  };
})();
async function firebaseAdapter(cfg) {
  const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const [A, Au, F] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js')]);
  const app = A.initializeApp(cfg), auth = Au.getAuth(app), db = F.getFirestore(app);
  await auth.authStateReady();
  const uid = (auth.currentUser || (await Au.signInAnonymously(auth)).user).uid;
  return {
    mode: 'shared', userId: uid, canWrite: null,
    onRoster(cb) { setTimeout(() => cb(ROSTER), 0); },
    onVotes(cb, onErr) {
      F.onSnapshot(F.collection(db, 'votes'), snap => { const o = {}; snap.forEach(d => o[d.id] = d.data()); cb(o); },
        e => { onErr && onErr(e); cb({}); });
    },
    setMyVote(d) { return F.setDoc(F.doc(db, 'votes', uid), d); }
  };
}

/* ---------- constants & state ---------- */
const DEF = { psl: 4, appeal: 5 };
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = s => document.querySelector(s);
const view = $('#view'), dlg = $('#dlg');
const ptsFor = (i, N) => N > 1 ? (N - 1 - i) / (N - 1) * 100 : 100;
const TOP = 950; // realistic ceiling: 1000 is out of reach
const tot = v => v * TOP / 100, T0 = v => Math.round(tot(v));
const fmt = n => Number.isFinite(n) ? n.toFixed(1) : '–';
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
let storage = localAdapter, diagMsg = '', votesError = '';
let roster = [], votes = {}, rosterLoaded = false, votesLoaded = false;
let myOrder = [], mySkip = [], dirty = false, mineInit = false, openId = null, tab = 'official';
let dragging = false, sliding = false, pendingRender = false, statusMsg = '', statusKind = '', statusTimer = null, statusFresh = false, focusKey = null;
let queue = Promise.resolve(), lastDoc = null, animate = true, submittedOnce = false;
const prevNums = {}, openRate = new Set(), shakeIds = new Set();
const byId = id => roster.find(p => p.id === id);
const myDoc = () => votes[storage.userId] || lastDoc || { order: [], scores: {} };
const rated = (sc, id) => Number.isFinite((sc[id] || {}).psl) && Number.isFinite((sc[id] || {}).appeal);

/* ---------- helpers ---------- */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const k in (props || {})) {
    const v = props[k];
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, ''); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  kids.flat().forEach(c => { if (c != null && c !== false) e.append(c); });
  return e;
}
function setStatus(msg, kind) {
  statusMsg = msg; statusKind = kind; statusFresh = true; clearTimeout(statusTimer);
  if (kind === 'ok') statusTimer = setTimeout(() => { statusMsg = ''; statusKind = ''; render(); }, 3500);
  render();
}
function errMsg(e) {
  const m = String((e && (e.code || e.message)) || e);
  if (/permission|denied/i.test(m)) return "You don't have permission to save. Check the Firestore rules in the README.";
  if (/full|quota/i.test(m)) return 'The database is full, so this could not be saved.';
  return "Couldn't save (" + m + ')';
}
// a face exists only when the owner set an image; no image means nothing is drawn and no space is kept
function face(p, cls) {
  if (!p.image) return null;
  const i = h('img', { class: 'face ' + (cls || ''), src: p.image, alt: '', loading: 'lazy', decoding: 'async' });
  i.addEventListener('error', () => i.remove());
  return i;
}

/* ---------- aggregation ---------- */
function aggregate() {
  const ids = new Set(roster.map(p => p.id));
  const st = {}; roster.forEach(p => st[p.id] = { p, pts: 0, n: 0, ps: 0, pn: 0, as: 0, an: 0 });
  let ballots = 0;
  Object.keys(votes).sort().map(k => votes[k]).forEach(v => {
    const ord = (v.order || []).filter(id => ids.has(id));
    if (ord.length) ballots++;
    const sc = v.scores || {};
    ord.forEach((id, i) => {
      st[id].pts += ptsFor(i, ord.length); st[id].n++;
      const s = sc[id] || {};
      if (Number.isFinite(s.psl)) { st[id].ps += clamp(s.psl, 1, 8); st[id].pn++; }
      if (Number.isFinite(s.appeal)) { st[id].as += clamp(s.appeal, 1, 10); st[id].an++; }
    });
  });
  const all = Object.values(st);
  all.forEach(s => { s.ptsAvg = s.n ? s.pts / s.n : null; s.psl = s.pn ? s.ps / s.pn : null; s.appeal = s.an ? s.as / s.an : null; });
  const nameCmp = (a, b) => a.p.name.localeCompare(b.p.name);
  const ranked = all.filter(s => s.n).sort((a, b) => b.ptsAvg - a.ptsAvg || b.n - a.n || nameCmp(a, b));
  const rankBy = key => {
    const list = all.filter(s => s[key] != null).sort((a, b) => b[key] - a[key] || nameCmp(a, b));
    const m = {}; list.forEach((s, i) => m[s.p.id] = i + 1); return { m, total: list.length };
  };
  return { ballots, ranked, unranked: all.filter(s => !s.n).sort(nameCmp), st, ov: rankBy('ptsAvg'), pr: rankBy('psl'), ar: rankBy('appeal') };
}

/* ---------- writes (serialized) ---------- */
function write(build, okMsg) {
  if (storage.canWrite === false) return setStatus("You don't have permission to save.", 'err');
  if (!storage.userId) return setStatus("Couldn't identify you, so nothing can be saved.", 'err');
  queue = queue.then(async () => {
    try {
      const doc = build(myDoc()); doc.updatedAt = Date.now(); lastDoc = doc;
      await storage.setMyVote(doc);
      if (okMsg) { dirty = false; submittedOnce = true; fx.burst(innerWidth / 2, innerHeight - 90); setStatus(okMsg, 'ok'); } else render();
    } catch (e) { setStatus(errMsg(e), 'err'); }
  });
}
const known = () => roster.map(p => p.id);
async function submit() {
  const sc = myDoc().scores || {};
  const missing = myOrder.filter(id => !rated(sc, id));
  if (missing.length) {
    const nm = missing.map(id => byId(id).name), shown = nm.slice(0, 6).join(', ') + (nm.length > 6 ? ' +' + (nm.length - 6) + ' more' : '');
    const go = await confirmBox('Submit without PSL and Appeal?', 'These people are missing a PSL and/or Appeal score: ' + shown + '. Your order still counts, but their PSL and Appeal averages will not include you. You can add scores later and update your ranking.', 'Submit anyway', 'Go back and rate');
    if (!go) {
      shakeIds.clear(); missing.forEach(id => shakeIds.add(id)); openRate.add(missing[0]); render();
      requestAnimationFrame(() => { const el = view.querySelector('[data-id="' + missing[0] + '"]'); if (el) el.scrollIntoView({ behavior: RM ? 'auto' : 'smooth', block: 'center' }); });
      return;
    }
  }
  write(d => ({ order: myOrder.slice(), scores: d.scores || {}, known: known() }), 'Ballot saved. Thanks!');
}
function saveScore(id, key, val) {
  write(d => {
    const sc = { ...(d.scores || {}) }; sc[id] = { ...(sc[id] || {}), [key]: val };
    return { order: d.order || [], scores: sc, known: d.known || known() };
  });
}

/* ---------- ballot state ---------- */
function tryInit() {
  if (mineInit || !rosterLoaded || !votesLoaded) return;
  mineInit = true;
  const mine = votes[storage.userId] || {}, saved = mine.order || [], ids = roster.map(p => p.id);
  if (saved.length) {
    const seen = mine.known || ids;
    myOrder = saved.filter(id => ids.includes(id));
    mySkip = ids.filter(id => !myOrder.includes(id) && seen.includes(id));
    ids.forEach(id => { if (!myOrder.includes(id) && !mySkip.includes(id)) myOrder.push(id); });
  } else { myOrder = ids.slice(); mySkip = []; }
}
function move(id, dir) {
  const i = myOrder.indexOf(id), j = i + dir;
  if (j < 0 || j >= myOrder.length) return;
  [myOrder[i], myOrder[j]] = [myOrder[j], myOrder[i]]; dirty = true; focusKey = (dir < 0 ? 'up' : 'dn') + id; render();
}
function skip(id) { myOrder = myOrder.filter(x => x !== id); mySkip.push(id); dirty = true; render(); }
function rank(id) { mySkip = mySkip.filter(x => x !== id); myOrder.push(id); dirty = true; render(); }

/* ---------- drag ---------- */
function startDrag(ev, list, row) {
  ev.preventDefault(); dragging = true;
  const handle = ev.currentTarget; handle.setPointerCapture(ev.pointerId); row.classList.add('drag');
  const relabel = () => [...list.children].forEach((li, i) => {
    li.querySelector('.rk').textContent = i + 1;
    li.querySelector('.pts').textContent = T0(ptsFor(i, list.children.length)) + ' pts';
  });
  const onMove = e => {
    const sib = [...list.children].filter(c => c !== row);
    const next = sib.find(c => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    if (next) { if (row.nextSibling !== next) list.insertBefore(row, next); } else list.appendChild(row);
    relabel();
  };
  const onUp = () => {
    handle.removeEventListener('pointermove', onMove); handle.removeEventListener('pointerup', onUp); handle.removeEventListener('pointercancel', onUp);
    myOrder = [...list.children].map(li => li.dataset.id); dirty = true; dragging = false; pendingRender = false; render();
  };
  handle.addEventListener('pointermove', onMove); handle.addEventListener('pointerup', onUp); handle.addEventListener('pointercancel', onUp);
}

/* ---------- tab 2: my ranking (rating list + skip list) ---------- */
function rating(id) {
  const sc = (myDoc().scores || {})[id] || {};
  const slider = (key, label, min, max) => {
    const isSet = Number.isFinite(sc[key]);
    const val = h('b', { text: isSet ? sc[key].toFixed(1) : '—' });
    const inp = h('input', { type: 'range', min, max, step: 0.5, value: isSet ? sc[key] : DEF[key], 'aria-label': label + ' rating' });
    const lab = h('label', { class: isSet ? '' : 'unset' }, label, inp, val);
    inp.addEventListener('input', () => {
      val.textContent = (+inp.value).toFixed(1); lab.classList.remove('unset');
      if (!RM) val.animate([{ transform: 'scale(1.4)' }, { transform: 'scale(1)' }], { duration: 200 });
    });
    inp.addEventListener('change', () => saveScore(id, key, +inp.value));
    // releasing on the default value fires no change event, so confirm it here
    inp.addEventListener('pointerup', () => { if (!isSet && +inp.value === DEF[key]) saveScore(id, key, DEF[key]); });
    return lab;
  };
  const both = rated({ [id]: sc }, id), some = Number.isFinite(sc.psl) || Number.isFinite(sc.appeal);
  const summ = h('summary', {}, h('span', { text: 'PSL & Appeal' }),
    h('span', { class: 'rsum' + (both ? ' ok' : ''), text: both ? '✓ PSL ' + fmt(sc.psl) + ' · Appeal ' + fmt(sc.appeal) : some ? 'One more to set' : 'Required' }));
  const d = h('details', { class: 'rate' }, summ, h('div', { class: 'rate-body' }, slider('psl', 'PSL', 1, 8), slider('appeal', 'Appeal', 1, 10)));
  if (openRate.has(id)) d.open = true;
  d.addEventListener('toggle', () => { if (d.open) openRate.add(id); else openRate.delete(id); });
  return d;
}
function snap(p, big) {
  if (!p.snapchat) return null;
  return h('a', { class: 'snap' + (big ? ' big' : ''), href: 'https://www.snapchat.com/add/' + encodeURIComponent(p.snapchat), target: '_blank', rel: 'noopener noreferrer',
    onclick: e => e.stopPropagation(), 'aria-label': 'Snapchat ' + p.snapchat }, h('span', { class: 'gh', text: '👻' }), '@' + p.snapchat);
}
function nameBlock(p) {
  return h('div', { class: 'who' }, h('button', { class: 'link', text: p.name, onclick: () => showPerson(p.id) }), p.subtitle ? h('small', { text: p.subtitle }) : null, snap(p));
}
function mineView() {
  const sc = myDoc().scores || {}, N = myOrder.length, done = myOrder.filter(id => rated(sc, id)).length;
  const rlist = h('ol');
  myOrder.forEach((id, i) => {
    const p = byId(id); if (!p) return;
    const row = h('li', { class: 'row glow' + (rated(sc, id) ? '' : ' need') + (shakeIds.has(id) ? ' shake' : ''), 'data-id': id, 'data-flip': 'my:' + id, style: '--i:' + i });
    const handle = h('span', { class: 'handle', text: '⠿', 'aria-hidden': 'true' });
    handle.addEventListener('pointerdown', e => startDrag(e, rlist, row));
    row.append(handle, h('span', { class: 'rk', text: i + 1 }), face(p, 'sm'), nameBlock(p),
      h('span', { class: 'pts', text: T0(ptsFor(i, N)) + ' pts' }),
      h('button', { class: 'ghost', text: 'Skip →', 'aria-label': 'Skip ' + p.name, onclick: () => skip(id) }),
      h('span', { class: 'arrows' },
        h('button', { class: 'ghost', text: '▲', 'aria-label': 'Move ' + p.name + ' up', 'data-key': 'up' + id, onclick: () => move(id, -1) }),
        h('button', { class: 'ghost', text: '▼', 'aria-label': 'Move ' + p.name + ' down', 'data-key': 'dn' + id, onclick: () => move(id, 1) })),
      rating(id));
    rlist.append(row);
  });
  const slist = h('ul');
  mySkip.forEach((id, i) => {
    const p = byId(id); if (!p) return;
    slist.append(h('li', { class: 'row glow', 'data-flip': 'my:' + id, style: '--i:' + i }, face(p, 'sm'), nameBlock(p),
      h('button', { class: 'ghost', text: '← Rank them', 'aria-label': 'Rank ' + p.name, onclick: () => rank(id) })));
  });
  const hasSaved = (myDoc().order || []).length > 0 || submittedOnce;
  const btn = h('button', { class: 'btn', text: hasSaved ? 'Update ranking' : 'Submit ranking', onclick: submit });
  if (hasSaved && !dirty) btn.disabled = true;
  return h('div', {},
    h('p', { class: 'sub rise', style: '--i:0', text: 'Drag people into your order, best first. PSL and Appeal scores are optional, but you will get a warning if you submit without them. People in the Skip list are left out.' }),
    h('div', { class: 'cols' },
      h('section', { class: 'card rise', style: '--i:1' }, h('h2', { text: 'Rating list · ' + N }),
        h('p', { class: 'sub', text: 'Best at the top: the top spot earns 950 points, the bottom 0. A perfect 1000 is out of reach.' }),
        N ? rlist : h('p', { class: 'empty', text: 'Nobody here yet. Bring people over from the Skip list, or submit an empty ranking.' })),
      h('section', { class: 'card rise', style: '--i:2' }, h('h2', { text: 'Skip list · ' + mySkip.length }),
        h('p', { class: 'sub', text: 'Left out of your ranking. No ratings needed.' }),
        mySkip.length ? slist : h('p', { class: 'empty', text: 'Nobody skipped. Everyone is in your rating list.' }))),
    h('div', { class: 'submitbar rise', style: '--i:3' },
      h('div', { class: 'meter' }, h('small', { text: N ? done + ' of ' + N + ' rated (optional)' : 'Empty ranking' }), h('div', {}, h('i', { style: '--w:' + (N ? done / N * 100 : 100) + '%' }))),
      btn, h('div', { class: 'status ' + statusKind + (statusFresh ? ' in' : ''), 'aria-live': 'polite', text: statusMsg })));
}

/* ---------- tab 1: official ranking ---------- */
function ticker(a) {
  let seq = []; const items = a.ranked.map((s, i) => [i + 1, s.p.name, s.ptsAvg]);
  while (seq.length < 10) seq = seq.concat(items);
  const mk = () => seq.map(([r, n, pt]) => h('span', { class: 'tk' }, h('b', { text: '#' + r }), ' ' + n + ' ', h('i', { text: T0(pt) })));
  return h('div', { class: 'ticker rise', style: '--i:0' }, h('div', { class: 'tkrow', style: '--dur:' + seq.length * 3 + 's' }, mk(), mk()));
}
function officialView(a) {
  const top = a.ranked.slice(0, 3), rest = a.ranked.slice(3);
  const stat = (n, label) => h('span', { class: 'stat' }, h('b', { 'data-count': n, 'data-dec': 0, 'data-ck': 's' + label, text: n }), label);
  const out = [];
  if (a.ranked.length) out.push(ticker(a));
  out.push(h('div', { class: 'stats rise', style: '--i:0' }, stat(a.ballots, a.ballots === 1 ? 'ballot' : 'ballots'), stat(roster.length, 'people')));
  if (!a.ranked.length) {
    out.push(h('div', { class: 'card hero0 rise', style: '--i:1' }, h('div', { class: 'big', text: '🗳️' }), h('h2', { text: 'No ballots yet' }),
      h('p', { class: 'sub', text: 'Be the first to vote and the official ranking appears here.' }),
      h('button', { class: 'btn', text: 'Go to My Ranking', onclick: () => { location.hash = '#mine'; } })));
  } else {
    out.push(h('div', { class: 'podium' }, [1, 0, 2].filter(i => top[i]).map(i => {
      const s = top[i];
      return h('button', { class: 'pod glow p' + (i + 1), 'data-rank': i + 1, 'data-flip': 'gen:' + s.p.id, style: '--i:' + i, 'aria-label': 'Open ' + s.p.name, onclick: () => showPerson(s.p.id) },
        i === 0 ? h('span', { class: 'crownbig', text: '👑' }) : null, h('span', { class: 'medal', text: i + 1 }), face(s.p),
        h('div', { class: 'pn', text: s.p.name }), s.p.subtitle ? h('small', { text: s.p.subtitle }) : null,
        s.p.snapchat ? h('small', { class: 'snap', text: '👻 @' + s.p.snapchat }) : null,
        h('div', { class: 'pp', 'data-count': tot(s.ptsAvg), 'data-dec': 0, 'data-ck': 'g' + s.p.id, text: T0(s.ptsAvg) }),
        h('small', { text: 'pts · ' + s.n + (s.n === 1 ? ' ballot' : ' ballots') }));
    })));
    if (rest.length) {
      const list = h('ol');
      rest.forEach((s, j) => {
        list.append(h('li', { class: 'row glow click', 'data-flip': 'gen:' + s.p.id, style: '--i:' + j, onclick: () => showPerson(s.p.id) },
          h('span', { class: 'rk', text: j + 4 }), face(s.p),
          h('div', { class: 'who' }, h('button', { class: 'link', text: s.p.name, onclick: e => { e.stopPropagation(); showPerson(s.p.id); } }),
            s.p.subtitle ? h('small', { text: s.p.subtitle }) : null, snap(s.p), h('div', { class: 'pbar' }, h('i', { style: '--w:' + s.ptsAvg + '%' }))),
          h('span', { class: 'score' }, h('b', { 'data-count': tot(s.ptsAvg), 'data-dec': 0, 'data-ck': 'g' + s.p.id, text: T0(s.ptsAvg) }), h('small', { text: 'pts · ' + s.n + (s.n === 1 ? ' ballot' : ' ballots') }))));
      });
      out.push(h('div', { class: 'card rise', style: '--i:3' }, list));
    }
  }
  if (a.unranked.length) out.push(h('div', { class: 'rise', style: '--i:4;margin-top:16px' }, h('p', { class: 'sub', text: 'Waiting for votes' }),
    h('div', { class: 'chips' }, a.unranked.map(s => h('button', { class: 'chip', text: s.p.name, onclick: () => showPerson(s.p.id) })))));
  return h('div', {}, out);
}

/* ---------- person window ---------- */
function showPerson(id) { openId = id; fillDialog(true); if (!dlg.open) dlg.showModal(); }
function closeDlg() {
  if (!dlg.open) return;
  if (RM) { dlg.close(); return; }
  dlg.classList.add('closing'); setTimeout(() => { dlg.close(); dlg.classList.remove('closing'); }, 220);
}
function fillDialog(swap) {
  const a = aggregate(), s = a.st[openId];
  if (!s) { closeDlg(); return; }
  const order = a.ranked.concat(a.unranked).map(x => x.p.id), idx = order.indexOf(openId);
  const step = d => { openId = order[(idx + d + order.length) % order.length]; fillDialog(true); };
  const mine = (myDoc().scores || {})[openId], inOrder = myOrder.includes(openId);
  const tile = (t, v, sm, pct) => h('div', { class: 'tile' }, h('small', { text: t }), h('b', { text: v }),
    pct != null ? h('div', { class: 'pbar' }, h('i', { style: '--w:' + pct + '%' })) : null, h('small', { text: sm }));
  const p = s.p;
  let img = null;
  if (p.image) { const i = h('img', { src: p.image, alt: p.name }); img = h('div', { class: 'mimg' }, i); i.addEventListener('error', () => img.remove()); }
  const body = h('div', { class: 'mbody' + (swap ? ' swap' : '') }, img,
    h('div', { class: 'minfo' }, h('h2', { text: p.name }), p.subtitle ? h('div', { class: 'msub', text: p.subtitle }) : null, snap(p, true),
      p.description ? h('p', { class: 'desc', text: p.description }) : null,
      h('div', { class: 'big', 'data-count': tot(s.ptsAvg ?? 0), 'data-dec': 0, 'data-ck': 'm', text: s.ptsAvg == null ? '–' : T0(s.ptsAvg) }),
      h('p', { class: 'sub', text: 'points out of 1000 · higher is better' }),
      h('div', { class: 'tiles' },
        tile('Overall rank', a.ov.m[openId] ? '#' + a.ov.m[openId] + ' of ' + a.ov.total : 'Not ranked yet', s.n + (s.n === 1 ? ' ballot' : ' ballots'), s.ptsAvg),
        tile('PSL', s.psl == null ? '–' : fmt(s.psl) + ' / 8', (a.pr.m[openId] ? '#' + a.pr.m[openId] + ' of ' + a.pr.total + ' · ' : '') + s.pn + ' votes', s.psl == null ? 0 : s.psl / 8 * 100),
        tile('Appeal', s.appeal == null ? '–' : fmt(s.appeal) + ' / 10', (a.ar.m[openId] ? '#' + a.ar.m[openId] + ' of ' + a.ar.total + ' · ' : '') + s.an + ' votes', s.appeal == null ? 0 : s.appeal / 10 * 100),
        tile('Your rating', mine && inOrder && rated({ x: mine }, 'x') ? fmt(mine.psl) + ' · ' + fmt(mine.appeal) : 'Not rated', 'PSL · Appeal'))));
  dlg.replaceChildren(h('div', { class: 'mwin' },
    h('button', { class: 'mclose', text: '✕', 'aria-label': 'Close', onclick: closeDlg }), body,
    h('button', { class: 'mnav l', text: '‹', 'aria-label': 'Previous person', onclick: () => step(-1) }),
    h('button', { class: 'mnav r', text: '›', 'aria-label': 'Next person', onclick: () => step(1) })));
  countUps(dlg, swap);
}
dlg.addEventListener('cancel', e => { e.preventDefault(); closeDlg(); });
dlg.addEventListener('click', e => { if (e.target === dlg) closeDlg(); });
dlg.addEventListener('close', () => { openId = null; });
dlg.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') dlg.querySelector('.mnav.l')?.click(); else if (e.key === 'ArrowRight') dlg.querySelector('.mnav.r')?.click();
});

/* ---------- effects ---------- */
const fx = (() => {
  const cv = $('#fx'), c = cv.getContext('2d'); let W = 0, H = 0, dots = [], bits = [], cols = ['#ffd23f', '#4f7cff', '#fff'];
  const size = () => { const r = devicePixelRatio || 1; W = innerWidth; H = innerHeight; cv.width = W * r; cv.height = H * r; c.setTransform(r, 0, 0, r, 0, 0); };
  const colors = () => { const s = getComputedStyle(document.documentElement); cols = ['--accent', '--blue', '--ink'].map(k => s.getPropertyValue(k).trim()); };
  size(); colors();
  for (let i = 0; i < 44; i++) dots.push({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 2 + .6, vx: (Math.random() - .5) * .15, vy: -Math.random() * .3 - .05, t: Math.random() * 6 });
  (function loop() {
    requestAnimationFrame(loop);
    if (document.hidden || RM) return;
    c.clearRect(0, 0, W, H);
    dots.forEach(d => { d.x += d.vx; d.y += d.vy; d.t += .02; if (d.y < -5) { d.y = H + 5; d.x = Math.random() * W; }
      c.globalAlpha = .3 + .3 * Math.sin(d.t); c.fillStyle = cols[0]; c.beginPath(); c.arc(d.x, d.y, d.r, 0, 7); c.fill(); });
    bits = bits.filter(p => p.l > 0);
    bits.forEach(p => { p.x += p.vx; p.y += p.vy; p.vy += .13; p.l--; p.a += .2;
      c.globalAlpha = Math.max(0, p.l / 70); c.fillStyle = p.c; c.save(); c.translate(p.x, p.y); c.rotate(p.a); c.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); c.restore(); });
  })();
  addEventListener('resize', size);
  return { colors, burst(x, y) { if (RM) return; for (let i = 0; i < 90; i++) { const an = Math.random() * 6.283, sp = Math.random() * 8 + 2; bits.push({ x, y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp - 6, l: 70, c: cols[i % 3], s: Math.random() * 8 + 4, a: 0 }); } } };
})();
document.addEventListener('pointermove', e => {
  const g = e.target.closest && e.target.closest('.glow'); if (!g) return;
  const r = g.getBoundingClientRect(); g.style.setProperty('--mx', (e.clientX - r.left) + 'px'); g.style.setProperty('--my', (e.clientY - r.top) + 'px');
  if (g.classList.contains('pod') && !RM) { g.style.setProperty('--rx', (-((e.clientY - r.top) / r.height - .5) * 14) + 'deg'); g.style.setProperty('--ry', (((e.clientX - r.left) / r.width - .5) * 14) + 'deg'); }
});
document.addEventListener('pointerout', e => {
  const t = e.target.closest && e.target.closest('.pod');
  if (t && !t.contains(e.relatedTarget)) { t.style.setProperty('--rx', '0deg'); t.style.setProperty('--ry', '0deg'); }
});
function countUps(root, fresh) {
  root.querySelectorAll('[data-count]').forEach(el => {
    const to = +el.dataset.count, dec = +el.dataset.dec || 0, k = el.dataset.ck;
    const from = fresh ? 0 : (prevNums[k] ?? 0); prevNums[k] = to;
    if (RM || from === to) return;
    const t0 = performance.now();
    (function step(t) {
      const p = Math.min(1, (t - t0) / 900), e = 1 - Math.pow(1 - p, 3);
      el.textContent = (from + (to - from) * e).toFixed(dec);
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  });
}

/* ---------- chrome: tabs, theme ---------- */
function hint(e) {
  const c = String((e && (e.code || e.message)) || e);
  if (/admin-restricted-operation/.test(c)) return 'Firebase blokkeert nieuwe anonieme gebruikers. Firebase > Authentication > Settings > User actions > zet "Enable create (sign-up)" AAN > Save. Controleer ook Sign-in method > Anonymous = Enabled.';
  if (/operation-not-allowed/.test(c)) return 'Anonymous sign-in is not enabled: Firebase > Build > Authentication > Sign-in method > Anonymous > Enable > Save.';
  if (/configuration-not-found/.test(c)) return 'Authentication is not set up yet: Firebase > Build > Authentication > click Get started, then enable Anonymous.';
  if (/unauthorized-domain/.test(c)) return 'Your website domain is not authorized: Authentication > Settings > Authorized domains > add yourname.github.io.';
  if (/api-key|invalid-api|app-not-authorized/.test(c)) return 'The values in config.js look wrong. Copy the config block again from Project settings > General > Your apps.';
  if (/permission-denied/.test(c)) return 'Firestore rules are missing or not published: Firestore Database > Rules > paste the rules > Publish.';
  if (/not-found|failed-precondition/.test(c)) return 'Firestore database is not created yet: Build > Firestore Database > Create database.';
  if (/fetch|import|network/i.test(c)) return 'Could not load Firebase from Google. Check your connection or turn off an ad blocker for this site.';
  return '';
}
function syncDiag() {
  const el = $('#diag'), t = [diagMsg, votesError].filter(Boolean).join(' ');
  el.hidden = !t; el.textContent = t;
}
function syncTabs() {
  document.querySelectorAll('.tab').forEach(t => { const on = t.dataset.tab === tab; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); });
  const on = document.querySelector('.tab.on'), ind = $('#ind');
  if (on) { ind.style.width = on.offsetWidth + 'px'; ind.style.transform = 'translateX(' + on.offsetLeft + 'px)'; }
  const m = $('#mode'); m.className = 'mode' + (storage.mode === 'shared' ? ' live' : '');
  m.lastChild.textContent = storage.mode === 'shared' ? 'Live · shared votes' : window.FIREBASE_CONFIG ? 'Offline · Firebase error' : 'Offline · no Firebase config';
}
function syncTheme() { $('#theme').setAttribute('aria-pressed', document.documentElement.getAttribute('data-theme') === 'light'); }
$('#theme').addEventListener('click', e => {
  const b = e.currentTarget, r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  const root = document.documentElement, next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  const apply = () => { root.setAttribute('data-theme', next); try { localStorage.setItem('chad-theme', next); } catch (er) {} syncTheme(); fx.colors(); };
  const R = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const clip = [`circle(0px at ${x}px ${y}px)`, `circle(${R}px at ${x}px ${y}px)`], opt = { duration: 750, easing: 'cubic-bezier(.65,0,.2,1)' };
  if (RM) { apply(); return; }
  fx.burst(x, y);
  if (document.startViewTransition) {
    document.startViewTransition(apply).ready.then(() => root.animate({ clipPath: clip }, { ...opt, pseudoElement: '::view-transition-new(root)' }));
  } else {
    const o = h('div', { class: 'wipe' }); o.style.background = next === 'light' ? '#f1f5ff' : '#060b1f'; document.body.append(o);
    o.animate({ clipPath: clip }, opt);
    setTimeout(() => { apply(); o.animate({ opacity: [1, 0] }, { duration: 250 }); setTimeout(() => o.remove(), 250); }, opt.duration);
  }
});
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => { location.hash = '#' + t.dataset.tab; }));
function splitTitle() {
  const w = $('#title .w'); if (!w) return; const t = w.textContent; w.textContent = '';
  [...t].forEach((c, i) => w.append(h('span', { class: 'ch', style: '--d:' + i, text: c })));
}
function readTab() { return location.hash === '#mine' ? 'mine' : 'official'; }
addEventListener('hashchange', () => { tab = readTab(); animate = true; window.scrollTo(0, 0); render(); });
addEventListener('resize', syncTabs);

/* ---------- render ---------- */
function render() {
  if (dragging || sliding) { pendingRender = true; return; }
  const ready = rosterLoaded && votesLoaded && mineInit;
  const enter = ready && animate && !RM;
  if (ready && animate) animate = false;
  if (enter) Object.keys(prevNums).forEach(k => delete prevNums[k]);
  syncTabs(); syncDiag();
  const scrollY = window.scrollY, old = {};
  view.querySelectorAll('[data-flip]').forEach(e => { old[e.dataset.flip] = e.getBoundingClientRect(); });
  let content;
  if (!ready) content = h('div', {}, h('div', { class: 'skel' }), h('div', { class: 'skel' }), h('div', { class: 'skel' }));
  else if (!roster.length) content = h('p', { class: 'empty', text: window.ROSTER ? 'The roster is empty. Check back soon.' : "roster.js didn't load. Make sure it sits next to index.html in the repo." });
  else content = tab === 'mine' ? mineView() : officialView(aggregate());
  view.className = enter ? 'enter' : '';
  view.replaceChildren(content);
  statusFresh = false;
  window.scrollTo(0, scrollY);
  if (!enter && !RM) view.querySelectorAll('[data-flip]').forEach(e => {
    const o = old[e.dataset.flip]; if (!o) return;
    const n = e.getBoundingClientRect(), dx = o.left - n.left, dy = o.top - n.top;
    if (Math.abs(dx) + Math.abs(dy) > 1) e.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], { duration: 450, easing: 'cubic-bezier(.2,.8,.2,1)' });
  });
  countUps(view, enter);
  if (dlg.open && openId) fillDialog(false);
  if (focusKey) { const b = view.querySelector('[data-key="' + focusKey + '"]'); if (b) b.focus(); focusKey = null; }
}
document.addEventListener('pointerdown', e => { if (e.target.type === 'range') sliding = true; });
addEventListener('pointerup', () => { sliding = false; if (!dragging && pendingRender) { pendingRender = false; setTimeout(render, 60); } });
addEventListener('pointercancel', () => { sliding = false; });

/* ---------- boot ---------- */
(async function boot() {
  tab = readTab(); syncTheme(); syncTabs(); splitTitle();
  if (!window.FIREBASE_CONFIG) {
    diagMsg = 'Votes are not shared: config.js contains no Firebase settings. Make sure config.js has your config, is committed to the repo, and that you hard refreshed (Ctrl+Shift+R). Open /config.js on your site to check what is really published.';
  } else {
    try { storage = await firebaseAdapter(window.FIREBASE_CONFIG); }
    catch (e) { console.warn(e); diagMsg = 'Shared voting failed to start (' + (e.code || e.message) + '). ' + hint(e); }
  }
  storage.onRoster(list => { roster = list; rosterLoaded = true; tryInit(); render(); });
  storage.onVotes(v => { votes = v; votesLoaded = true; tryInit(); render(); },
    e => { votesError = "Couldn't load everyone's ballots (" + (e.code || e.message) + '). ' + hint(e); syncDiag(); });
})();

/* ---------- confirm dialog ---------- */
function confirmBox(title, text, yes, no) {
  return new Promise(res => {
    const d = $('#ask'); let val = false;
    d.replaceChildren(h('div', { class: 'tw' }, h('div', { class: 'tp' }, h('span', { class: 'ic', text: '⚠️' }), h('h2', { text: title }), h('p', { text })),
      h('div', { class: 'tf' }, h('span', { class: 'sp' }), h('button', { class: 'ghost', text: no, onclick: () => d.close() }), h('button', { class: 'btn', text: yes, onclick: () => { val = true; d.close(); } }))));
    d.addEventListener('close', () => res(val), { once: true });
    d.showModal();
  });
}

/* ---------- tutorial (auto-shows on the first 2 visits, reopen with the ? button) ---------- */
const TOUR = [
  { ic: '👑', t: 'Welcome to Chad Ranking', p: ['A ranking of the friend group, made by the friend group.', 'Everyone puts the others in order. All those personal rankings are merged into one shared ranking that looks the same on every phone and computer.'], li: ['<b>Official Ranking</b>: the result of everybody', '<b>My Ranking</b>: your own vote'] },
  { ic: '🏆', t: 'The Official Ranking', p: ['The first tab shows the combined result.'], li: ['The <b>top 3</b> stand on the podium: gold, silver and bronze', 'Everybody else follows in the list below, and the ticker scrolls the standings', 'Tap a name to open a <b>profile pop-up</b> with a big photo, points, ranks and the PSL and Appeal averages', 'Updates live when someone votes'] },
  { ic: '🔢', t: 'How the points work', p: ['Every ballot gives points by position: the top spot earns <b>950</b>, the bottom spot <b>0</b>, and everyone in between gets a fair share.', 'The total you see is the average over all ballots. A perfect 1000 is out of reach, so a score in the 700s or 800s is already very strong. More ballots make the ranking more accurate.'] },
  { ic: '🗳️', t: 'Your own ranking', p: ['Open the <b>My Ranking</b> tab. It has two lists:'], li: ['<b>Rating list</b>: people you want to rank. Drag them (or use the arrows) with the best at the top', '<b>Skip list</b>: people you do not want to judge. They are left out of your ballot and nothing is needed for them', 'Move people between the lists with the buttons on each row'] },
  { ic: '🎚️', t: 'PSL and Appeal', p: ['For everybody in your Rating list you can add two scores. Open the small rating window on a row to set them:'], li: ['<b>PSL</b> (1 to 8): the looks score', '<b>Appeal</b> (1 to 10): overall charm and vibe', 'Half points are allowed', 'They do not change the order or the points. They show up as averages in the profile pop-up'] },
  { ic: '✅', t: 'Submitting your ranking', p: ['Press <b>Submit ranking</b> when your order is ready.', 'PSL and Appeal are <b>optional</b>. If some are missing you get a warning and can still submit anyway, or go back and fill them in.'], li: ['You can change your order later and press <b>Update ranking</b>', 'You get one ballot per browser. Clearing your browser data starts a fresh ballot'] },
  { ic: '💡', t: 'Good to know', p: [], li: ['The badge at the top says <b>Live</b> when votes are shared, or <b>Offline</b> when something is wrong', 'The sun/moon button switches between dark and light theme', 'Only the owner can change names, photos and descriptions', 'Press the <b>?</b> button at the top any time to see this tutorial again'] }
];
function initTour() {
  const T = $('#tour'); let i = 0;
  const html = (str) => { const s = document.createElement('span'); s.innerHTML = str; return s; };
  function draw(back) {
    const pg = TOUR[i], last = i === TOUR.length - 1;
    const body = h('div', { class: 'tp' + (back ? ' back' : '') }, h('span', { class: 'ic', text: pg.ic }), h('h2', { text: pg.t }));
    pg.p.forEach(x => { const p = h('p'); p.append(html(x)); body.append(p); });
    if (pg.li) { const ul = h('ul'); pg.li.forEach(x => { const li = h('li'); li.append(html(x)); ul.append(li); }); body.append(ul); }
    const dots = h('div', { class: 'dots' }); TOUR.forEach((_, k) => dots.append(h('i', { class: k === i ? 'on' : '' })));
    T.replaceChildren(h('div', { class: 'tw' }, body, dots, h('div', { class: 'tf' },
      last ? null : h('button', { class: 'ghost', text: 'Skip tutorial', onclick: () => T.close() }),
      h('span', { class: 'sp tcount', text: (i + 1) + ' / ' + TOUR.length }),
      i ? h('button', { class: 'ghost', text: 'Back', onclick: () => { i--; draw(true); } }) : null,
      h('button', { class: 'btn', text: last ? 'Start ranking' : 'Next →', onclick: () => { if (last) T.close(); else { i++; draw(false); } } }))));
  }
  function open() { i = 0; draw(false); if (!T.open) T.showModal(); }
  T.addEventListener('keydown', e => { if (e.key === 'ArrowRight' && i < TOUR.length - 1) { i++; draw(false); } else if (e.key === 'ArrowLeft' && i > 0) { i--; draw(true); } });
  $('#help').addEventListener('click', open);
  let v = 0, ok = true;
  try { v = (+localStorage.getItem('chad-visits') || 0) + 1; localStorage.setItem('chad-visits', String(v)); } catch (e) { ok = false; }
  if (ok && v <= 2) setTimeout(open, 700);
}
initTour();

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

/* ---------- constants & state ---------- */
const DEF = { psl: 4, appeal: 5 };
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = s => document.querySelector(s);
const view = $('#view'), dlg = $('#dlg');
const ptsFor = (i, N) => N > 1 ? (N - 1 - i) / (N - 1) * 100 : 100;
// realistic score: 350 (last) to 870 (unanimous first), always with 2 decimals, never 0
const tot = v => 350 + 520 * Math.pow(Math.min(100, Math.max(0, v)) / 100, 0.9), T0 = v => tot(v).toFixed(2);
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
  return h('div', { class: 'who' }, h('button', { class: 'link', text: p.name, onclick: () => showPerson(p.id) }), p.subtitle ? h('small', { text: p.subtitle }) : null, p.description ? h('small', { class: 'pdesc', text: p.description }) : null);
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
        h('p', { class: 'sub', text: 'Best at the top. Your first pick is worth ' + T0(100) + ' points, your last pick ' + T0(0) + '.' }),
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
        h('div', { class: 'pp', 'data-count': tot(s.ptsAvg), 'data-dec': 2, 'data-ck': 'g' + s.p.id, text: T0(s.ptsAvg) }),
        h('small', { text: 'pts · ' + s.n + (s.n === 1 ? ' ballot' : ' ballots') }));
    })));
    if (rest.length) {
      const list = h('ol');
      rest.forEach((s, j) => {
        list.append(h('li', { class: 'row glow click', 'data-flip': 'gen:' + s.p.id, style: '--i:' + j, onclick: () => showPerson(s.p.id) },
          h('span', { class: 'rk', text: j + 4 }), face(s.p),
          h('div', { class: 'who' }, h('button', { class: 'link', text: s.p.name, onclick: e => { e.stopPropagation(); showPerson(s.p.id); } }),
            s.p.subtitle ? h('small', { text: s.p.subtitle }) : null, h('div', { class: 'pbar' }, h('i', { style: '--w:' + s.ptsAvg + '%' }))),
          h('span', { class: 'score' }, h('b', { 'data-count': tot(s.ptsAvg), 'data-dec': 2, 'data-ck': 'g' + s.p.id, text: T0(s.ptsAvg) }), h('small', { text: 'pts · ' + s.n + (s.n === 1 ? ' ballot' : ' ballots') }))));
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
      h('div', { class: 'big', 'data-count': tot(s.ptsAvg ?? 0), 'data-dec': 2, 'data-ck': 'm', text: s.ptsAvg == null ? '–' : T0(s.ptsAvg) }),
      h('p', { class: 'sub', text: 'points · higher is better' }),
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
    bits.forEach(p => { if (p.d) { p.vx *= .985; p.vy = Math.min(p.vy, 4.5); p.x += Math.sin(p.a) * 1.3; } p.x += p.vx; p.y += p.vy; p.vy += .13; p.l--; p.a += .2;
      c.globalAlpha = Math.min(1, Math.max(0, p.l / 40)); c.fillStyle = p.c; c.save(); c.translate(p.x, p.y); c.rotate(p.a); c.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); c.restore(); });
  })();
  const PAL = ['#ffd23f', '#4f7cff', '#ffffff', '#ff6b6b', '#2ee6a6', '#c77dff'];
  const piece = (x, y, vx, vy, l, d) => bits.push({ x, y, vx, vy, l, c: PAL[Math.random() * PAL.length | 0], s: Math.random() * 9 + 5, a: Math.random() * 6, d });
  function party() {
    if (RM) return; cv.classList.add('top');
    const shoot = () => { const x = W * (.12 + Math.random() * .76), y = H * (.2 + Math.random() * .35); for (let k = 0; k < 70; k++) { const an = Math.random() * 6.283, sp = Math.random() * 9 + 3; piece(x, y, Math.cos(an) * sp, Math.sin(an) * sp - 5, 80); } };
    for (let k = 0; k < 7; k++) setTimeout(shoot, k * 260);
    for (let w = 0; w < 3; w++) setTimeout(() => { for (let k = 0; k < 70; k++) piece(Math.random() * W, -20 - Math.random() * 160, (Math.random() - .5) * 2, Math.random() * 2 + 1.5, 230, true); }, w * 500);
    setTimeout(() => cv.classList.remove('top'), 6500);
  }
  function trail(x, y) { if (RM) return; bits.push({ x, y, vx: (Math.random() - .5) * .8, vy: -Math.random() * .8, l: 28, c: cols[0], s: 5, a: 0 }); }
  addEventListener('resize', size);
  return { colors, party, trail, burst(x, y) { if (RM) return; for (let i = 0; i < 90; i++) { const an = Math.random() * 6.283, sp = Math.random() * 8 + 2; bits.push({ x, y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp - 6, l: 70, c: cols[i % 3], s: Math.random() * 8 + 4, a: 0 }); } } };
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
  if (/operation-not-allowed/.test(c)) return 'Email sign-in is off: Firebase > Authentication > Sign-in method > Add new provider > Email/Password > Enable > Save.';
  if (/configuration-not-found/.test(c)) return 'Authentication is not set up: Firebase > Authentication > Get started, then enable Email/Password.';
  if (/unauthorized-domain/.test(c)) return 'Your website domain is not authorized: Authentication > Settings > Authorized domains > add yourname.github.io.';
  if (/api-key|invalid-api|app-not-authorized/.test(c)) return 'The values in config.js look wrong. Copy the config block again from Project settings > General > Your apps.';
  if (/permission-denied/.test(c)) return 'Access denied. Publish the newest firestore.rules (Firestore Database > Rules > Publish) and make sure your email is verified and not banned.';
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
addEventListener('hashchange', () => { if ((location.hash === '#admin') !== isAdminRoute) { location.reload(); return; } tab = readTab(); animate = true; window.scrollTo(0, 0); render(); });
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
  if (tourDue && ready && !coach && !isAdminRoute) { tourDue = false; setTimeout(startTour, 900); }
  if (dlg.open && openId) fillDialog(false);
  if (focusKey) { const b = view.querySelector('[data-key="' + focusKey + '"]'); if (b) b.focus(); focusKey = null; }
}
document.addEventListener('pointerdown', e => { if (e.target.type === 'range') sliding = true; });
addEventListener('pointerup', () => { sliding = false; if (!dragging && pendingRender) { pendingRender = false; setTimeout(render, 60); } });
addEventListener('pointercancel', () => { sliding = false; });

/* ---------- firebase, login, admin, tutorial ---------- */
const ADMIN_EMAIL = 'admin@chadranking.app';
const isAdminRoute = location.hash === '#admin';
let FB = null, started = false, tourDue = false, coach = null, vt = 0;
async function fbLoad() {
  const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const [A, Au, F] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js')]);
  return { A, Au, F };
}
async function fbInit(cfg) {
  const m = await fbLoad(), app = m.A.initializeApp(cfg), auth = m.Au.getAuth(app);
  await auth.authStateReady();
  return { ...m, app, auth, db: m.F.getFirestore(app) };
}
const person = (id, x, i) => ({ id, name: String(x.name || ''), subtitle: String(x.subtitle || ''), description: String(x.description || ''), image: String(x.image || ''),
  snapchat: String(x.snapchat || '').replace(/^@/, '').trim(), createdAt: Number.isFinite(x.order) ? x.order : i });
function sharedAdapter(fb, uid) {
  const { F, db } = fb;
  return {
    mode: 'shared', userId: uid, canWrite: null,
    onRoster(cb, onErr) {
      F.onSnapshot(F.collection(db, 'roster'), snap => {
        let seeded = false; const l = [];
        snap.forEach(d => { if (d.id === '__init') seeded = true; else l.push(person(d.id, d.data(), 0)); });
        cb(seeded ? l.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name)) : ROSTER);
      }, e => { onErr && onErr(e); cb(ROSTER); });
    },
    onVotes(cb, onErr) {
      F.onSnapshot(F.collection(db, 'votes'), snap => { const o = {}; snap.forEach(d => o[d.id] = d.data()); cb(o); }, e => { onErr && onErr(e); cb({}); });
    },
    setMyVote(d) { return F.setDoc(F.doc(db, 'votes', uid), d); }
  };
}
function countVisit() {
  try { const v = (+localStorage.getItem('chad-visits') || 0) + 1; localStorage.setItem('chad-visits', String(v)); tourDue = v <= 2; } catch (e) {}
}
function hook() {
  countVisit();
  storage.onRoster(list => { roster = list; rosterLoaded = true; tryInit(); render(); },
    e => { diagMsg = "Couldn't load the people list (" + (e.code || e.message) + '). ' + hint(e); syncDiag(); });
  storage.onVotes(v => { votes = v; votesLoaded = true; tryInit(); render(); },
    e => { votesError = "Couldn't load everyone's ballots (" + (e.code || e.message) + '). ' + hint(e); syncDiag(); });
}

/* ----- login gate: name + email + password, email must be verified ----- */
const gate = $('#gate');
const authErr = e => {
  const c = String((e && e.code) || e);
  if (/email-already-in-use/.test(c)) return 'That email already has an account. Use Log in instead.';
  if (/invalid-credential|wrong-password|user-not-found|invalid-login/.test(c)) return 'Wrong email or password.';
  if (/invalid-email/.test(c)) return 'That email address does not look right.';
  if (/weak-password/.test(c)) return 'Password is too short. Use at least 6 characters.';
  if (/too-many-requests/.test(c)) return 'Too many tries. Wait a minute and try again.';
  if (/operation-not-allowed/.test(c)) return 'Email sign-in is switched off in Firebase: Authentication > Sign-in method > Email/Password > Enable.';
  if (/network/.test(c)) return 'No connection. Check your internet and try again.';
  return 'Something went wrong (' + c + ').';
};
function gateShell(...kids) {
  clearInterval(vt); gate.hidden = false; document.body.classList.add('gated'); $('main').inert = true;
  gate.replaceChildren(h('div', { class: 'gcard' }, h('img', { class: 'glogo', src: 'logo.png', alt: '', width: 88, height: 88 }), h('h2', { class: 'gtitle', text: 'Chad Ranking' }), ...kids));
}
async function logout() { try { await FB.Au.signOut(FB.auth); } catch (e) {} location.reload(); }
function showAuthForm(mode, note) {
  const signup = mode === 'signup';
  const mk = (ph, type, ac, more) => h('input', Object.assign({ type, placeholder: ph, 'aria-label': ph, autocomplete: ac }, more || {}));
  const name = mk('Your name', 'text', 'name', { maxlength: 30 });
  const email = mk('Email address', 'email', 'email', { inputmode: 'email', autocapitalize: 'off' });
  const pw = mk(signup ? 'Choose a password (min. 6)' : 'Password', 'password', signup ? 'new-password' : 'current-password');
  const err = h('p', { class: 'gerr', 'aria-live': 'polite', text: note || '' });
  const go = h('button', { class: 'btn', type: 'submit', text: signup ? 'Create account' : 'Log in' });
  const seg = h('div', { class: 'seg' },
    h('button', { type: 'button', class: signup ? 'on' : '', text: 'Sign up', onclick: () => showAuthForm('signup') }),
    h('button', { type: 'button', class: signup ? '' : 'on', text: 'Log in', onclick: () => showAuthForm('login') }));
  const form = h('form', { class: 'gform', novalidate: true }, signup ? name : null, email, pw, err, go);
  const validEmail = v => /^\S+@\S+\.\S+$/.test(v);
  form.addEventListener('submit', async ev => {
    ev.preventDefault(); err.textContent = '';
    const nm = name.value.trim().replace(/\s+/g, ' '), em = email.value.trim().toLowerCase(), pv = pw.value;
    if (signup && nm.length < 2) { err.textContent = 'Please enter your name.'; return; }
    if (!validEmail(em)) { err.textContent = 'Enter a valid email address.'; return; }
    if (em === ADMIN_EMAIL) { err.textContent = 'That email is reserved.'; return; }
    if (pv.length < 6) { err.textContent = 'Password needs at least 6 characters.'; return; }
    go.classList.add('busy');
    const { Au, F, auth, db } = FB;
    try {
      if (signup) {
        const cred = await Au.createUserWithEmailAndPassword(auth, em, pv);
        await Au.updateProfile(cred.user, { displayName: nm });
        await F.setDoc(F.doc(db, 'profiles', cred.user.uid), { name: nm, email: em, createdAt: Date.now() });
        await Au.sendEmailVerification(cred.user);
      } else await Au.signInWithEmailAndPassword(auth, em, pv);
    } catch (e) { err.textContent = authErr(e); go.classList.remove('busy'); }
  });
  const reset = async () => {
    const em = email.value.trim().toLowerCase();
    if (!validEmail(em)) { err.textContent = 'Type your email above first.'; return; }
    try { await FB.Au.sendPasswordResetEmail(FB.auth, em); err.textContent = 'If that email has an account, a reset link is on its way.'; } catch (e) { err.textContent = authErr(e); }
  };
  gateShell(h('p', { class: 'gsub', text: signup ? 'Create an account with your name and email. One verified email gives you one ballot.' : 'Welcome back. Log in to see the ranking.' }),
    seg, form, signup ? null : h('button', { class: 'glink', type: 'button', text: 'Forgot password?', onclick: reset }));
  setTimeout(() => (signup ? name : email).focus(), 350);
}
function showVerify(u) {
  const msg = h('p', { class: 'gerr' });
  const resend = h('button', { class: 'ghost', text: 'Resend email' });
  resend.addEventListener('click', async () => {
    resend.disabled = true; msg.textContent = '';
    try { await FB.Au.sendEmailVerification(u); msg.textContent = 'Sent again. Check your inbox and spam folder.'; } catch (e) { msg.textContent = authErr(e); }
    setTimeout(() => { resend.disabled = false; }, 30000);
  });
  const check = async () => { try { await FB.Au.reload(u); } catch (e) {} if (u.emailVerified) { clearInterval(vt); proceed(u); return true; } return false; };
  gateShell(h('p', { class: 'gsub' }, 'We sent a verification link to ', h('b', { class: 'sel', text: u.email }), '. Open it (check spam too) and this page continues by itself.'), msg,
    h('button', { class: 'btn', text: 'I verified, continue', onclick: async () => { if (!(await check())) msg.textContent = 'Not verified yet. Open the link in the email first.'; } }),
    resend, h('button', { class: 'glink', text: 'Use another account', onclick: logout }));
  vt = setInterval(check, 4000);
}
function showBanned() {
  gateShell(h('p', { class: 'gsub', text: 'This email address has been banned from Chad Ranking.' }), h('button', { class: 'ghost', text: 'Log out', onclick: logout }));
}
function showProblem(e) {
  gateShell(h('p', { class: 'gerr', text: 'Could not finish logging in (' + (e.code || e.message) + '). ' + hint(e) }),
    h('button', { class: 'btn', text: 'Try again', onclick: () => location.reload() }), h('button', { class: 'glink', text: 'Log out', onclick: logout }));
}
async function handleUser(u) {
  if (started) return;
  if (!u) { let has = false; try { has = !!localStorage.getItem('chad-has-account'); } catch (e) {} showAuthForm(has ? 'login' : 'signup'); return; }
  if (u.isAnonymous) { try { await FB.Au.signOut(FB.auth); } catch (e) {} return; }
  if (String(u.email).toLowerCase() === ADMIN_EMAIL) { try { await FB.Au.signOut(FB.auth); } catch (e) {} showAuthForm('login', 'Use the admin page for that account.'); return; }
  try { await FB.Au.reload(u); } catch (e) {}
  if (!u.emailVerified) { showVerify(u); return; }
  proceed(u);
}
async function proceed(u) {
  if (started) return;
  try {
    await u.getIdToken(true);
    const { F, db } = FB, em = String(u.email).toLowerCase();
    if ((await F.getDoc(F.doc(db, 'banned', em))).exists()) { showBanned(); return; }
    if (!(await F.getDoc(F.doc(db, 'profiles', u.uid))).exists())
      await F.setDoc(F.doc(db, 'profiles', u.uid), { name: String(u.displayName || em.split('@')[0]).slice(0, 40), email: em, createdAt: Date.now() });
  } catch (e) { console.warn(e); showProblem(e); return; }
  started = true;
  try { localStorage.setItem('chad-has-account', '1'); } catch (e) {}
  storage = sharedAdapter(FB, u.uid);
  gate.hidden = true; document.body.classList.remove('gated'); $('main').inert = false;
  const w = $('#whoami'); w.textContent = u.displayName || u.email; w.hidden = false; $('#logout').hidden = false;
  hook(); syncTabs();
}

/* ----- admin page (#admin), protected by a Firebase account + password ----- */
async function adminBoot() {
  document.body.classList.add('admin'); document.title = 'Chad Ranking Admin';
  const root = $('#adminroot'); root.hidden = false;
  const toast = h('div', { class: 'toast', role: 'status' }); let tt = 0;
  document.body.append(toast);
  const say = (m, bad) => { toast.textContent = m; toast.className = 'toast on' + (bad ? ' err' : ''); clearTimeout(tt); tt = setTimeout(() => { toast.className = 'toast'; }, 3200); };
  const lock = msg => {
    const pw = h('input', { type: 'password', placeholder: 'Admin password', 'aria-label': 'Admin password', autocomplete: 'current-password' });
    const err = h('p', { class: 'gerr', text: msg || '' });
    const form = h('form', { class: 'gform', novalidate: true }, pw, err, h('button', { class: 'btn', type: 'submit', text: 'Unlock' }));
    form.addEventListener('submit', async ev => {
      ev.preventDefault(); err.textContent = '';
      if (!AD) return;
      try { await AD.Au.signInWithEmailAndPassword(AD.auth, ADMIN_EMAIL, pw.value); panel(); }
      catch (e) {
        const c = String(e.code || e);
        err.textContent = /invalid-credential|wrong-password|user-not-found/.test(c) ? 'Wrong password, or the admin account does not exist yet in Firebase (see README).'
          : /operation-not-allowed/.test(c) ? 'Enable Email/Password in Firebase > Authentication > Sign-in method.' : /too-many/.test(c) ? 'Too many tries. Wait a minute.' : 'Login failed (' + c + ').';
      }
    });
    root.className = ''; root.replaceChildren(h('div', { class: 'gcard' }, h('img', { class: 'glogo', src: 'admin-logo.png', alt: '', width: 88, height: 88 }),
      h('h2', { class: 'gtitle', text: 'Admin' }), h('p', { class: 'gsub', text: 'Restricted area. Enter the admin password.' }), form,
      h('button', { class: 'glink', type: 'button', text: 'Back to the ranking', onclick: () => { location.hash = '#official'; } })));
    setTimeout(() => pw.focus(), 350);
  };
  let AD = null;
  if (!window.FIREBASE_CONFIG) { lock('config.js is missing.'); return; }
  try {
    const m = await fbLoad(), app = m.A.initializeApp(window.FIREBASE_CONFIG, 'admin');
    const auth = m.Au.initializeAuth(app, { persistence: m.Au.browserSessionPersistence });
    await auth.authStateReady(); AD = { ...m, app, auth, db: m.F.getFirestore(app) };
  } catch (e) { lock('Could not start Firebase (' + (e.code || e.message) + ').'); return; }
  if (AD.auth.currentUser && AD.auth.currentUser.email === ADMIN_EMAIL) panel(); else lock();

  function panel() {
    const { F, db } = AD;
    const S = { tab: 'people', roster: [], seeded: false, profiles: [], votes: {}, banned: [], err: '' };
    const cl = (v, n) => String(v || '').trim().slice(0, n);
    const dref = (c, id) => F.doc(db, c, id);
    const run = async (fn, ok) => { try { await fn(); if (ok) say(ok); } catch (e) { say(String(e.code || e.message), true); } };
    const listen = (name, fn) => F.onSnapshot(F.collection(db, name), snap => { fn(snap); S.err = ''; draw(); }, e => { S.err = name + ': ' + (e.code || e.message); draw(); });
    listen('roster', snap => { S.seeded = false; S.roster = []; snap.forEach(d => { if (d.id === '__init') S.seeded = true; else S.roster.push(person(d.id, d.data(), 0)); }); S.roster.sort((a, b) => a.createdAt - b.createdAt); });
    listen('profiles', snap => { S.profiles = []; snap.forEach(d => S.profiles.push({ id: d.id, ...d.data() })); S.profiles.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); });
    listen('votes', snap => { S.votes = {}; snap.forEach(d => { S.votes[d.id] = d.data(); }); });
    listen('banned', snap => { S.banned = []; snap.forEach(d => S.banned.push({ id: d.id, ...d.data() })); });
    let pending = false;
    const isBan = em => S.banned.some(b => b.id === em);
    const ballotSize = id => ((S.votes[id] || {}).order || []).length;
    const field = (ph, val, cls) => h('input', { class: 'ainp ' + (cls || ''), placeholder: ph, 'aria-label': ph, value: val || '' });
    const area = (ph, val) => { const t = h('textarea', { class: 'ainp', placeholder: ph, 'aria-label': ph }); t.value = val || ''; return t; };
    async function seed() {
      const b = F.writeBatch(db);
      ROSTER.forEach((p, i) => b.set(dref('roster', p.id), { name: p.name, subtitle: p.subtitle, description: p.description, image: p.image, snapchat: p.snapchat, order: i }));
      b.set(dref('roster', '__init'), { seeded: true, at: Date.now() }); await b.commit();
    }
    async function banEmail(em, nm) {
      const pr = S.profiles.find(p => String(p.email).toLowerCase() === em), b = F.writeBatch(db);
      b.set(dref('banned', em), { email: em, name: nm || (pr && pr.name) || '', at: Date.now() });
      if (pr && S.votes[pr.id]) b.delete(dref('votes', pr.id));
      await b.commit();
    }
    const peopleTab = () => {
      const box = h('div', {});
      if (!S.seeded) {
        box.append(h('div', { class: 'acard' }, h('h2', { text: 'Take over the people list' }),
          h('p', { class: 'gsub', text: 'The list still comes from roster.js. Press the button once to copy it into the database. After that you manage everyone here.' }),
          h('button', { class: 'btn', text: 'Take over roster.js list', onclick: () => run(seed, 'List moved to the database') })));
        return box;
      }
      const n = field('Name', ''), sub = field('Subtitle (optional)', ''), sn = field('Snapchat username (optional)', ''), im = field('Image path, e.g. images/thor.jpg (optional)', ''), ds = area('Description (optional)', '');
      box.append(h('div', { class: 'acard' }, h('h2', { text: 'Add a person' }), h('div', { class: 'agrid' }, n, sub, sn, im), ds,
        h('button', { class: 'btn', text: 'Add person', onclick: () => run(async () => {
          const nm = cl(n.value, 40); if (!nm) throw new Error('Name is required');
          const id = (nm.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'p') + '-' + Math.random().toString(36).slice(2, 6);
          const order = S.roster.reduce((m, p) => Math.max(m, p.createdAt), -1) + 1;
          await F.setDoc(dref('roster', id), { name: nm, subtitle: cl(sub.value, 60), snapchat: cl(sn.value, 40).replace(/^@/, ''), image: cl(im.value, 200), description: cl(ds.value, 600), order });
        }, 'Added') })));
      S.roster.forEach((p, i) => {
        const n2 = field('Name', p.name), s2 = field('Subtitle', p.subtitle), c2 = field('Snapchat username', p.snapchat), i2 = field('Image path', p.image), d2 = area('Description', p.description);
        const swap = o => run(async () => { const q = S.roster[i + o]; if (!q) return; const b = F.writeBatch(db); b.update(dref('roster', p.id), { order: q.createdAt }); b.update(dref('roster', q.id), { order: p.createdAt }); await b.commit(); });
        box.append(h('div', { class: 'acard', style: 'animation-delay:' + Math.min(i, 8) * 0.04 + 's' }, h('h2', { text: (i + 1) + '. ' + p.name }), h('div', { class: 'agrid' }, n2, s2, c2, i2), d2,
          h('div', { class: 'abtns' },
            h('button', { class: 'btn', text: 'Save', onclick: () => run(async () => {
              const nm = cl(n2.value, 40); if (!nm) throw new Error('Name is required');
              await F.setDoc(dref('roster', p.id), { name: nm, subtitle: cl(s2.value, 60), snapchat: cl(c2.value, 40).replace(/^@/, ''), image: cl(i2.value, 200), description: cl(d2.value, 600), order: p.createdAt });
            }, 'Saved') }),
            h('button', { class: 'ghost', text: 'Up', onclick: () => swap(-1) }), h('button', { class: 'ghost', text: 'Down', onclick: () => swap(1) }),
            h('button', { class: 'ghost danger', text: 'Remove', onclick: async () => {
              if (await confirmBox('Remove ' + p.name + '?', 'They disappear from the list, from every ballot and from all averages. This cannot be undone.', 'Remove', 'Cancel')) run(() => F.deleteDoc(dref('roster', p.id)), 'Removed');
            } }))));
      });
      return box;
    };
    const membersTab = () => {
      const box = h('div', {}); const known = new Set(S.profiles.map(p => p.id));
      if (!S.profiles.length) box.append(h('p', { class: 'gsub', text: 'Nobody has signed up yet.' }));
      S.profiles.forEach((p, i) => {
        const em = String(p.email || '').toLowerCase(), banned = isBan(em), n = ballotSize(p.id);
        box.append(h('div', { class: 'arow', style: 'animation-delay:' + Math.min(i, 10) * 0.03 + 's' },
          h('div', { class: 'grow' }, h('b', { text: p.name }), h('small', { class: 'sel', text: em }),
            h('small', {}, h('span', { class: 'chipx' + (n ? ' ok' : ''), text: n ? 'Ballot: ' + n + ' people' : 'No ballot' }), banned ? h('span', { class: 'chipx bad', text: 'Banned' }) : null)),
          h('div', { class: 'abtns' },
            n ? h('button', { class: 'ghost', text: 'Delete ballot', onclick: async () => { if (await confirmBox('Delete ballot?', p.name + "'s ballot is removed from the ranking. They can vote again.", 'Delete', 'Cancel')) run(() => F.deleteDoc(dref('votes', p.id)), 'Ballot deleted'); } }) : null,
            banned ? h('button', { class: 'ghost', text: 'Unban', onclick: () => run(() => F.deleteDoc(dref('banned', em)), 'Unbanned') })
              : h('button', { class: 'ghost danger', text: 'Ban', onclick: async () => { if (await confirmBox('Ban ' + p.name + '?', em + ' can no longer enter and their ballot is deleted.', 'Ban', 'Cancel')) run(() => banEmail(em, p.name), 'Banned'); } }))));
      });
      Object.keys(S.votes).filter(id => !known.has(id)).forEach(id => box.append(h('div', { class: 'arow' },
        h('div', { class: 'grow' }, h('b', { text: 'Unknown ballot' }), h('small', { text: 'No account attached (old anonymous ballot). ' + ballotSize(id) + ' people ranked.' })),
        h('button', { class: 'ghost danger', text: 'Delete', onclick: () => run(() => F.deleteDoc(dref('votes', id)), 'Ballot deleted') }))));
      return box;
    };
    const bannedTab = () => {
      const em = field('Email to ban', '');
      const box = h('div', {}, h('div', { class: 'acard' }, h('h2', { text: 'Ban an email' }), em,
        h('button', { class: 'btn danger', text: 'Ban email', onclick: () => run(async () => {
          const v = em.value.trim().toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(v)) throw new Error('Enter a valid email'); await banEmail(v, '');
        }, 'Banned') })));
      if (!S.banned.length) box.append(h('p', { class: 'gsub', text: 'No banned emails.' }));
      S.banned.forEach(b => box.append(h('div', { class: 'arow' }, h('div', { class: 'grow' }, h('b', { class: 'sel', text: b.id }), b.name ? h('small', { text: b.name }) : null),
        h('button', { class: 'ghost', text: 'Unban', onclick: () => run(() => F.deleteDoc(dref('banned', b.id)), 'Unbanned') }))));
      return box;
    };
    const draw = () => {
      const a = document.activeElement;
      if (a && root.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName)) { pending = true; return; }
      pending = false;
      const tabs = [['people', 'People · ' + S.roster.length], ['members', 'Members · ' + S.profiles.length], ['banned', 'Banned · ' + S.banned.length]];
      root.className = 'panel';
      root.replaceChildren(h('div', { class: 'apanel' },
        h('div', { class: 'ahead' }, h('img', { src: 'admin-logo.png', alt: '' }), h('h1', { text: 'Admin' }), h('span', { class: 'sp' }),
          h('button', { class: 'ghost', text: 'Back to site', onclick: () => { location.hash = '#official'; } }),
          h('button', { class: 'ghost', text: 'Lock', onclick: async () => { try { await AD.Au.signOut(AD.auth); } catch (e) {} location.reload(); } })),
        h('p', { class: 'gsub', text: Object.keys(S.votes).length + ' ballots in total' }),
        S.err ? h('p', { class: 'gerr', text: 'Cannot read ' + S.err + '. Publish the new firestore.rules and create the admin user in Firebase.' }) : null,
        h('div', { class: 'atabs' }, tabs.map(([k, t]) => h('button', { class: 'atab' + (S.tab === k ? ' on' : ''), text: t, onclick: () => { S.tab = k; draw(); } }))),
        S.tab === 'people' ? peopleTab() : S.tab === 'members' ? membersTab() : bannedTab()));
    };
    root.addEventListener('focusout', () => setTimeout(() => { if (pending) draw(); }, 60));
    draw();
  }
}

/* ----- spotlight tutorial ----- */
const STEPS = [
  { t: 'Welcome to Chad Ranking', x: 'A ranking of the friend group, made by the friend group. This quick tour shows you where everything is. You can skip it any time.' },
  { tab: 'official', sel: '.tab[data-tab="official"]', t: 'Official Ranking', x: 'The combined result of every vote. It looks the same for everybody and updates live.' },
  { tab: 'official', sel: '.podium, .hero0', t: 'The podium', x: 'The top 3 by points. Tap a person to open a profile with their photo, Snapchat and averages.' },
  { tab: 'official', sel: '.pod .pp, .row .score', t: 'Points', x: 'Scores run from roughly 350 to 870. A higher score means a higher place.' },
  { tab: 'official', sel: '.tab[data-tab="mine"]', t: 'My Ranking', x: 'This is where you cast your own vote.' },
  { tab: 'mine', sel: '.cols section:first-child', t: 'Rating list', x: 'Put people in your order, best at the top. Drag them or use the arrows.' },
  { tab: 'mine', sel: '.cols section:nth-child(2)', t: 'Skip list', x: 'People you do not want to judge. Move someone with the Skip and Rank buttons.' },
  { tab: 'mine', sel: '.row .rate summary', t: 'PSL and Appeal', x: 'Optional extra scores per person. PSL is looks from 1 to 8, Appeal is charm from 1 to 10. Open it to set the sliders.' },
  { tab: 'mine', sel: '.submitbar', t: 'Submit', x: 'Send your ranking here. You can update it later. There is one ballot per account. Missing PSL or Appeal only gives a warning.' },
  { sel: '#theme', t: 'Dark and light', x: 'Switch the theme with this button.' },
  { sel: '#help', t: 'Need this again?', x: 'Press the question mark to replay this tour whenever you like.' }
];
function startTour() {
  if (coach) return;
  let i = 0, raf = 0, scrolled = -1, tw = 0;
  const shade = h('div', { class: 'cshade' }), spot = h('div', { class: 'cspot' }), tip = h('div', { class: 'ctip', role: 'dialog', 'aria-label': 'Tutorial' });
  const wrap = h('div', { id: 'coach' }, shade, spot, tip); document.body.append(wrap);
  const key = e => { if (e.key === 'Escape') end(false); else if (e.key === 'ArrowRight') next(); else if (e.key === 'ArrowLeft') back(); };
  function end(done) { cancelAnimationFrame(raf); removeEventListener('keydown', key); wrap.classList.add('out'); setTimeout(() => wrap.remove(), 300); coach = null; if (done) fx.party(); }
  coach = { end }; addEventListener('keydown', key);
  const next = () => { if (i >= STEPS.length - 1) end(true); else { i++; draw(); } };
  const back = () => { if (i > 0) { i--; draw(); } };
  function draw() {
    const s = STEPS[i], last = i === STEPS.length - 1;
    if (s.tab && tab !== s.tab) location.hash = '#' + s.tab;
    scrolled = -1;
    tip.replaceChildren(h('div', { class: 'cin' }, h('div', { class: 'cbar' }, h('i', { style: '--w:' + ((i + 1) / STEPS.length * 100) + '%' })), h('h3', { text: s.t }), h('p', { text: s.x }),
      h('div', { class: 'cbtn' }, last ? null : h('button', { class: 'ghost', text: 'Skip', onclick: () => end(false) }), h('span', { class: 'sp', text: (i + 1) + ' / ' + STEPS.length }),
        i ? h('button', { class: 'ghost', text: 'Back', onclick: back }) : null, h('button', { class: 'btn', text: last ? 'Finish' : 'Next', onclick: next }))));
  }
  function place() {
    raf = requestAnimationFrame(place);
    const s = STEPS[i]; let el = s.sel ? document.querySelector(s.sel) : null;
    if (el && el.getClientRects().length === 0) el = null;
    if (el && scrolled !== i) { scrolled = i; const b = el.getBoundingClientRect(); if (b.top < 80 || b.bottom > innerHeight - 140) el.scrollIntoView({ block: 'center', behavior: RM ? 'auto' : 'smooth' }); }
    wrap.classList.toggle('dark', !el);
    const tW = tip.offsetWidth, tH = tip.offsetHeight; let r;
    if (el) { const b = el.getBoundingClientRect(); r = { x: b.left - 8, y: b.top - 8, w: b.width + 16, h: b.height + 16 }; } else r = { x: innerWidth / 2, y: innerHeight / 2, w: 0, h: 0 };
    spot.style.transform = 'translate(' + r.x + 'px,' + r.y + 'px)'; spot.style.width = r.w + 'px'; spot.style.height = r.h + 'px'; spot.style.opacity = el ? 1 : 0;
    let x, y;
    if (!el) { x = (innerWidth - tW) / 2; y = (innerHeight - tH) / 2; }
    else {
      x = Math.min(Math.max(10, r.x + r.w / 2 - tW / 2), innerWidth - tW - 10);
      if (r.y + r.h + 14 + tH < innerHeight - 8) y = r.y + r.h + 14; else if (r.y - 14 - tH > 8) y = r.y - 14 - tH; else y = innerHeight - tH - 12;
    }
    tip.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  }
  draw(); place();
}
$('#help').addEventListener('click', startTour);
$('#logout').addEventListener('click', logout);

/* ----- no zoom, no text selection, light effects ----- */
['gesturestart', 'gesturechange', 'gestureend'].forEach(ev => document.addEventListener(ev, e => e.preventDefault(), { passive: false }));
document.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '_', '0'].includes(e.key)) e.preventDefault(); });
document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
const editable = t => t && t.closest && t.closest('input,textarea,.sel');
document.addEventListener('selectstart', e => { if (!editable(e.target)) e.preventDefault(); });
document.addEventListener('contextmenu', e => { if (!editable(e.target)) e.preventDefault(); });
document.addEventListener('dragstart', e => { if (e.target.tagName === 'IMG') e.preventDefault(); });
document.addEventListener('pointerdown', e => {
  const b = e.target.closest && e.target.closest('.btn,.tab'); if (!b || RM) return;
  const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2, s = h('span', { class: 'rip' });
  s.style.cssText = 'width:' + d + 'px;height:' + d + 'px;left:' + (e.clientX - r.left - d / 2) + 'px;top:' + (e.clientY - r.top - d / 2) + 'px';
  b.append(s); setTimeout(() => s.remove(), 700);
});
let lastTrail = 0;
document.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' && e.timeStamp - lastTrail > 35) { lastTrail = e.timeStamp; fx.trail(e.clientX, e.clientY); } });
addEventListener('scroll', () => { const m = document.documentElement.scrollHeight - innerHeight; $('#sp').style.transform = 'scaleX(' + (m > 0 ? Math.min(1, scrollY / m) : 0) + ')'; }, { passive: true });

/* ---------- boot ---------- */
(async function boot() {
  tab = readTab(); syncTheme(); syncTabs(); splitTitle();
  if (isAdminRoute) { adminBoot(); return; }
  if (!window.FIREBASE_CONFIG) {
    diagMsg = 'Votes are not shared: config.js contains no Firebase settings. Make sure config.js has your config, is committed to the repo, and that you hard refreshed (Ctrl+Shift+R).';
    hook(); return;
  }
  try { FB = await fbInit(window.FIREBASE_CONFIG); }
  catch (e) { console.warn(e); diagMsg = 'Login could not start (' + (e.code || e.message) + '). ' + hint(e); hook(); return; }
  FB.Au.onAuthStateChanged(FB.auth, u => { handleUser(u); });
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

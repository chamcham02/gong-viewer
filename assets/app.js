/* 병렬노트 뷰어 — 학습 내용은 들어 있지 않음. 내용은 열람할 때 비공개 저장소에서 불러온다. */
(function () {
'use strict';
// ---- util.js ----
// 공통 도구 — 모든 모듈이 쓴다.
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return [...(root || document).querySelectorAll(sel)]; }
const narrowMq = window.matchMedia('(max-width: 900px)');
const isNarrow = () => narrowMq.matches;

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
function confirmDlg(title, text) {
  const d = $('#dlg-confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  return new Promise((resolve) => {
    const done = () => { d.removeEventListener('close', done); resolve(d.returnValue === 'ok'); };
    d.addEventListener('close', done);
    d.returnValue = '';
    d.showModal();
  });
}
function download(name, text, type) {
  try {
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (e) { toast('내려받기를 할 수 없는 환경입니다. 복사를 이용하세요.'); }
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('복사했습니다.'); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
    toast(ok ? '복사했습니다.' : '복사하지 못했습니다.');
  }
}
const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function firstLine(s) { return (s || '').split('\n').find((l) => l.trim()) || ''; }
// 같은 프레임 안의 여러 요청을 한 번으로 모은다
function rafOnce(fn) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(); });
  };
}
// 입력칸·편집 중인 곳에서는 단축키를 쓰지 않는다
function inTypingTarget(el) {
  return !!(el && el.closest && el.closest('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="file"]), textarea, select, [contenteditable="true"], [contenteditable=""]'));
}

// ---- store.js ----
// 하이라이트·메모·편집·진도 데이터 — 기기에 먼저 저장(localStorage)하고, 동기화는 sync-github.js가 맡는다.
// 항목은 updatedAt이 늦은 쪽이 이긴다(같으면 deviceId 비교). 삭제는 묘비(deleted: true)로 남겨 다른 기기에 전파한다.
// 종류(kind): hl 하이라이트 · row 행 메모 · edit 블록 편집본 · prog 행 '다 봤음' · pos 마지막 위치(기기별)
const Store = (() => {
  const DOC = 'gongbeop2-kibonkwon';
  const KEY = DOC + ':annotations:v1';
  const META_KEY = DOC + ':annotations-meta:v1';
  const DEVICE_KEY = 'gongbeop2:device';
  const TOMBSTONE_TTL = 30 * 24 * 3600 * 1000;
  // 자주 바뀌는 종류: 바뀌어도 바로 올리지 않고, 다른 변경을 올릴 때나 창을 떠날 때 함께 올린다
  const LAZY_KINDS = new Set(['pos']);
  let doc = { schema: 1, doc: DOC, items: {} };
  let meta = { dirty: false, lazyDirty: false, lastSync: null };
  let storageOk = true;
  const listeners = new Set();

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { storageOk = false; return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { storageOk = false; return false; } }

  function probe() {
    try { localStorage.setItem(DOC + ':probe', '1'); localStorage.removeItem(DOC + ':probe'); } catch (e) { storageOk = false; }
  }

  let deviceCache = null;
  function device() {
    if (deviceCache) return deviceCache;
    let d = null;
    try { d = JSON.parse(lsGet(DEVICE_KEY) || 'null'); } catch (e) { d = null; }
    if (!d || !d.id) {
      d = { id: 'd' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4), name: '' };
      lsSet(DEVICE_KEY, JSON.stringify(d));
    }
    deviceCache = d;
    return d;
  }
  function setDeviceName(name) { const d = device(); d.name = name; lsSet(DEVICE_KEY, JSON.stringify(d)); }

  // 종류(kind)가 없는 예전 항목은 하이라이트(문장에 묶임) 또는 행 메모로 본다
  function normalize(it) {
    if (it && !it.kind && !it.deleted) it.kind = it.segs ? 'hl' : (it.rowId ? 'row' : 'hl');
    return it;
  }
  function load() {
    probe();
    try {
      const raw = lsGet(KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && d.items) { doc = { schema: 1, doc: DOC, items: d.items }; Object.values(doc.items).forEach(normalize); }
      }
      const m = JSON.parse(lsGet(META_KEY) || 'null');
      if (m) meta = Object.assign(meta, m);
    } catch (e) { /* 손상된 저장값은 무시 */ }
  }
  function persist() {
    lsSet(KEY, JSON.stringify(doc));
    lsSet(META_KEY, JSON.stringify(meta));
  }
  function emit(ev) { listeners.forEach((fn) => { try { fn(ev); } catch (e) { console.error(e); } }); }

  function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  const isLazy = (it) => !!(it && LAZY_KINDS.has(it.kind));

  // 항목을 쓰거나 고친다. 지운 항목(묘비)에는 종류(kind)까지 갖춘 온전한 항목만 다시 쓸 수 있다.
  function put(item, opts) {
    const now = Date.now();
    const d = device();
    const prev = doc.items[item.id];
    if (prev && prev.deleted && !item.kind) return null; // 다른 기기에서 지운 항목에 일부 값만 고치려는 경우
    const base = prev && !prev.deleted ? prev : (prev ? { createdAt: prev.createdAt } : {});
    const next = Object.assign({}, base, item, { updatedAt: now, deviceId: d.id });
    delete next.deleted;
    if (!next.createdAt) next.createdAt = now;
    doc.items[next.id] = next;
    const lazy = isLazy(next);
    if (lazy) meta.lazyDirty = true; else meta.dirty = true;
    persist();
    emit({ type: 'put', ids: [next.id], local: true, silent: opts && opts.silent, lazy });
    return next;
  }
  // 되돌리기용: 지운 항목을 같은 id로 되살리거나 통째로 바꾼다 (새 시각이라 다른 기기의 묘비보다 이긴다)
  function restore(item, opts) {
    const now = Date.now();
    const next = Object.assign({}, item, { updatedAt: now, deviceId: device().id });
    delete next.deleted;
    if (!next.createdAt) next.createdAt = now;
    doc.items[next.id] = next;
    if (isLazy(next)) meta.lazyDirty = true; else meta.dirty = true;
    persist();
    emit({ type: 'put', ids: [next.id], local: true, silent: opts && opts.silent, lazy: isLazy(next) });
    return next;
  }
  function remove(id) {
    const prev = doc.items[id];
    if (!prev || prev.deleted) return;
    doc.items[id] = { id, kind: prev.kind, deleted: true, updatedAt: Date.now(), deviceId: device().id, createdAt: prev.createdAt };
    meta.dirty = true;
    persist();
    emit({ type: 'remove', ids: [id], local: true });
  }
  function get(id) { const it = doc.items[id]; return it && !it.deleted ? it : null; }
  function raw(id) { return doc.items[id] || null; }
  // kinds: 생략하면 전부, 문자열 하나나 배열로 종류를 거른다
  function all(kinds) {
    const ks = kinds == null ? null : new Set([].concat(kinds));
    return Object.values(doc.items).filter((it) => !it.deleted && (!ks || ks.has(it.kind || 'hl')));
  }

  function wins(a, b) {
    // a가 b를 이기면 true
    if (!b) return true;
    if (!a) return false;
    if ((a.updatedAt || 0) !== (b.updatedAt || 0)) return (a.updatedAt || 0) > (b.updatedAt || 0);
    return String(a.deviceId || '') > String(b.deviceId || '');
  }

  // 원격 문서를 합친다. 바뀐 id 목록을 돌려준다.
  function mergeRemote(remote, opts) {
    if (!remote || !remote.items) return [];
    const changed = [];
    for (const [id, r] of Object.entries(remote.items)) {
      const l = doc.items[id];
      normalize(r);
      if (wins(r, l) && JSON.stringify(r) !== JSON.stringify(l)) {
        doc.items[id] = r;
        changed.push(id);
      }
    }
    // 원격에 없거나 원격보다 새로운 로컬 항목이 있으면 올릴 것이 남아 있다 (지연 저장 종류는 따로 센다)
    let localAhead = false, lazyAhead = false;
    for (const [id, l] of Object.entries(doc.items)) {
      const r = remote.items[id];
      if (!r || (wins(l, r) && JSON.stringify(l) !== JSON.stringify(r))) {
        if (isLazy(l)) lazyAhead = true; else { localAhead = true; break; }
      }
    }
    if (opts && opts.markClean && !localAhead) meta.dirty = false;
    else if (localAhead) meta.dirty = true;
    if (opts && opts.markClean && !lazyAhead) meta.lazyDirty = false;
    persist();
    if (changed.length) emit({ type: 'merge', ids: changed, local: false });
    return changed;
  }

  // 백업 덮어쓰기·모두 지우기. kinds를 주면 그 종류만 바꾼다.
  function replaceAll(items, kinds) {
    const ks = kinds == null ? null : new Set([].concat(kinds));
    const inKinds = (it) => !ks || ks.has((it && it.kind) || 'hl');
    const now = Date.now();
    const d = device();
    const ids = new Set([...Object.keys(doc.items), ...Object.keys(items)]);
    const touched = [];
    for (const id of ids) {
      const inc = items[id], cur = doc.items[id];
      if (inc && !inc.deleted && inKinds(inc)) { doc.items[id] = normalize(Object.assign({}, inc, { updatedAt: now, deviceId: d.id })); touched.push(id); }
      else if (cur && !cur.deleted && inKinds(cur) && !(inc && !inc.deleted)) { doc.items[id] = { id, kind: cur.kind, deleted: true, updatedAt: now, deviceId: d.id, createdAt: cur.createdAt }; touched.push(id); }
    }
    meta.dirty = true;
    persist();
    emit({ type: 'merge', ids: touched, local: true });
  }
  function clearAll(kinds) { replaceAll({}, kinds); }

  function snapshot() {
    // 오래된 묘비는 정리해서 내보낸다
    const now = Date.now();
    const items = {};
    for (const [id, it] of Object.entries(doc.items)) {
      if (it.deleted && now - (it.updatedAt || 0) > TOMBSTONE_TTL) continue;
      items[id] = it;
    }
    return { schema: 1, doc: DOC, items };
  }

  function markDirty() { meta.dirty = true; persist(); emit({ type: 'merge', ids: [], local: true }); }
  function markSynced() { meta.dirty = false; meta.lazyDirty = false; meta.lastSync = Date.now(); persist(); }
  function isDirty() { return meta.dirty; }
  function isLazyDirty() { return meta.lazyDirty; }
  function lastSync() { return meta.lastSync; }
  function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  load();
  return { put, restore, remove, get, raw, all, mergeRemote, replaceAll, clearAll, snapshot, markSynced, markDirty, isDirty, isLazyDirty, lastSync, on, newId, device, setDeviceName, storageOk: () => storageOk, lsGet, lsSet };
})();

// ---- history.js ----
// 되돌리기·다시하기 — 이 기기에서 이번 세션 동안 한 동작만 쌓는다. 다른 기기에서 받은 변경은 쌓지 않는다.
// 되돌린 결과도 보통의 변경처럼 Store에 쓰여 GitHub에 동기화된다.
const History = (() => {
  const LIMIT = 200;
  const undoStack = [], redoStack = [];
  const listeners = new Set();
  const META = new Set(['updatedAt', 'deviceId', 'createdAt']);
  let tx = null;       // 묶음 기록 중인 항목
  let applying = false;

  const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
  function snap(id) { const it = Store.get(id); return it ? clone(it) : null; }
  function changedKeys(a, b) {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    return [...keys].filter((k) => !META.has(k) && JSON.stringify(a ? a[k] : undefined) !== JSON.stringify(b ? b[k] : undefined));
  }
  function emit() { listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }

  function rec(id, before, after, label) {
    if (applying) return;
    const entry = tx || { label: label || '', ops: [] };
    const ex = entry.ops.find((o) => o.id === id);
    if (ex) ex.after = after; else entry.ops.push({ id, before, after });
    if (!tx) commit(entry);
  }
  function commit(entry) {
    entry.ops = entry.ops.filter((o) => (o.before || o.after) && (!o.before || !o.after || changedKeys(o.before, o.after).length));
    if (!entry.ops.length) return;
    undoStack.push(entry);
    if (undoStack.length > LIMIT) undoStack.shift();
    redoStack.length = 0;
    emit();
  }

  // 기록하면서 Store를 바꾸는 함수들
  function put(item, label, opts) {
    const before = snap(item.id);
    const r = Store.put(item, opts);
    rec(item.id, before, snap(item.id), label);
    return r;
  }
  function remove(id, label) {
    const before = snap(id);
    if (!before) return;
    Store.remove(id);
    rec(id, before, null, label);
  }
  // 이미 일어난 변경을 기록한다 (예: 메모 입력을 시작할 때의 값 → 끝났을 때의 값)
  function note(id, before, label) { rec(id, clone(before), snap(id), label); }
  // 여러 변경을 한 단계로 묶는다
  function group(label, fn) {
    if (tx) return fn();
    tx = { label, ops: [] };
    try { return fn(); } finally { const e = tx; tx = null; commit(e); }
  }

  function apply(entry, dir) {
    applying = true;
    try {
      const ops = dir === 'undo' ? [...entry.ops].reverse() : entry.ops;
      for (const o of ops) {
        const from = dir === 'undo' ? o.after : o.before;
        const to = dir === 'undo' ? o.before : o.after;
        const cur = snap(o.id);
        if (!to) { if (cur) Store.remove(o.id); continue; }
        if (!from || !cur) { Store.restore(to); continue; }
        // 고친 값만 되돌린다 — 그사이 다른 기기가 바꾼 다른 값은 그대로 둔다
        const patch = { id: o.id };
        for (const k of changedKeys(from, to)) patch[k] = to[k] === undefined ? null : to[k];
        Store.put(patch);
      }
    } finally { applying = false; }
  }
  function undo() {
    const e = undoStack.pop();
    if (!e) { toast('되돌릴 동작이 없습니다.'); return false; }
    apply(e, 'undo');
    redoStack.push(e);
    emit();
    toast(`되돌림: ${e.label || '마지막 동작'}`);
    return true;
  }
  function redo() {
    const e = redoStack.pop();
    if (!e) { toast('다시 할 동작이 없습니다.'); return false; }
    apply(e, 'redo');
    undoStack.push(e);
    emit();
    toast(`다시 함: ${e.label || '동작'}`);
    return true;
  }
  function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  const canUndo = () => undoStack.length > 0;
  const canRedo = () => redoStack.length > 0;
  const peek = () => (undoStack.length ? undoStack[undoStack.length - 1].label : '');
  const peekRedo = () => (redoStack.length ? redoStack[redoStack.length - 1].label : '');

  return { put, remove, note, group, undo, redo, on, canUndo, canRedo, peek, peekRedo, snap };
})();

// ---- annotate.js ----
// 하이라이트 — 원문 HTML은 건드리지 않고 실행 중에만 <mark>를 덧입힌다. 메모 카드는 memo-lane.js, 모아보기는 panel.js.
const Annot = (() => {
  const COLORS = ['yellow', 'green', 'pink', 'blue'];
  const COLOR_KO = { yellow: '노랑', green: '초록', pink: '분홍', blue: '파랑' };
  const SRC_KO = { pdf: '요약본', md: '강의노트', supp: '보완 현출' };
  const bidRow = new Map();     // 블록 id → 행 id
  const bidPos = new Map();     // 블록 id → 병렬 보기 문서 순서
  const rowPos = new Map();
  const orphans = new Set();    // 본문에서 위치를 찾지 못한 항목
  const blank = new Set();      // 빈칸 모드로 가린 색
  const revealed = new Set();   // 빈칸 모드에서 열어 둔 하이라이트
  let rowsMeta = [], unitsMeta = [];
  let toolbar, pop, popFor = null, pendingRange = null;

  // ---------- 텍스트 위치 계산 ----------
  function excluded(node, block) {
    const p = node.parentElement;
    if (!p) return true;
    const g = p.closest('[data-generated], .memo-card');
    return !!(g && block.contains(g) && g !== block);
  }
  function textNodes(block) {
    const out = [];
    let pos = 0;
    const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (excluded(n, block)) continue;
      const len = n.nodeValue.length;
      out.push({ node: n, start: pos, end: pos + len, len });
      pos += len;
    }
    return out;
  }
  function blockText(block) { return textNodes(block).map((t) => t.node.nodeValue).join(''); }
  function offsetOf(list, node, off) {
    if (node.nodeType === 3) {
      const t = list.find((x) => x.node === node);
      if (t) return t.start + Math.min(off, t.len);
    }
    for (const t of list) {
      const tr = document.createRange();
      tr.selectNodeContents(t.node);
      let cmp;
      try { cmp = tr.comparePoint(node, off); } catch (e) { cmp = 1; }
      if (cmp <= 0) return t.start;
    }
    return list.length ? list[list.length - 1].end : 0;
  }
  function topBlock(el) {
    let b = el && el.closest && el.closest('[data-bid]');
    while (b && b.parentElement && b.parentElement.closest('[data-bid]')) b = b.parentElement.closest('[data-bid]');
    return b;
  }

  function rangeToSegs(range) {
    let anc = range.commonAncestorContainer;
    if (anc.nodeType === 3) anc = anc.parentElement;
    if (!anc) return { segs: [] };
    if (anc.closest('.memo-card, .hl-toolbar, .hl-pop, .memo-lane, [data-generated]') && !anc.closest('[data-bid]')) return { segs: [] };
    let blocks;
    const single = topBlock(anc);
    if (single) blocks = [single];
    else {
      const root = anc.closest('.cell, .solo-inner, #doc-head, .unit-head');
      if (!root) return { segs: [], error: 'cross' };
      blocks = [...root.querySelectorAll('[data-bid]')].filter((b) => !b.parentElement.closest('[data-bid]') && range.intersectsNode(b));
    }
    const kinds = new Set(blocks.map((b) => (b.dataset.sb === 'pdf' ? 'pdf' : 'md')));
    if (kinds.size > 1) return { segs: [], error: 'cross' };
    const segs = [];
    for (const b of blocks) {
      const list = textNodes(b);
      const total = list.length ? list[list.length - 1].end : 0;
      const s = b.contains(range.startContainer) ? offsetOf(list, range.startContainer, range.startOffset) : 0;
      const e = b.contains(range.endContainer) ? offsetOf(list, range.endContainer, range.endOffset) : total;
      if (e > s) {
        const text = list.map((t) => t.node.nodeValue).join('').slice(s, e);
        if (text.trim()) segs.push({ b: b.dataset.bid, s, e, text });
      }
    }
    return { segs, blocks };
  }
  // 칠할 수 있는 선택인지: 본문 안이고, 입력칸·메모줄·패널 같은 곳이 아니어야 한다
  function selectionInContent(range) {
    const host = range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentElement : range.commonAncestorContainer;
    return !!(host && host.closest('#units, #solo-inner, #doc-head') && !host.closest('.memo-card, .memo-lane, textarea, input, [contenteditable="true"], .row-bar'));
  }

  // ---------- 칠하기 ----------
  const SKIP_PARENT = /^(UL|OL|TABLE|TBODY|THEAD|TR|DETAILS|DL)$/;
  function wrap(block, s, e, item) {
    const list = textNodes(block);
    const targets = [];
    for (const t of list) {
      if (t.end <= s || t.start >= e) continue;
      const a = Math.max(s, t.start) - t.start;
      const z = Math.min(e, t.end) - t.start;
      if (!t.node.nodeValue.slice(a, z).trim() && SKIP_PARENT.test(t.node.parentNode.nodeName)) continue;
      targets.push({ node: t.node, a, z });
    }
    const marks = [];
    for (const { node, a, z } of targets) {
      let n = node;
      if (z < n.nodeValue.length) n.splitText(z);
      if (a > 0) n = n.splitText(a);
      const m = document.createElement('mark');
      m.className = 'uhl' + (revealed.has(item.id) ? ' revealed' : '');
      m.dataset.hid = item.id;
      m.dataset.color = item.color || 'yellow';
      n.parentNode.insertBefore(m, n);
      m.appendChild(n);
      marks.push(m);
    }
    return marks;
  }
  function unwrapMark(m) {
    const p = m.parentNode;
    if (!p) return;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
    p.normalize();
  }
  function unpaintMarks(id) { $$(`mark.uhl[data-hid="${CSS.escape(id)}"]`).forEach(unwrapMark); }
  function unpaint(id) { unpaintMarks(id); MemoLane.drop(id); }
  // 블록 안의 하이라이트를 모두 걷는다 (편집 시작 전). 걷은 항목 id를 돌려준다.
  function clearBlock(block) {
    const ids = new Set();
    block.querySelectorAll('mark.uhl').forEach((m) => { ids.add(m.dataset.hid); unwrapMark(m); });
    return [...ids];
  }
  function findBlock(bid) { return document.querySelector(`[data-bid="${CSS.escape(bid)}"]`); }

  // 저장된 위치의 글자가 다르면(편집·원문 변경) 칠한 글자와 앞뒤 문맥으로 다시 찾는다
  function locate(seg, item, block) {
    const txt = blockText(block);
    if (txt.slice(seg.s, seg.e) === seg.text) return [seg.s, seg.e];
    const cands = [];
    let i = txt.indexOf(seg.text);
    while (i >= 0) { cands.push(i); i = txt.indexOf(seg.text, i + 1); }
    if (!cands.length) return null;
    let best = cands[0], bestScore = -Infinity;
    for (const c of cands) {
      let score = -Math.abs(c - seg.s) / 1000;
      if (item.pre && txt.slice(Math.max(0, c - item.pre.length), c) === item.pre) score += 2;
      if (item.post && txt.slice(c + seg.text.length, c + seg.text.length + item.post.length) === item.post) score += 2;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return [best, best + seg.text.length];
  }

  function paint(item) {
    unpaintMarks(item.id);
    if (item.kind === 'row') { MemoLane.upsert(item, null); return true; }
    const marks = [];
    for (const seg of item.segs || []) {
      const block = findBlock(seg.b);
      if (!block || Editor.isEditingBlock(block)) continue;
      const loc = locate(seg, item, block);
      if (!loc) continue;
      marks.push(...wrap(block, loc[0], loc[1], item));
    }
    if (marks.length) orphans.delete(item.id); else orphans.add(item.id);
    if (marks.length && (item.memo || MemoLane.isOpen(item.id))) {
      marks.forEach((m) => m.classList.add('has-memo'));
      marks[marks.length - 1].classList.add('memo-tail');
      MemoLane.upsert(item, marks);
    } else MemoLane.drop(item.id);
    return marks.length > 0;
  }
  // 편집으로 블록 글이 바뀐 뒤: 그 블록에 걸린 하이라이트를 다시 칠한다
  function repaintBlock(bid, extraIds) {
    const ids = new Set(extraIds || []);
    for (const it of Store.all('hl')) if ((it.segs || []).some((s) => s.b === bid)) ids.add(it.id);
    for (const id of ids) { const it = Store.get(id); if (it) paint(it); }
    refreshCounts();
  }
  function paintAll() {
    for (const it of Store.all(['hl', 'row'])) paint(it);
    refreshCounts();
  }

  // ---------- 만들기 ----------
  function createFromRange(range, color, withMemo) {
    const { segs, error } = rangeToSegs(range);
    if (error === 'cross') { toast('하이라이트는 한 칸(요약본 또는 강의노트) 안에서만 칠할 수 있습니다.'); return null; }
    if (!segs.length) return null;
    const firstB = findBlock(segs[0].b), lastB = findBlock(segs[segs.length - 1].b);
    const ft = blockText(firstB), lt = blockText(lastB);
    const last = segs[segs.length - 1];
    const item = {
      id: Store.newId('h'), kind: 'hl', color: color || 'yellow',
      segs, text: segs.map((s) => s.text.trim()).join(' … '),
      pre: ft.slice(Math.max(0, segs[0].s - 32), segs[0].s), post: lt.slice(last.e, last.e + 32),
      memo: '', collapsed: false,
      rowId: bidRow.get(segs[0].b) || null,
      src: firstB.dataset.sb,
    };
    if (withMemo) MemoLane.markOpen(item.id);
    if (blank.has(item.color)) revealed.add(item.id); // 빈칸 모드 중에 방금 칠한 곳은 열어 둔다
    try { window.getSelection().removeAllRanges(); } catch (e) { /* noop */ }
    hideToolbar();
    History.put(item, withMemo ? '메모 달기' : `${COLOR_KO[item.color]} 하이라이트`);
    if (withMemo) MemoLane.focus(item.id);
    return item;
  }
  function create(color, withMemo) {
    if (!pendingRange) return null;
    return createFromRange(pendingRange, color, withMemo);
  }

  // ---------- 선택 도구막대 (선택 도구일 때) ----------
  const coarse = () => window.matchMedia('(pointer: coarse)').matches;
  function placeFloating(el, rect, below) {
    el.hidden = false;
    const h = el.offsetHeight, w = el.offsetWidth;
    let top = below ? rect.bottom + window.scrollY + 10 : rect.top + window.scrollY - h - 10;
    if (!below && rect.top - h - 10 < 60) top = rect.bottom + window.scrollY + 10;
    let left = rect.left + window.scrollX + rect.width / 2 - w / 2;
    left = Math.max(window.scrollX + 8, Math.min(left, window.scrollX + document.documentElement.clientWidth - w - 8));
    el.style.top = top + 'px';
    el.style.left = left + 'px';
  }
  function hideToolbar() { if (toolbar) toolbar.hidden = true; pendingRange = null; }
  function hidePop() { if (pop) pop.hidden = true; popFor = null; }
  const floatingOpen = () => !!((toolbar && !toolbar.hidden) || (pop && !pop.hidden));

  let selTimer = null;
  function onSelection() {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      if (Dock.tool() !== 'select' || document.body.classList.contains('edit-mode')) { hideToolbar(); return; }
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { if (!toolbar.contains(document.activeElement)) hideToolbar(); return; }
      const range = sel.getRangeAt(0);
      if (!selectionInContent(range)) { hideToolbar(); return; }
      const { segs, error } = rangeToSegs(range);
      if (error === 'cross') { hideToolbar(); toast('하이라이트는 한 칸(요약본 또는 강의노트) 안에서만 칠할 수 있습니다.'); return; }
      if (!segs.length) { hideToolbar(); return; }
      pendingRange = range.cloneRange();
      hidePop();
      placeFloating(toolbar, range.getBoundingClientRect(), coarse());
    }, 160);
  }

  function openPop(mark) {
    const id = mark.dataset.hid;
    const it = Store.get(id);
    if (!it) return;
    popFor = id;
    pop.querySelectorAll('.hl-sw').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === it.color)));
    pop.querySelector('[data-act="memo"]').textContent = it.memo ? '메모 보기' : '메모 쓰기';
    placeFloating(pop, mark.getBoundingClientRect(), coarse());
  }
  async function deleteHl(id) {
    const it = Store.get(id);
    if (!it) return;
    if (it.memo && !(await confirmDlg('하이라이트 삭제', '메모도 함께 지워집니다. 지울까요? (되돌리기로 살릴 수 있습니다)'))) return;
    MemoLane.unmarkOpen(id);
    History.remove(id, '하이라이트 삭제');
  }
  function setColor(id, color) {
    const it = Store.get(id);
    if (!it || it.color === color) return;
    History.put({ id, color }, '색 바꾸기');
  }

  // ---------- 빈칸 모드 ----------
  function setBlank(colors) {
    blank.clear();
    (colors || []).forEach((c) => { if (COLORS.includes(c)) blank.add(c); });
    COLORS.forEach((c) => document.body.classList.toggle('blank-' + c, blank.has(c)));
    document.body.classList.toggle('blank-on', blank.size > 0);
    revealAll(false);
  }
  const blankColors = () => [...blank];
  const isBlanked = (color) => blank.has(color);
  function toggleReveal(hid, force) {
    const on = force === undefined ? !revealed.has(hid) : !!force;
    if (on) revealed.add(hid); else revealed.delete(hid);
    $$(`[data-hid="${CSS.escape(hid)}"], .memo-card[data-memo-for="${CSS.escape(hid)}"]`).forEach((el) => el.classList.toggle('revealed', on));
    return on;
  }
  function revealAll(on) {
    revealed.clear();
    if (on) for (const it of Store.all('hl')) revealed.add(it.id);
    $$('.revealed').forEach((el) => el.classList.remove('revealed'));
    if (on) $$('[data-hid], .memo-card[data-memo-for]').forEach((el) => el.classList.add('revealed'));
  }
  const isRevealed = (hid) => revealed.has(hid);

  // ---------- 다시 그리기 ----------
  function onStore(ev) {
    let touched = false;
    for (const id of ev.ids || []) {
      const r = Store.raw(id);
      const kind = r ? (r.kind || 'hl') : null;
      if (kind !== 'hl' && kind !== 'row') continue;
      touched = true;
      if (ev.silent) continue; // 메모 글·접힘 저장: 카드는 이미 최신
      const it = Store.get(id);
      if (!it) { unpaint(id); continue; }
      if (!ev.local && MemoLane.isEditing(id)) {
        // 입력 중인 메모 칸은 덮어쓰지 않는다 (색만 반영)
        $$(`mark.uhl[data-hid="${CSS.escape(id)}"]`).forEach((m) => { m.dataset.color = it.color; });
        continue;
      }
      paint(it);
    }
    if (touched) { refreshCounts(); Panel.refresh(); }
  }

  function itemRow(it) {
    if (!it) return null;
    return it.kind === 'row' ? it.rowId : (bidRow.get(it.segs?.[0]?.b) || it.rowId || null);
  }
  function itemPos(it) {
    const r = itemRow(it);
    const seg = it.segs?.[0];
    return [rowPos.get(r) ?? 1e9, it.kind === 'row' ? -1 : (bidPos.get(seg?.b) ?? 1e9), seg?.s ?? 0];
  }

  function refreshCounts() {
    const items = Store.all(['hl', 'row']);
    $('#hl-count').textContent = String(items.filter((i) => i.kind === 'hl').length);
    const per = new Map();
    for (const it of items) {
      const r = itemRow(it);
      if (r) per.set(r, (per.get(r) || 0) + 1);
    }
    $$('[data-hl-count]').forEach((el) => {
      const n = per.get(el.dataset.hlCount) || 0;
      el.hidden = n === 0;
      el.textContent = n ? String(n) : '';
      el.title = n ? `하이라이트·메모 ${n}개` : '';
    });
    MemoLane.refreshRowButtons();
  }

  // ---------- 초기화 ----------
  function indexBlocks() {
    bidPos.clear(); bidRow.clear(); rowPos.clear();
    let i = 0;
    $$('#doc-head [data-bid], #units [data-bid]').forEach((b) => {
      bidPos.set(b.dataset.bid, i++);
      const row = b.closest('.row');
      if (row) bidRow.set(b.dataset.bid, row.dataset.row);
      else {
        const unit = b.closest('.unit');
        const first = unit && unit.querySelector('.row');
        if (first) bidRow.set(b.dataset.bid, first.dataset.row);
      }
    });
    rowsMeta.forEach((r, k) => rowPos.set(r.id, k));
  }

  function init(content) {
    rowsMeta = content.rows || [];
    unitsMeta = content.units || [];
    toolbar = $('#hl-toolbar');
    pop = $('#hl-pop');
    indexBlocks();

    document.addEventListener('selectionchange', onSelection);
    toolbar.addEventListener('mousedown', (e) => e.preventDefault());
    toolbar.addEventListener('click', (e) => {
      const sw = e.target.closest('.hl-sw');
      if (sw) return create(sw.dataset.color);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'memo') create('yellow', true);
      if (act === 'cancel') { window.getSelection().removeAllRanges(); hideToolbar(); }
    });
    pop.addEventListener('click', (e) => {
      if (!popFor) return;
      const id = popFor;
      const sw = e.target.closest('.hl-sw');
      if (sw) { setColor(id, sw.dataset.color); hidePop(); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'memo') { hidePop(); MemoLane.open(id); }
      if (act === 'delete') { hidePop(); deleteHl(id); }
    });
    $('#main').addEventListener('click', (e) => {
      if (document.body.classList.contains('edit-mode')) return;
      const m = e.target.closest('mark.uhl');
      if (m && window.getSelection().isCollapsed) {
        e.preventDefault();
        if (isBlanked(m.dataset.color)) { toggleReveal(m.dataset.hid); return; }
        if (isNarrow() && m.classList.contains('has-memo')) { MemoLane.openSheet(m.dataset.hid); return; }
        openPop(m);
      }
    });
    // 하이라이트에 마우스를 올리면 연결된 메모 카드도 함께 강조
    $('#main').addEventListener('mouseover', (e) => {
      const m = e.target.closest && e.target.closest('mark.uhl.has-memo');
      if (m) MemoLane.link(m.dataset.hid, true);
    });
    $('#main').addEventListener('mouseout', (e) => {
      const m = e.target.closest && e.target.closest('mark.uhl.has-memo');
      if (m && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(`mark.uhl[data-hid="${CSS.escape(m.dataset.hid)}"]`))) MemoLane.link(m.dataset.hid, false);
    });
    document.addEventListener('mousedown', (e) => {
      if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('mark.uhl')) hidePop();
    });
    document.addEventListener('keydown', (e) => {
      if (inTypingTarget(e.target) || toolbar.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'h' || e.key === 'H' || e.key === 'ㅗ') { e.preventDefault(); create('yellow'); }
      if (e.key === 'm' || e.key === 'M' || e.key === 'ㅡ') { e.preventDefault(); e.stopImmediatePropagation(); create('yellow', true); }
    }, true);
    window.addEventListener('resize', () => { hideToolbar(); hidePop(); });

    Store.on(onStore);
    paintAll();
  }

  return {
    init, paint, paintAll, repaintBlock, clearBlock, unpaint, refreshCounts, createFromRange, rangeToSegs, selectionInContent,
    blockText, topBlock, findBlock, hideToolbar, hidePop, floatingOpen, deleteHl, setColor,
    setBlank, blankColors, isBlanked, toggleReveal, revealAll, isRevealed,
    itemRow, itemPos, isOrphan: (id) => orphans.has(id), bidRow, bidPos, rowPos,
    rows: () => rowsMeta, units: () => unitsMeta, COLORS, COLOR_KO, SRC_KO,
  };
})();

// ---- memo-lane.js ----
// 오른쪽 메모줄 — 메모 카드를 하이라이트와 같은 높이의 오른쪽 여백 줄에 놓는다 (구글 문서 댓글처럼).
// 병렬 보기는 행마다 메모줄 칸, 원문 순서 보기는 #solo 옆에 하나. 좁은 화면(900px 미만)은 아래에서 올라오는 시트.
const MemoLane = (() => {
  const GAP = 8;
  const cards = new Map();     // 항목 id → 카드
  const openSet = new Set();   // 메모가 비어 있어도 카드를 보여 줄 하이라이트
  let activeId = null, editBefore = null;
  let sheet, sheetFor = null, sheetBefore = null;
  let soloLane = null;

  // ---------- 카드 ----------
  function card(item) {
    let c = cards.get(item.id);
    const isRow = item.kind === 'row';
    if (!c) {
      c = document.createElement('div');
      c.className = 'memo-card';
      c.dataset.generated = '';
      c.dataset.memoFor = item.id;
      c.innerHTML =
        `<div class="memo-head"><button type="button" class="tw" aria-label="메모 접기/펼치기"></button>` +
        `<span class="memo-dot"></span><span class="memo-prev"></span><span class="memo-kind"></span></div>` +
        `<div class="memo-body"><p class="memo-quote"></p><textarea rows="3" placeholder="메모를 적으세요. 입력을 멈추면 자동 저장됩니다."></textarea>` +
        `<div class="memo-meta"><span class="memo-time"></span><button type="button" data-act="del"></button></div></div>`;
      bindCard(c, item.id);
      cards.set(item.id, c);
    }
    c.dataset.color = isRow ? 'row' : (item.color || 'yellow');
    c.classList.toggle('row-memo', isRow);
    c.classList.toggle('collapsed', !!item.collapsed);
    c.classList.toggle('revealed', Annot.isRevealed(item.id));
    c.querySelector('.tw').textContent = item.collapsed ? '▸' : '▾';
    c.querySelector('.memo-dot').dataset.color = c.dataset.color;
    c.querySelector('.memo-kind').textContent = isRow ? '행 메모' : '메모';
    c.querySelector('[data-act="del"]').textContent = isRow ? '행 메모 삭제' : '메모 지우기';
    const q = c.querySelector('.memo-quote');
    q.hidden = isRow;
    q.textContent = isRow ? '' : '“' + (item.text || '') + '”';
    const ta = c.querySelector('textarea');
    if (document.activeElement !== ta && ta.value !== (item.memo || '')) ta.value = item.memo || '';
    grow(ta);
    c.querySelector('.memo-prev').textContent = firstLine(ta.value) || (isRow ? '빈 행 메모' : '빈 메모');
    c.querySelector('.memo-time').textContent = item.updatedAt ? `수정 ${fmtTime(item.updatedAt)}` : '';
    return c;
  }
  // 입력칸 높이를 글에 맞춘다 (메모줄에서 카드가 필요 이상 길지 않게). 보이지 않으면 다음 배치 때 맞춘다.
  function grow(ta) {
    if (!ta.offsetParent) { ta.dataset.grow = '1'; return; }
    delete ta.dataset.grow;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 256) + 'px';
  }
  function bindCard(c, id) {
    const ta = c.querySelector('textarea');
    let timer = null;
    ta.addEventListener('focus', () => {
      activeId = id;
      editBefore = History.snap(id);
      c.classList.add('active');
      schedule();
    });
    ta.addEventListener('input', () => {
      clearTimeout(timer);
      grow(ta);
      c.querySelector('.memo-prev').textContent = firstLine(ta.value) || '빈 메모';
      timer = setTimeout(() => saveMemo(id, ta.value), 600);
      schedule();
    });
    ta.addEventListener('blur', () => {
      clearTimeout(timer);
      saveMemo(id, ta.value);
      if (editBefore) History.note(id, editBefore, '메모 수정');
      editBefore = null;
      if (activeId === id) activeId = null;
      c.classList.remove('active');
      schedule();
    });
    c.querySelector('.memo-head').addEventListener('click', (ev) => {
      if (ev.target.closest('textarea')) return;
      toggleCollapse(id);
    });
    c.querySelector('[data-act="del"]').addEventListener('click', () => deleteMemo(id));
    c.addEventListener('mouseenter', () => link(id, true));
    c.addEventListener('mouseleave', () => link(id, false));
  }
  function saveMemo(id, value) {
    const cur = Store.get(id);
    if (!cur || (cur.memo || '') === value) return;
    Store.put({ id, memo: value }, { silent: true });
    const c = cards.get(id);
    if (c) c.querySelector('.memo-time').textContent = `수정 ${fmtTime(Date.now())}`;
    marksOf(id).forEach((m) => m.classList.toggle('has-memo', !!value || openSet.has(id)));
  }
  async function deleteMemo(id) {
    const it = Store.get(id);
    if (!it) return;
    if (it.kind === 'row') {
      if (await confirmDlg('행 메모 삭제', '이 행 메모를 지울까요? (되돌리기로 살릴 수 있습니다)')) History.remove(id, '행 메모 삭제');
    } else {
      openSet.delete(id);
      if (it.memo) History.put({ id, memo: '' }, '메모 지우기');
      else Annot.paint(it);
    }
  }
  function toggleCollapse(id, force, opts) {
    const cur = Store.get(id);
    if (!cur) return;
    const collapsed = force === undefined ? !cur.collapsed : force;
    if (!!cur.collapsed === collapsed) return;
    const before = History.snap(id);
    Store.put({ id, collapsed }, { silent: true });
    if (!(opts && opts.noHistory)) History.note(id, before, collapsed ? '메모 접기' : '메모 펴기');
    const c = cards.get(id);
    if (c) {
      c.classList.toggle('collapsed', collapsed);
      c.querySelector('.tw').textContent = collapsed ? '▸' : '▾';
      if (!collapsed) c.querySelector('textarea').dataset.grow = '1';
    }
    schedule();
  }
  function toggleAllMemos() {
    const items = Store.all(['hl', 'row']).filter((it) => it.kind === 'row' || it.memo);
    if (!items.length) { toast('메모가 아직 없습니다.'); return; }
    const anyOpen = items.some((it) => !it.collapsed);
    History.group(anyOpen ? '메모 모두 접기' : '메모 모두 펴기', () => {
      items.forEach((it) => {
        const before = History.snap(it.id);
        toggleCollapse(it.id, anyOpen, { noHistory: true });
        History.note(it.id, before);
      });
    });
    toast(anyOpen ? '메모를 모두 접었습니다.' : '메모를 모두 펼쳤습니다.');
  }
  function addRowMemo(rowId) {
    const it = History.put({ id: Store.newId('r'), kind: 'row', rowId, memo: '', collapsed: false }, '행 메모');
    focus(it.id);
  }

  const marksOf = (id) => $$(`mark.uhl[data-hid="${CSS.escape(id)}"]`);
  function link(id, on) {
    const c = cards.get(id);
    if (c) c.classList.toggle('linked', on);
    marksOf(id).forEach((m) => m.classList.toggle('linked', on));
  }

  // ---------- 바깥에서 부르는 것 ----------
  function upsert(item) {
    card(item);
    if (sheetFor === item.id && !sheetFocused()) fillSheet(item);
    schedule();
  }
  function drop(id) {
    const c = cards.get(id);
    if (c) { c.remove(); cards.delete(id); }
    if (activeId === id) activeId = null;
    if (sheetFor === id) closeSheet();
    schedule();
  }
  const isOpen = (id) => openSet.has(id);
  function markOpen(id) { openSet.add(id); }
  function unmarkOpen(id) { openSet.delete(id); }
  function isEditing(id) { return activeId === id || (sheetFor === id && sheetFocused()); }
  // 메모를 열어 입력칸으로 (메모 펜, '메모 쓰기')
  function open(id) {
    const it = Store.get(id);
    if (!it) return;
    openSet.add(id);
    Annot.paint(it);
    focus(id);
  }
  function focus(id) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (isNarrow()) { openSheet(id); return; }
      if (document.body.classList.contains('lane-closed')) App.setLane(true);
      const c = cards.get(id);
      if (!c) return;
      if (c.classList.contains('collapsed')) toggleCollapse(id, false, { noHistory: true });
      layout();
      if (c.hidden) { openSheet(id); return; }
      c.querySelector('textarea').focus({ preventScroll: true });
      c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }));
  }

  // ---------- 배치 ----------
  function soloAnchorForRow(rowId) {
    for (const el of $$('#solo-inner [data-bid]')) if (Annot.bidRow.get(el.dataset.bid) === rowId) return el;
    return null;
  }
  // 접힌 판례 상자 안이면 그 제목 줄을, 숨겨진 곳이면 null
  function visibleAnchor(el) {
    let d = el.closest('details:not([open])');
    while (d && d.parentElement && d.parentElement.closest('details:not([open])')) d = d.parentElement.closest('details:not([open])');
    const a = d ? (d.querySelector(':scope > summary') || d) : el;
    return a.getClientRects().length ? a : null;
  }
  function target(item) {
    const solo = document.body.classList.contains('mode-solo');
    if (item.kind === 'row') {
      if (solo) { const el = soloAnchorForRow(item.rowId); return el ? { lane: soloLane, anchor: el } : null; }
      const row = document.getElementById(item.rowId);
      const lane = row && row.querySelector(':scope > .memo-lane');
      return lane ? { lane, anchor: null } : null;
    }
    const m = document.querySelector(`mark.uhl[data-hid="${CSS.escape(item.id)}"]`);
    if (!m) return null;
    if (solo) return m.closest('#solo-inner') ? { lane: soloLane, anchor: m } : null;
    const row = m.closest('.row');
    if (row) return { lane: row.querySelector(':scope > .memo-lane'), anchor: m };
    const unit = m.closest('.unit');
    const first = unit && unit.querySelector('.row > .memo-lane');
    if (first) return { lane: first, anchor: null };
    const block = Annot.topBlock(m);
    return block ? { inline: block } : null;
  }
  const schedule = rafOnce(layout);
  function layout() {
    const closed = document.body.classList.contains('lane-closed');
    const narrow = isNarrow();
    // 1) 카드를 제자리 칸으로 옮긴다
    const placed = [];
    for (const [id, c] of cards) {
      const item = Store.get(id);
      if (!item) { c.remove(); cards.delete(id); continue; }
      const t = narrow ? null : target(item);
      if (!t) { c.hidden = true; continue; }
      c.hidden = false;
      if (t.inline) {
        c.classList.add('inline');
        c.style.top = '';
        if (t.inline.nextElementSibling !== c) t.inline.after(c);
        continue;
      }
      c.classList.remove('inline');
      if (c.parentElement !== t.lane) t.lane.appendChild(c);
      placed.push({ id, c, item, t });
    }
    for (const p of placed) { const ta = p.c.querySelector('textarea'); if (ta.dataset.grow && !closed) grow(ta); }
    // 2) 높이·위치 읽기
    const perLane = new Map();
    for (const p of placed) {
      let top = 0;
      if (p.t.anchor) {
        const a = visibleAnchor(p.t.anchor);
        if (!a) { p.c.hidden = true; continue; }
        const r = a.getBoundingClientRect();
        if (p.t.lane === soloLane) top = r.top - soloLane.getBoundingClientRect().top;
        else {
          const cell = a.closest('.cell');
          top = cell ? r.top - cell.getBoundingClientRect().top : 0;
        }
      }
      p.top = Math.max(0, Math.round(top));
      p.h = closed ? 0 : p.c.offsetHeight;
      p.order = Annot.itemPos(p.item);
      if (!perLane.has(p.t.lane)) perLane.set(p.t.lane, []);
      perLane.get(p.t.lane).push(p);
    }
    // 3) 겹치지 않게 놓기
    const lanesAll = $$('.memo-lane');
    for (const lane of lanesAll) {
      lane.querySelectorAll(':scope > .lane-pin').forEach((x) => x.remove());
      const list = perLane.get(lane);
      if (!list || !list.length) { lane.style.minHeight = ''; lane.classList.remove('has-cards'); continue; }
      lane.classList.add('has-cards');
      list.sort((a, b) => a.top - b.top || a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2]);
      if (closed) { pins(lane, list); continue; }
      const ai = list.findIndex((p) => p.id === activeId);
      const y = new Array(list.length);
      if (ai < 0) {
        let prev = 0;
        list.forEach((p, i) => { y[i] = Math.max(p.top, prev); prev = y[i] + p.h + GAP; });
      } else {
        y[ai] = list[ai].top;
        for (let i = ai - 1; i >= 0; i--) y[i] = Math.min(list[i].top, y[i + 1] - GAP - list[i].h);
        for (let i = ai + 1; i < list.length; i++) y[i] = Math.max(list[i].top, y[i - 1] + list[i - 1].h + GAP);
        if (y[0] < 0) { let prev = 0; list.forEach((p, i) => { y[i] = Math.max(y[i], prev); prev = y[i] + p.h + GAP; }); }
      }
      let bottom = 0;
      list.forEach((p, i) => { p.c.style.top = y[i] + 'px'; bottom = Math.max(bottom, y[i] + p.h); });
      lane.style.minHeight = (bottom + 16) + 'px';
    }
  }
  // 접힌 메모줄: 메모가 있는 높이마다 작은 표시만
  function pins(lane, list) {
    const groups = [];
    for (const p of list) {
      const g = groups[groups.length - 1];
      if (g && p.top - g.top < 26) g.ids.push(p.id); else groups.push({ top: p.top, ids: [p.id] });
    }
    let bottom = 0;
    for (const g of groups) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lane-pin';
      b.dataset.generated = '';
      b.dataset.ids = g.ids.join(' ');
      b.style.top = g.top + 'px';
      b.title = `메모 ${g.ids.length}개 — 눌러서 메모줄 펼치기`;
      b.setAttribute('aria-label', b.title);
      b.textContent = g.ids.length > 1 ? `✎${g.ids.length}` : '✎';
      lane.appendChild(b);
      bottom = g.top + 28;
    }
    lane.style.minHeight = (bottom + 8) + 'px';
  }

  // ---------- 좁은 화면: 아래 시트 ----------
  const sheetFocused = () => !!(sheet && sheet.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA');
  function rowMemos(rowId) {
    return Store.all(['hl', 'row'])
      .filter((it) => Annot.itemRow(it) === rowId && (it.kind === 'row' || it.memo || openSet.has(it.id)))
      .sort((a, b) => { const pa = Annot.itemPos(a), pb = Annot.itemPos(b); return pa[1] - pb[1] || pa[2] - pb[2]; });
  }
  function fillSheet(item) {
    const isRow = item.kind === 'row';
    sheet.dataset.hid = item.id;
    sheet.dataset.color = isRow ? 'row' : item.color;
    sheet.classList.toggle('revealed', Annot.isRevealed(item.id));
    const rm = Annot.rows().find((r) => r.id === Annot.itemRow(item));
    $('.ms-row', sheet).textContent = rm ? rm.title : '';
    $('.ms-title', sheet).textContent = isRow ? '행 메모' : '메모';
    const q = $('.ms-quote', sheet);
    q.hidden = isRow;
    q.textContent = isRow ? '' : '“' + (item.text || '') + '”';
    $('.ms-colors', sheet).hidden = isRow;
    $$('.ms-colors .hl-sw', sheet).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === item.color)));
    $('[data-act="delhl"]', sheet).hidden = isRow;
    $('[data-act="delmemo"]', sheet).textContent = isRow ? '행 메모 삭제' : '메모 지우기';
    const ta = $('#ms-text', sheet);
    if (document.activeElement !== ta) ta.value = item.memo || '';
    $('.memo-time', sheet).textContent = item.updatedAt ? `수정 ${fmtTime(item.updatedAt)}` : '';
    const list = $('.ms-list', sheet);
    list.innerHTML = '';
    const others = rowMemos(Annot.itemRow(item)).filter((it) => it.id !== item.id);
    $('.ms-list-title', sheet).hidden = !others.length;
    for (const o of others) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ms-other';
      b.dataset.id = o.id;
      const dot = document.createElement('span'); dot.className = 'memo-dot'; dot.dataset.color = o.kind === 'row' ? 'row' : o.color;
      const t = document.createElement('span'); t.textContent = firstLine(o.memo) || (o.kind === 'row' ? '빈 행 메모' : '빈 메모');
      b.append(dot, t);
      list.appendChild(b);
    }
  }
  function openSheet(id) {
    const it = Store.get(id);
    if (!it) return;
    if (sheetFor && sheetFor !== id) commitSheet();
    sheetFor = id;
    sheetBefore = History.snap(id);
    fillSheet(it);
    sheet.hidden = false;
    document.body.classList.add('sheet-open');
    requestAnimationFrame(() => sheet.classList.add('up'));
    if (!it.memo) setTimeout(() => $('#ms-text', sheet).focus(), 60);
  }
  function openSheetForRow(rowId) {
    const list = rowMemos(rowId);
    if (list.length) openSheet(list[0].id); else addRowMemo(rowId);
  }
  function commitSheet() {
    if (!sheetFor) return;
    const ta = $('#ms-text', sheet);
    saveMemo(sheetFor, ta.value);
    if (sheetBefore) History.note(sheetFor, sheetBefore, '메모 수정');
    sheetBefore = History.snap(sheetFor);
  }
  function closeSheet() {
    if (!sheet || sheet.hidden) return;
    commitSheet();
    sheetFor = null; sheetBefore = null;
    sheet.classList.remove('up');
    sheet.hidden = true;
    delete sheet.dataset.hid;
    document.body.classList.remove('sheet-open');
  }
  const sheetOpen = () => !!(sheet && !sheet.hidden);
  function bindSheet() {
    sheet = $('#memo-sheet');
    let timer = null;
    const ta = $('#ms-text', sheet);
    ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => sheetFor && saveMemo(sheetFor, ta.value), 600); });
    ta.addEventListener('blur', () => { clearTimeout(timer); commitSheet(); });
    $('#ms-close', sheet).addEventListener('click', closeSheet);
    sheet.addEventListener('click', async (e) => {
      if (!sheetFor) return;
      const id = sheetFor;
      const sw = e.target.closest('.hl-sw');
      if (sw) { Annot.setColor(id, sw.dataset.color); const it = Store.get(id); if (it) fillSheet(it); return; }
      const other = e.target.closest('.ms-other');
      if (other) { openSheet(other.dataset.id); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'delmemo') {
        const it = Store.get(id);
        if (it && it.kind === 'row') { closeSheet(); await deleteMemo(id); }
        else { ta.value = ''; commitSheet(); openSet.delete(id); closeSheet(); const cur = Store.get(id); if (cur) Annot.paint(cur); }
      }
      if (act === 'delhl') { closeSheet(); Annot.deleteHl(id); }
    });
  }

  function refreshRowButtons() {
    const per = new Map();
    for (const it of Store.all(['hl', 'row'])) {
      if (it.kind !== 'row' && !it.memo) continue;
      const r = Annot.itemRow(it);
      if (r) per.set(r, (per.get(r) || 0) + 1);
    }
    $$('.row-memo-open').forEach((b) => {
      const n = per.get(b.dataset.row) || 0;
      b.hidden = n === 0;
      b.textContent = `✎ ${n}`;
      b.title = `이 행의 메모 ${n}개`;
    });
  }

  function init() {
    $$('#units .col-heads').forEach((h) => {
      if (h.querySelector('.ch-lane')) return;
      const d = document.createElement('div');
      d.className = 'ch-lane';
      d.textContent = '메모';
      h.appendChild(d);
    });
    $$('#units .row').forEach((row) => {
      const lane = document.createElement('div');
      lane.className = 'memo-lane';
      lane.dataset.generated = '';
      row.appendChild(lane);
      const bar = row.querySelector('.row-bar');
      const add = bar && bar.querySelector('.row-memo-add');
      if (add) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'row-memo-open';
        b.dataset.row = row.dataset.row;
        b.hidden = true;
        add.before(b);
      }
    });
    soloLane = document.createElement('div');
    soloLane.className = 'memo-lane solo-lane';
    soloLane.dataset.generated = '';
    $('#solo').appendChild(soloLane);
    bindSheet();

    $('#main').addEventListener('click', (e) => {
      const add = e.target.closest('.row-memo-add');
      if (add) { addRowMemo(add.dataset.row); return; }
      const openBtn = e.target.closest('.row-memo-open');
      if (openBtn) { openSheetForRow(openBtn.dataset.row); return; }
      const pin = e.target.closest('.lane-pin');
      if (pin) { const ids = pin.dataset.ids.split(' '); App.setLane(true); focus(ids[0]); }
    });
    narrowMq.addEventListener('change', () => { if (!isNarrow()) closeSheet(); schedule(); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
    document.addEventListener('toggle', (e) => { if (e.target.tagName === 'DETAILS') schedule(); }, true);
  }

  return {
    init, upsert, drop, isOpen, markOpen, unmarkOpen, isEditing, open, focus, schedule, layout, link,
    toggleAllMemos, addRowMemo, openSheet, closeSheet, sheetOpen, refreshRowButtons,
  };
})();

// ---- panel.js ----
// 하이라이트 모아보기 — 단원 › 대쟁점(■/‣) › 소쟁점 › 세부 경로로 묶어 보여준다. 오른쪽 창 또는 전체 화면.
// 계층은 화면(DOM)에서 계산한다: 예전 content.json 캐시로 열려도 동작하고, 편집한 제목도 반영된다.
const Panel = (() => {
  const PANEL_KEY = 'gongbeop2:hl-panel';
  const rowTree = new Map();   // 행 id → { id, unit, title, depth, isMajor, major, pos, anchor, titleBid, ctx }
  const bidTrail = new Map();  // 블록 id → 그 블록까지의 제목 경로(crumb[])
  const headBids = new Set();
  let closed = new Set();
  let full = false;
  let panelEl, listEl;
  const ret = { scrollTop: 0, hid: null, full: false };

  // ---------- 계층 ----------
  const MARKS = [[/^[■‣]/, 1], [/^\d{1,2}\.{1,2}(?!\d)/, 2], [/^[가-하]\./, 3], [/^\d{1,2}\)/, 4], [/^(\(\d{1,2}\)|[①-⑳])/, 5]];
  function markerLevel(t) { for (const [re, l] of MARKS) if (re.test(t)) return l; return 0; }
  function headText(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll('[data-generated], sup.fnref, .memo-card').forEach((x) => x.remove());
    return c.textContent.replace(/\s+/g, ' ').trim();
  }
  function shortTitle(t, max) {
    max = max || 46;
    const cut = t.search(/[:：]\s/);
    if (cut > 0 && cut < 40) t = t.slice(0, cut);
    return t.length > max ? t.slice(0, max - 2) + '…' : t;
  }
  function norm(s) {
    return String(s || '').replace(/^[\s■‣※\-–·]+/, '').replace(/^(\d{1,2}\.{1,2}|[가-하]\.|\d{1,2}\)|\(\d{1,2}\)|[①-⑳])\s*/, '')
      .replace(/[★☆*\s()（）[\]「」“”"'.,:：·…]/g, '').toLowerCase();
  }
  function sameText(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    return x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)));
  }
  function headingOf(el, src) {
    if (src === 'pdf') {
      const cls = el.classList.contains('pb-h3') ? 1 : el.classList.contains('pb-h4') ? 2 : el.classList.contains('pb-h5') ? 3 : el.classList.contains('pb-h6') ? 6 : 0;
      const full = headText(el);
      const m = markerLevel(full);
      if (cls) {
        let lvl = cls === 1 ? 1 : (m && m !== 1 ? m : cls);
        if (cls !== 1 && m === 1) lvl = cls;
        return { lvl, text: shortTitle(full), full };
      }
      if (el.classList.contains('pb-p') && m >= 2) {
        const cut = full.search(/[:：]\s/);
        return { lvl: m, text: cut > 0 ? full.slice(0, cut) : shortTitle(full, 26), full, runin: true };
      }
      return null;
    }
    if (el.classList.contains('mb')) {
      const h = el.querySelector(':scope > .md-h');
      if (!h) return null;
      const n = Number((h.className.match(/md-h(\d)/) || [])[1] || 2);
      const full = headText(h);
      return { lvl: n - 1, text: shortTitle(full), full };
    }
    return null;
  }

  function buildHierarchy() {
    rowTree.clear(); bidTrail.clear(); headBids.clear();
    const units = Annot.units();
    const unitNum = new Map(units.map((u) => [u.id, u.num]));
    let major = null, unit = null, k = 0;
    Annot.rows().forEach((r, pos) => {
      if (r.unit !== unit) { unit = r.unit; major = null; k = 0; }
      k++;
      const depth = r.depth || 2;
      const node = { id: r.id, unit: r.unit, title: r.title, depth, isMajor: depth === 1, major: null, pos, anchor: `${unitNum.get(r.unit) || ''}·${k}`, titleBid: null, titleSrc: null, ctx: [] };
      if (node.isMajor) major = r.id;
      node.major = major;
      rowTree.set(r.id, node);
    });
    $$('#units .unit').forEach((u) => {
      const st = { pdf: [], md: [] };
      u.querySelectorAll(':scope > .unit-head [data-bid]').forEach((b) => bidTrail.set(b.dataset.bid, [{ text: '단원 제목', full: '단원 제목', lvl: 0, synthetic: true, rowId: Annot.bidRow.get(b.dataset.bid) }]));
      u.querySelectorAll(':scope > .row').forEach((row) => {
        const node = rowTree.get(row.dataset.row);
        if (!node) return;
        const mdBefore = st.md.slice();
        row.querySelectorAll(':scope > .cell').forEach((cell) => {
          const src = cell.dataset.src;
          const stack = st[src];
          cell.querySelectorAll(':scope > [data-bid]').forEach((el) => {
            const h = headingOf(el, src);
            if (h) {
              while (stack.length && stack[stack.length - 1].lvl >= h.lvl) stack.pop();
              stack.push(Object.assign({}, h, { bid: el.dataset.bid, rowId: node.id, rowPos: node.pos, src }));
            }
            const trail = stack.slice();
            if (el.classList.contains('pdf-fn')) trail.push({ text: `각주 ${(el.id || '').replace('fn-', '')}`, full: '각주', lvl: 99, synthetic: true, rowId: node.id });
            bidTrail.set(el.dataset.bid, trail);
          });
        });
        if (row.querySelector(':scope > .cell-md > .moved-badge')) st.md = mdBefore;
        const tb = row.dataset.hasPdf === '1' ? row.querySelector(':scope > .cell-pdf > [data-sb="pdf"]') : row.querySelector(':scope > .cell-md > .mb-heading');
        if (tb) { node.titleBid = tb.dataset.bid; node.titleSrc = row.dataset.hasPdf === '1' ? 'pdf' : 'md'; }
      });
    });
    $$('#doc-head [data-bid]').forEach((b) => headBids.add(b.dataset.bid));
    // 대쟁점과 소쟁점 사이의 번호 제목 (예: '나.' 행 위에 있는 다른 행의 '2.' 제목)
    for (const node of rowTree.values()) {
      if (node.isMajor || !node.titleBid) continue;
      const t = bidTrail.get(node.titleBid);
      if (!t || !t.length || t[t.length - 1].bid !== node.titleBid) continue;
      const self = t[t.length - 1];
      if (node.titleSrc === 'pdf' && self.lvl >= 6) continue;
      const mj = node.major ? rowTree.get(node.major) : null;
      node.ctx = t.slice(0, -1).filter((c) => !c.synthetic && c.bid !== (mj && mj.titleBid) && (!mj || c.rowPos >= mj.pos)
        && (c.src === 'md' || (c.lvl >= 2 && c.lvl <= 5)) && !(mj && sameText(c.text, mj.title)) && !sameText(c.text, node.title));
    }
  }

  function itemTrail(it, node) {
    if (it.kind === 'row' || !it.segs || !it.segs.length) return [];
    const t = bidTrail.get(it.segs[0].b) || [];
    const mj = node.major ? rowTree.get(node.major) : null;
    const unit = Annot.units().find((u) => u.id === node.unit);
    const ctxB = new Set(node.ctx.map((c) => c.bid));
    const out = [];
    for (const c of t) {
      if (c.synthetic) { if (c.rowId === node.id || c.lvl === 99) out.push(c); continue; }
      if (c.bid === node.titleBid || (mj && c.bid === mj.titleBid) || ctxB.has(c.bid)) continue;
      if (it.src === 'pdf') { if (c.rowId !== node.id || c.lvl === 1) continue; }
      else if (mj && c.rowPos < mj.pos) continue;
      if ((unit && sameText(c.text, unit.title)) || (mj && sameText(c.text, mj.title)) || sameText(c.text, node.title) || node.ctx.some((x) => sameText(c.text, x.text))) continue;
      out.push(c);
    }
    return out;
  }
  function pathOf(it) {
    const node = rowTree.get(Annot.itemRow(it));
    if (!node) return null;
    return {
      unit: Annot.units().find((u) => u.id === node.unit) || null,
      major: node.isMajor ? node : (node.major ? rowTree.get(node.major) : null),
      row: node.isMajor ? null : node,
      node,
      ctx: node.ctx,
      trail: itemTrail(it, node),
    };
  }
  function trailText(p, it) {
    if (!p) return '';
    const t = p.trail.map((c) => c.text);
    if (it.src === 'md' && t.length) return '노트: ' + t.join(' › ');
    if (it.src === 'supp') return ['보완 현출', ...t].join(' › ');
    return t.join(' › ');
  }
  function pathParts(p, it, opts) {
    if (!p) return [];
    const f = (c) => (opts && opts.full ? c.full || c.text : c.text);
    const out = [];
    if (p.unit) out.push(`${p.unit.num} ${p.unit.title}`);
    if (p.major) out.push(p.major.title);
    p.ctx.forEach((c) => out.push(f(c)));
    if (p.row) out.push(p.row.title);
    const tt = trailText(p, it);
    if (tt) out.push(tt);
    return out;
  }
  const pathText = (it) => pathParts(pathOf(it), it).join(' › ');

  // ---------- 거르기·묶기 ----------
  function filtered() {
    const colors = new Set($$('.f-color:checked').map((x) => x.value));
    const src = $('#f-src').value;
    const unit = $('#f-unit').value;
    const memoOnly = $('#f-memo').checked;
    return Store.all(['hl', 'row']).filter((it) => {
      if (memoOnly && !(it.memo || '').trim()) return false;
      if (it.kind === 'hl') {
        if (!colors.has(it.color)) return false;
        if (src !== 'all' && it.src !== src) return false;
      } else if (src !== 'all') return false;
      if (unit !== 'all') {
        const n = rowTree.get(Annot.itemRow(it));
        if (!n || n.unit !== unit) return false;
      }
      return true;
    });
  }
  function sortItems(items) {
    const recent = $('#f-sort').value === 'recent';
    items.sort((a, b) => {
      if (recent) return (b.updatedAt || 0) - (a.updatedAt || 0);
      const pa = Annot.itemPos(a), pb = Annot.itemPos(b);
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    });
    return recent;
  }
  // [{key, unit, title, items, majors:[{key, major, items, rows:[{row, node, items}]}]}]
  function grouped(items) {
    const units = [];
    const uMap = new Map();
    const head = [], lost = [];
    for (const it of items) {
      const node = rowTree.get(Annot.itemRow(it));
      if (!node || Annot.isOrphan(it.id)) {
        if (it.segs && headBids.has(it.segs[0].b) && !Annot.isOrphan(it.id)) head.push(it); else lost.push(it);
        continue;
      }
      let ug = uMap.get(node.unit);
      if (!ug) {
        const um = Annot.units().find((u) => u.id === node.unit);
        ug = { key: 'u:' + node.unit, unitId: node.unit, num: um ? um.num : '', title: um ? um.title : node.unit, n: 0, majors: [], mMap: new Map() };
        uMap.set(node.unit, ug); units.push(ug);
      }
      ug.n++;
      const mk = node.major || '';
      let mg = ug.mMap.get(mk);
      if (!mg) { mg = { key: mk ? 'm:' + mk : 'm0:' + node.unit, major: mk ? rowTree.get(mk) : null, n: 0, rows: [], rMap: new Map() }; ug.mMap.set(mk, mg); ug.majors.push(mg); }
      mg.n++;
      let rg = mg.rMap.get(node.id);
      if (!rg) { rg = { node, items: [] }; mg.rMap.set(node.id, rg); mg.rows.push(rg); }
      rg.items.push(it);
    }
    const flat = (key, title, list) => ({ key, unitId: key.slice(2), num: '', title, n: list.length, majors: [{ key: 'm0:' + key, major: null, n: list.length, rows: [{ node: null, items: list }] }] });
    if (head.length) units.unshift(flat('u:__head', '머리말', head));
    if (lost.length) units.push(flat('u:__lost', '위치를 잃은 하이라이트', lost));
    return units;
  }

  // ---------- 그리기 ----------
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function card(it, recent) {
    const wrap = el('div', 'sp-card');
    if (it.kind === 'hl') {
      wrap.dataset.hid = it.id;
      wrap.dataset.color = it.color;
      if (Annot.isRevealed(it.id)) wrap.classList.add('revealed');
    }
    const b = el('button', 'sp-item');
    b.type = 'button';
    const meta = el('span', 'sp-meta');
    const p = pathOf(it);
    if (it.kind === 'row') meta.appendChild(el('span', 'src md', '행 메모'));
    else meta.appendChild(el('span', 'src ' + it.src, Annot.SRC_KO[it.src] || ''));
    const tt = recent ? pathParts(p, it).join(' › ') : trailText(p, it);
    if (tt) meta.appendChild(el('span', 'sp-trail', tt));
    b.appendChild(meta);
    if (it.kind === 'row') b.appendChild(el('span', 'sp-memo', it.memo || '(비어 있음)'));
    else { const t = el('span', 'txt', it.text); t.dataset.color = it.color; b.appendChild(t); }
    b.title = pathParts(p, it, { full: true }).join(' › ');
    b.addEventListener('click', () => goTo(it));
    wrap.appendChild(b);
    if (it.kind === 'hl' && Annot.isBlanked(it.color)) {
      const rv = el('button', 'sp-reveal', Annot.isRevealed(it.id) ? '가리기' : '보기');
      rv.type = 'button';
      rv.addEventListener('click', () => { const on = Annot.toggleReveal(it.id); rv.textContent = on ? '가리기' : '보기'; });
      wrap.appendChild(rv);
    }
    if (it.kind === 'hl' && (it.memo || '').trim()) {
      const tg = el('button', 'sp-memo-toggle');
      tg.type = 'button';
      const memo = el('div', 'sp-memo', it.memo);
      memo.hidden = !!it.collapsed;
      tg.textContent = memo.hidden ? '▸ 메모 보기' : '▾ 메모 접기';
      tg.addEventListener('click', () => { memo.hidden = !memo.hidden; tg.textContent = memo.hidden ? '▸ 메모 보기' : '▾ 메모 접기'; });
      wrap.append(tg, memo);
    }
    return wrap;
  }
  function details(cls, key, summaryNodes) {
    const d = el('details', cls);
    d.dataset.key = key;
    d.open = !closed.has(key);
    const s = el('summary');
    summaryNodes.forEach((n) => s.appendChild(n));
    d.appendChild(s);
    d.addEventListener('toggle', () => {
      if (d.open) closed.delete(key); else closed.add(key);
      Store.lsSet(PANEL_KEY, JSON.stringify({ closed: [...closed] }));
    });
    return d;
  }
  function rowTitleEl(node) {
    const t = el('div', 'sp-row-title');
    t.appendChild(el('span', 'sp-anchor', node.anchor));
    node.ctx.forEach((c) => t.appendChild(el('span', 'sp-ctx', c.text)));
    t.appendChild(el('span', 'sp-row-name', node.title));
    return t;
  }
  function render(opts) {
    if (!panelEl || panelEl.hidden) return;
    const keep = opts && opts.restore ? ret.scrollTop : listEl.scrollTop;
    const focusHid = opts && opts.restore ? ret.hid : (document.activeElement && document.activeElement.closest && document.activeElement.closest('.sp-card')?.dataset.hid);
    const items = filtered();
    const recent = sortItems(items);
    panelEl.classList.toggle('sp-recent', recent);
    $('#hl-total').textContent = `${items.length}개`;
    listEl.innerHTML = '';
    if (!items.length) {
      listEl.appendChild(el('p', 'sp-empty', '조건에 맞는 하이라이트가 없습니다. 본문에서 글자를 선택하거나 아래 도구로 칠할 수 있습니다.'));
    } else if (recent) {
      const box = el('div', 'sp-flat');
      items.forEach((it) => box.appendChild(card(it, true)));
      listEl.appendChild(box);
    } else {
      for (const ug of grouped(items)) {
        const d = details('sp-unit', ug.key, [el('span', 'sp-num', ug.num), el('span', 'sp-ttl', (ug.num ? ' ' : '') + ug.title), el('span', 'n', String(ug.n))]);
        const majors = el('div', 'sp-majors');
        for (const mg of ug.majors) {
          let box;
          if (mg.major) {
            box = details('sp-major', mg.key, [el('span', 'sp-ttl', mg.major.title), el('span', 'sp-anchor', mg.major.anchor), el('span', 'n', String(mg.n))]);
            box.dataset.row = mg.major.id;
          } else { box = el('div', 'sp-major sp-major-none'); box.dataset.key = mg.key; }
          for (const rg of mg.rows) {
            const r = el('div', 'sp-row');
            if (rg.node) {
              r.dataset.row = rg.node.id;
              if (mg.major && rg.node.id === mg.major.id) r.classList.add('self');
              else r.appendChild(rowTitleEl(rg.node));
            }
            rg.items.forEach((it) => r.appendChild(card(it, false)));
            box.appendChild(r);
          }
          majors.appendChild(box);
        }
        d.appendChild(majors);
        listEl.appendChild(d);
      }
    }
    renderNav(items);
    listEl.scrollTop = keep;
    if (focusHid) {
      const f = listEl.querySelector(`.sp-card[data-hid="${CSS.escape(focusHid)}"] .sp-item`);
      if (f) f.focus({ preventScroll: !(opts && opts.restore) });
    }
  }
  // 전체 화면 왼쪽: 모든 단원·대쟁점 목차 (지금 조건에 해당 없는 대쟁점은 흐리게)
  function renderNav(items) {
    const nav = $('#hl-nav');
    nav.innerHTML = '';
    const count = new Map();
    for (const it of items) {
      const node = rowTree.get(Annot.itemRow(it));
      if (!node) continue;
      count.set('u:' + node.unit, (count.get('u:' + node.unit) || 0) + 1);
      if (node.major) count.set('m:' + node.major, (count.get('m:' + node.major) || 0) + 1);
    }
    const ol = el('ol');
    for (const u of Annot.units()) {
      const li = el('li', 'nv-unit');
      li.dataset.unit = u.id;
      const ub = el('button');
      ub.type = 'button';
      ub.dataset.jump = 'u:' + u.id;
      ub.append(el('span', 'sp-num', u.num), el('span', 'nv-t', u.title), el('span', 'n', count.get('u:' + u.id) ? String(count.get('u:' + u.id)) : ''));
      if (!count.get('u:' + u.id)) li.classList.add('empty');
      li.appendChild(ub);
      const sub = el('ol');
      for (const n of rowTree.values()) {
        if (n.unit !== u.id || !n.isMajor) continue;
        const c = count.get('m:' + n.id) || 0;
        const mli = el('li', 'nv-major' + (c ? '' : ' empty'));
        mli.dataset.row = n.id;
        const mb = el('button');
        mb.type = 'button';
        mb.dataset.jump = 'm:' + n.id;
        mb.disabled = !c;
        mb.append(el('span', 'nv-t', n.title), el('span', 'n', c ? String(c) : ''));
        mli.appendChild(mb);
        sub.appendChild(mli);
      }
      if (sub.childElementCount) li.appendChild(sub);
      ol.appendChild(li);
    }
    nav.appendChild(ol);
  }

  // ---------- 이동 ----------
  function goTo(it) {
    let target;
    if (it.kind === 'row') {
      if (document.body.classList.contains('mode-solo')) App.setMode('parallel');
      target = document.getElementById(it.rowId);
    } else {
      target = document.querySelector(`mark.uhl[data-hid="${CSS.escape(it.id)}"]`);
      if (!target) { toast('본문에서 이 하이라이트의 위치를 찾지 못했습니다.'); return; }
      if (document.body.classList.contains('mode-solo') && !target.closest('#solo-inner')) {
        App.setMode('parallel');
        target = document.querySelector(`mark.uhl[data-hid="${CSS.escape(it.id)}"]`);
      }
      if (target.closest('.supp') && document.body.classList.contains('hide-supp')) App.setSupp(true);
      if (document.body.classList.contains('focus-hc') && !target.closest('.callout-ex')) App.setFocus(false);
      let d = target.parentElement;
      while (d) { if (d.tagName === 'DETAILS') d.open = true; d = d.parentElement; }
      const row = target.closest('.row');
      const cell = target.closest('.cell');
      if (row && cell) App.setRowTab(row, cell.dataset.src);
    }
    if (!target) return;
    if (full || isNarrow()) {
      ret.scrollTop = listEl.scrollTop;
      ret.hid = it.id;
      ret.full = full;
      close();
      $('#hl-return').hidden = false;
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const flashEl = it.kind === 'row' ? target : (target.closest('[data-bid]') || target);
    flashEl.classList.remove('flash'); void flashEl.offsetWidth; flashEl.classList.add('flash');
  }
  function returnToPanel() {
    $('#hl-return').hidden = true;
    open({ full: ret.full, restore: true });
  }

  // ---------- 열기·닫기·전체 화면 ----------
  function open(opts) {
    panelEl.hidden = false;
    $('#btn-hl-panel').setAttribute('aria-pressed', 'true');
    $('#hl-return').hidden = true;
    setFull(opts && opts.full !== undefined ? opts.full : full, { silent: true });
    render(opts && opts.restore ? { restore: true } : null);
  }
  function close() {
    panelEl.hidden = true;
    $('#btn-hl-panel').setAttribute('aria-pressed', 'false');
    applyFull(false);
  }
  const isOpen = () => !!(panelEl && !panelEl.hidden);
  function toggle() { if (isOpen()) close(); else open(); }
  function applyFull(on) {
    const f = on && !isNarrow() && isOpen();
    panelEl.classList.toggle('full', f);
    document.documentElement.classList.toggle('hl-full', f);
    $('.layout').inert = f;
    const fb = $('#hl-panel-full');
    fb.setAttribute('aria-pressed', String(f));
    fb.querySelector('.lbl').textContent = f ? '창으로' : '전체 화면';
    fb.title = f ? '오른쪽 창으로 줄이기 (Esc)' : '전체 화면으로 펼치기';
  }
  function setFull(on, opts) {
    full = !!on;
    applyFull(full);
    if (!(opts && opts.silent)) render();
  }
  const isFull = () => full && isOpen() && panelEl.classList.contains('full');

  function toMarkdown() {
    const items = filtered();
    const recent = sortItems(items);
    const lines = ['# 하이라이트 모음 — 기본권 병렬노트', '', `내보낸 시각: ${new Date().toLocaleString('ko-KR')}`, ''];
    const itemLines = (it, withPath) => {
      if (it.kind === 'row') lines.push(`- [행 메모] ${(it.memo || '').replace(/\n/g, '\n  ')}`);
      else {
        lines.push(`- [${Annot.SRC_KO[it.src] || ''}·${Annot.COLOR_KO[it.color] || ''}] “${it.text}”`);
        const p = pathOf(it);
        const loc = withPath ? pathParts(p, it).join(' › ') : trailText(p, it);
        if (loc) lines.push(`  - 위치: ${loc}`);
        if ((it.memo || '').trim()) lines.push(`  - 메모: ${it.memo.trim().replace(/\n/g, '\n    ')}`);
      }
    };
    if (recent) {
      lines.push('## 최근 순', '');
      items.forEach((it) => itemLines(it, true));
      return lines.join('\n') + '\n';
    }
    for (const ug of grouped(items)) {
      lines.push(`## ${ug.num ? ug.num + ' ' : ''}${ug.title}`, '');
      for (const mg of ug.majors) {
        if (mg.major) lines.push(`### ${mg.major.title}`, '');
        for (const rg of mg.rows) {
          if (rg.node && !(mg.major && rg.node.id === mg.major.id)) {
            lines.push(`${mg.major ? '####' : '###'} ${[...rg.node.ctx.map((c) => c.text), rg.node.title].join(' › ')}`, '');
          }
          rg.items.forEach((it) => itemLines(it, false));
          lines.push('');
        }
      }
    }
    return lines.join('\n');
  }

  const refresh = rafOnce(() => { if (isOpen()) render(); });

  function init() {
    panelEl = $('#hl-panel');
    listEl = $('#hl-list');
    try { closed = new Set((JSON.parse(Store.lsGet(PANEL_KEY) || '{}') || {}).closed || []); } catch (e) { closed = new Set(); }
    buildHierarchy();
    const fu = $('#f-unit');
    Annot.units().forEach((u) => { const o = document.createElement('option'); o.value = u.id; o.textContent = `${u.num} ${u.title}`; fu.appendChild(o); });
    ['f-src', 'f-unit', 'f-memo', 'f-sort'].forEach((id) => $('#' + id).addEventListener('change', () => render()));
    $$('.f-color').forEach((c) => c.addEventListener('change', () => render()));
    $('#hl-panel-full').addEventListener('click', () => { setFull(!isFull()); App.savePref('hlFull', full); });
    $('#hl-panel-close').addEventListener('click', close);
    $('#hl-return').addEventListener('click', returnToPanel);
    $('#hl-nav').addEventListener('click', (e) => {
      const b = e.target.closest('[data-jump]');
      if (!b) return;
      const g = listEl.querySelector(`[data-key="${CSS.escape(b.dataset.jump)}"]`);
      if (!g) return;
      let d = g;
      while (d && d !== listEl) { if (d.tagName === 'DETAILS') d.open = true; d = d.parentElement; }
      listEl.scrollTop += g.getBoundingClientRect().top - listEl.getBoundingClientRect().top - (b.dataset.jump.startsWith('m:') ? 40 : 0);
    });
    // 목록 안에서 위·아래 화살표로 항목 이동
    listEl.addEventListener('keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      const all = $$('.sp-item', listEl).filter((x) => x.offsetParent);
      if (!all.length) return;
      const i = all.indexOf(document.activeElement);
      let j = i;
      if (e.key === 'ArrowDown') j = Math.min(all.length - 1, i + 1);
      if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
      if (e.key === 'Home') j = 0;
      if (e.key === 'End') j = all.length - 1;
      e.preventDefault();
      all[j].focus();
      all[j].scrollIntoView({ block: 'nearest' });
    });
    narrowMq.addEventListener('change', () => applyFull(full));
  }

  return { init, render, refresh, open, close, toggle, isOpen, setFull, isFull, toMarkdown, goTo, pathText, pathOf, buildHierarchy, rowTree };
})();

// ---- editor.js ----
// 편집 모드 — 요약본·노트 문단을 직접 고친다. 원본(빌드 결과)은 그대로 두고 편집본을 덧씌운다.
// 편집본은 블록마다 Store 항목 하나({id:'e:<블록id>', kind:'edit', html})라 GitHub로 동기화되고, 되돌리기에 들어간다.
const Editor = (() => {
  const original = new Map();   // 블록 id → 원래 innerHTML
  // 글자 색: 편집 중에는 <font color>(execCommand), 저장할 때 테마를 따르는 클래스로 바꾼다
  const PALETTE = [
    ['ink', '#202124', '기본 색'], ['red', '#c62828', '빨강'], ['blue', '#1f4fbf', '파랑'],
    ['green', '#2e7d32', '초록'], ['orange', '#d9730d', '주황'], ['purple', '#7b3fa0', '보라'],
  ];
  const HEX2CLS = new Map(PALETTE.map(([k, hex]) => [hex, 'ec-' + k]));
  const CLS2HEX = new Map(PALETTE.map(([k, hex]) => ['ec-' + k, hex]));
  const DROP = 'script, style, iframe, object, embed, link, meta, form, input, button, textarea, select, img, video, audio, svg, math, template, base, frame, frameset';
  const STYLE_OK = ['color', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line'];
  let active = false, showOrig = false;
  let cur = null, curBefore = null;
  let bar;

  const topBlocks = () => $$('[data-bid]').filter((b) => !b.parentElement.closest('[data-bid]'));

  // ---------- 정리(sanitize) ----------
  function cleanStyle(v) {
    const out = [];
    for (const decl of String(v || '').split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim().toLowerCase();
      const val = decl.slice(i + 1).trim();
      if (STYLE_OK.includes(prop) && /^[#a-z0-9(),.%\s-]+$/i.test(val) && !/url|expression/i.test(val)) out.push(`${prop}: ${val}`);
    }
    return out.join('; ');
  }
  function clean(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    const root = tpl.content;
    root.querySelectorAll(DROP).forEach((n) => n.remove());
    root.querySelectorAll('mark.uhl').forEach((m) => m.replaceWith(...m.childNodes));
    root.querySelectorAll('font').forEach((f) => {
      const span = document.createElement('span');
      const c = (f.getAttribute('color') || '').trim().toLowerCase();
      if (HEX2CLS.has(c)) span.className = HEX2CLS.get(c);
      else if (/^#[0-9a-f]{3,8}$|^rgb/.test(c)) span.setAttribute('style', `color: ${c}`);
      while (f.firstChild) span.appendChild(f.firstChild);
      f.replaceWith(span);
    });
    root.querySelectorAll('*').forEach((el) => {
      for (const a of [...el.attributes]) {
        const n = a.name.toLowerCase();
        if (n.startsWith('on') || n === 'contenteditable' || n === 'spellcheck' || n === 'srcdoc' || n === 'formaction' || n === 'action' || n === 'xlink:href') el.removeAttribute(a.name);
        else if (n === 'href' && !/^\s*(#|https?:)/i.test(a.value)) el.removeAttribute(a.name);
        else if (n === 'src') el.removeAttribute(a.name);
        else if (n === 'style') { const s = cleanStyle(a.value); if (s) el.setAttribute('style', s); else el.removeAttribute('style'); }
      }
    });
    root.querySelectorAll('span:not([class]):not([style]):not([data-generated])').forEach((s) => { if (!s.attributes.length) s.replaceWith(...s.childNodes); });
    const div = document.createElement('div');
    div.appendChild(root);
    return div.innerHTML;
  }
  // 편집을 시작할 때: 색 클래스를 execCommand가 다루는 <font color>로
  function toFont(block) {
    block.querySelectorAll('span[class^="ec-"], span[class*=" ec-"]').forEach((s) => {
      const cls = [...s.classList].find((c) => CLS2HEX.has(c));
      if (!cls || s.classList.length > 1 || s.attributes.length > 1) return;
      const f = document.createElement('font');
      f.setAttribute('color', CLS2HEX.get(cls));
      while (s.firstChild) f.appendChild(s.firstChild);
      s.replaceWith(f);
    });
  }

  // ---------- 그리기 ----------
  function applyBlock(bid, opts) {
    const block = Annot.findBlock(bid);
    if (!block || block === cur || !original.has(bid)) return;
    const it = Store.get('e:' + bid);
    const html = !showOrig && it ? clean(it.html) : original.get(bid);
    const ids = Annot.clearBlock(block);
    if (block.innerHTML !== html) block.innerHTML = html;
    block.classList.toggle('edited', !!it);
    block.title = it && !showOrig ? `직접 고친 문단 · ${fmtTime(it.updatedAt)}` : (it ? '고친 문단 (지금은 원본 표시)' : '');
    if (!block.title) block.removeAttribute('title');
    if (!(opts && opts.noRepaint)) { Annot.repaintBlock(bid, ids); MemoLane.schedule(); App.scheduleSticky(); }
  }
  function onStore(ev) {
    let n = 0;
    for (const id of ev.ids || []) {
      if (!id.startsWith('e:')) continue;
      n++;
      applyBlock(id.slice(2));
    }
    if (n) refreshCount();
  }
  function refreshCount() {
    const n = Store.all('edit').length;
    const b = $('#btn-edits-revert');
    if (b) { b.textContent = `편집 모두 되돌리기 (${n})`; b.disabled = n === 0; }
    const o = $('#opt-orig');
    if (o) o.disabled = n === 0 && !showOrig;
  }

  // ---------- 편집 시작·끝 ----------
  function start(block) {
    finish();
    if (showOrig) setShowOriginal(false);
    cur = block;
    const bid = block.dataset.bid;
    curBefore = History.snap('e:' + bid);
    Annot.clearBlock(block);
    toFont(block);
    block.querySelectorAll('[data-generated]').forEach((g) => g.setAttribute('contenteditable', 'false'));
    block.setAttribute('contenteditable', 'true');
    block.setAttribute('spellcheck', 'false');
    block.classList.add('editing');
    document.body.classList.add('editing-block');
    MemoLane.schedule();
    updateBar();
  }
  function finish() {
    if (!cur) return;
    const block = cur;
    cur = null;
    const bid = block.dataset.bid;
    block.removeAttribute('contenteditable');
    block.removeAttribute('spellcheck');
    block.classList.remove('editing');
    block.querySelectorAll('[contenteditable]').forEach((x) => x.removeAttribute('contenteditable'));
    document.body.classList.remove('editing-block');
    if (document.activeElement === block) block.blur();
    const html = clean(block.innerHTML);
    const id = 'e:' + bid;
    const prev = Store.get(id);
    const same = html === clean(original.get(bid));
    let changed = false;
    if (same) { if (prev) { History.remove(id, '편집 되돌리기'); changed = true; } }
    else if (!prev || prev.html !== html) {
      History.put({ id, kind: 'edit', bid, html, src: block.dataset.sb, rowId: Annot.bidRow.get(bid) || null, text: Annot.blockText(block).trim().slice(0, 60) }, '문단 편집');
      changed = true;
    }
    if (!changed) applyBlock(bid);
    curBefore = null;
    updateBar();
  }
  function revertCurrent() {
    if (!cur) return;
    const bid = cur.dataset.bid;
    cur.innerHTML = original.get(bid);
    finish();
    toast('이 문단을 원래 글로 되돌렸습니다. (되돌리기로 다시 살릴 수 있습니다)');
  }
  const isEditingBlock = (block) => !!cur && block === cur;
  const isEditing = () => !!cur;

  function setActive(on) {
    if (on === active) return;
    active = on;
    document.body.classList.toggle('edit-mode', on);
    if (!on) finish();
    else {
      try { window.getSelection().removeAllRanges(); } catch (e) { /* noop */ }
      Annot.hideToolbar(); Annot.hidePop();
      toast('편집 모드 — 고칠 문단을 누르세요. 끝나면 ‘완료’ 또는 Esc.');
    }
    bar.hidden = !on;
    updateBar();
  }
  function setShowOriginal(on) {
    finish();
    showOrig = !!on;
    document.body.classList.toggle('show-orig', showOrig);
    for (const it of Store.all('edit')) applyBlock(it.bid);
    const o = $('#opt-orig');
    if (o) o.checked = showOrig;
    refreshCount();
  }
  async function revertAll() {
    const all = Store.all('edit');
    if (!all.length) { toast('고친 문단이 없습니다.'); return; }
    if (!(await confirmDlg('편집 모두 되돌리기', `고친 문단 ${all.length}개를 모두 원래 글로 되돌립니다. (되돌리기로 다시 살릴 수 있습니다)`))) return;
    finish();
    History.group('편집 모두 되돌리기', () => all.forEach((it) => History.remove(it.id)));
    toast('편집을 모두 되돌렸습니다.');
  }

  function updateBar() {
    if (!bar) return;
    const on = !!cur;
    $$('[data-cmd], [data-color], [data-act]', bar).forEach((b) => { b.disabled = !on; });
    const st = $('.eb-status', bar);
    if (on) {
      const src = cur.dataset.sb === 'pdf' ? '요약본' : cur.dataset.sb === 'supp' ? '보완 현출' : '강의노트';
      st.textContent = `${src} 문단 편집 중`;
    } else st.textContent = '고칠 문단을 누르세요';
  }

  function onPointerDown(e) {
    if (!active) return;
    if (e.target.closest('#edit-bar, #pen-dock, .dock-pop, dialog, .topbar, #toc, #hl-panel, #memo-sheet, .memo-lane, .row-bar, .hl-pop, .hl-toolbar, #resume-chip, #hl-return')) return;
    const block = Annot.topBlock(e.target);
    if (!block || !block.closest('#units, #solo-inner, #doc-head')) { finish(); return; }
    if (block === cur) return;
    start(block);
    // 커서는 브라우저가 누른 자리에 놓는다. 혹시 못 놓으면 직접 놓는다.
    const x = e.clientX, y = e.clientY;
    setTimeout(() => {
      if (cur !== block || document.activeElement === block) return;
      block.focus({ preventScroll: true });
      const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
      if (r && block.contains(r.startContainer)) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
    }, 0);
  }
  function bindBar() {
    bar = $('#edit-bar');
    const sw = $('.eb-colors', bar);
    for (const [k, hex, ko] of PALETTE) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ec-sw ec-sw-' + k;
      b.dataset.color = hex;
      b.title = `글자 색: ${ko}`;
      b.setAttribute('aria-label', b.title);
      sw.appendChild(b);
    }
    bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !cur) return;
      if (b.dataset.cmd) { document.execCommand(b.dataset.cmd, false, null); return; }
      if (b.dataset.color) {
        try { document.execCommand('styleWithCSS', false, false); } catch (err) { /* noop */ }
        document.execCommand('foreColor', false, b.dataset.color);
        return;
      }
      if (b.dataset.act === 'revert') revertCurrent();
      if (b.dataset.act === 'done') finish();
    });
  }

  function init() {
    for (const b of topBlocks()) original.set(b.dataset.bid, b.innerHTML);
    for (const it of Store.all('edit')) applyBlock(it.bid, { noRepaint: true });
    bindBar();
    Store.on(onStore);
    document.addEventListener('pointerdown', onPointerDown, true);
    // 붙여넣기는 글자만
    document.addEventListener('paste', (e) => {
      if (!cur || !cur.contains(e.target)) return;
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    });
    document.addEventListener('keydown', (e) => {
      if (!cur || !cur.contains(e.target)) return;
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); e.stopPropagation(); finish(); }
    }, true);
    refreshCount();
  }

  return { init, setActive, isActive: () => active, finish, isEditing, isEditingBlock, setShowOriginal, isShowingOriginal: () => showOrig, revertAll, clean, original };
})();

// ---- progress.js ----
// 진도 — 행마다 '다 봤음'(Store 항목 p:<행id>, 동기화·되돌리기 가능)과 마지막 위치(기기별 pos:<기기id>, 지연 저장).
const Progress = (() => {
  let rows = [], units = [];
  let lastKey = '', saveTimer = null;
  let chipPos = null, chipDismissed = false, bootAt = 0, chipTimer = null;

  const isDone = (rowId) => { const it = Store.get('p:' + rowId); return !!(it && it.done); };
  function setDone(rowId, done, label) {
    if (isDone(rowId) === !!done) return;
    History.put({ id: 'p:' + rowId, kind: 'prog', rowId, done: !!done }, label || (done ? '다 봤음' : '다 봤음 해제'));
  }
  function setUnit(unitId, done) {
    const rs = rows.filter((r) => r.unit === unitId);
    History.group(done ? '단원 전체 다 봤음' : '단원 다 봤음 해제', () => rs.forEach((r) => setDone(r.id, done)));
  }
  function stats() {
    let done = 0;
    const per = new Map(units.map((u) => [u.id, { n: 0, d: 0, firstOpen: null }]));
    for (const r of rows) {
      const u = per.get(r.unit) || { n: 0, d: 0, firstOpen: null };
      u.n++;
      if (isDone(r.id)) { u.d++; done++; } else if (!u.firstOpen) u.firstOpen = r.id;
      per.set(r.unit, u);
    }
    return { done, total: rows.length, pct: rows.length ? Math.round((done / rows.length) * 100) : 0, per };
  }

  // ---------- 화면 장식 ----------
  function decorate() {
    $$('#units .row').forEach((row) => {
      const bar = row.querySelector('.row-bar');
      if (!bar || bar.querySelector('.row-done')) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'row-done';
      b.dataset.row = row.dataset.row;
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = '<span class="ck" aria-hidden="true"></span><span class="lbl">다 봤음</span>';
      bar.appendChild(b);
    });
    $$('#toc .toc-row').forEach((li) => {
      if (li.querySelector('.toc-check')) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toc-check';
      b.dataset.row = li.dataset.row;
      li.appendChild(b);
    });
    $$('#toc .toc-unit').forEach((u) => {
      const head = u.querySelector('.toc-unit-head');
      if (!head || head.querySelector('.toc-prog')) return;
      const p = document.createElement('span');
      p.className = 'toc-prog';
      p.dataset.unit = u.dataset.unit;
      p.innerHTML = '<span class="pbar" aria-hidden="true"><i></i></span><span class="n"></span>';
      const cb = head.querySelector('.toc-done');
      head.insertBefore(p, cb || null);
      if (cb) cb.title = '단원 전체 다 봤음 (누르면 단원의 모든 행을 바꿈)';
    });
  }
  function refresh() {
    const s = stats();
    $$('.row-done').forEach((b) => {
      const d = isDone(b.dataset.row);
      b.setAttribute('aria-pressed', String(d));
      b.title = d ? '다 봤음 — 누르면 해제' : '이 행을 다 봤으면 누르세요';
      const row = b.closest('.row');
      if (row) row.classList.toggle('done', d);
    });
    $$('.toc-check').forEach((b) => {
      const d = isDone(b.dataset.row);
      b.setAttribute('aria-pressed', String(d));
      b.setAttribute('aria-label', d ? '다 봤음 해제' : '다 봤음으로 표시');
      b.title = b.getAttribute('aria-label');
      b.closest('.toc-row').classList.toggle('done', d);
    });
    $$('.toc-prog').forEach((p) => {
      const u = s.per.get(p.dataset.unit) || { n: 0, d: 0 };
      p.querySelector('i').style.width = (u.n ? (u.d / u.n) * 100 : 0) + '%';
      p.querySelector('.n').textContent = `${u.d}/${u.n}`;
      p.title = `이 단원 ${u.n}행 중 ${u.d}행 다 봄`;
    });
    $$('.toc-done').forEach((cb) => {
      const u = s.per.get(cb.dataset.unit) || { n: 0, d: 0 };
      cb.checked = u.n > 0 && u.d === u.n;
      cb.indeterminate = u.d > 0 && u.d < u.n;
    });
    const btn = $('#prog-btn');
    if (btn) {
      $('#prog-pct').textContent = s.pct + '%';
      btn.style.setProperty('--p', s.pct + '%');
      btn.title = `진도 ${s.done}/${s.total}행 (${s.pct}%)`;
    }
    if (!$('#prog-pop').hidden) renderPop();
  }

  // ---------- 진도 창 (상단 바) ----------
  function renderPop() {
    const s = stats();
    const pop = $('#prog-pop');
    $('.pp-sum', pop).textContent = `${s.total}행 중 ${s.done}행 다 봄 · ${s.pct}%`;
    $('.pp-bar i', pop).style.width = s.pct + '%';
    const list = $('.pp-units', pop);
    list.innerHTML = '';
    for (const u of units) {
      const st = s.per.get(u.id) || { n: 0, d: 0 };
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pp-unit' + (st.n && st.d === st.n ? ' all' : '');
      b.dataset.unit = u.id;
      b.dataset.target = st.firstOpen || u.id;
      b.title = st.firstOpen ? '아직 안 본 첫 행으로' : '단원 처음으로';
      const num = document.createElement('span'); num.className = 'pp-num'; num.textContent = u.num;
      const t = document.createElement('span'); t.className = 'pp-t'; t.textContent = u.title;
      const bar = document.createElement('span'); bar.className = 'pbar'; bar.innerHTML = '<i></i>'; bar.firstChild.style.width = (st.n ? (st.d / st.n) * 100 : 0) + '%';
      const n = document.createElement('span'); n.className = 'pp-n'; n.textContent = `${st.d}/${st.n}`;
      b.append(num, t, bar, n);
      list.appendChild(b);
    }
    const pos = latestPos();
    const rb = $('#pp-resume', pop);
    rb.hidden = !pos;
    if (pos) rb.textContent = `↪ 이어서 보기 · ${posLabel(pos)}`;
  }
  function togglePop(force) {
    const pop = $('#prog-pop');
    const open = force === undefined ? pop.hidden : force;
    pop.hidden = !open;
    $('#prog-btn').setAttribute('aria-expanded', String(open));
    if (open) renderPop();
  }

  // ---------- 마지막 위치 ----------
  function firstBelow(list, y) {
    let lo = 0, hi = list.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].getBoundingClientRect().bottom > y) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return ans < 0 ? null : list[ans];
  }
  function spot() {
    const tb = $('#topbar');
    const y = (tb ? tb.getBoundingClientRect().bottom : 52) + 48;
    if (document.body.classList.contains('mode-solo')) {
      const el = firstBelow($$('#solo-inner > [data-bid]'), y);
      if (!el) return null;
      return { bid: el.dataset.bid, rowId: Annot.bidRow.get(el.dataset.bid) || null, mode: App.mode() };
    }
    const row = firstBelow($$('#units .row'), y);
    if (!row) return null;
    const visible = (c) => c && c.offsetParent;
    let cell = row.querySelector(row.dataset.tab === 'pdf' ? '.cell-pdf' : '.cell-md');
    if (!visible(cell) || row.dataset.hasMd !== '1') cell = row.querySelector('.cell-pdf');
    const blk = cell ? firstBelow([...cell.querySelectorAll(':scope > [data-bid]')], y) : null;
    return { rowId: row.dataset.row, bid: blk ? blk.dataset.bid : null, mode: 'parallel' };
  }
  function savePos() {
    const s = spot();
    if (!s || !s.rowId) return;
    const key = `${s.rowId}|${s.bid}|${s.mode}`;
    if (key === lastKey) return;
    lastKey = key;
    const d = Store.device();
    Store.put({ id: 'pos:' + d.id, kind: 'pos', device: d.name || '', rowId: s.rowId, bid: s.bid, mode: s.mode, at: Date.now() }, { silent: true });
  }
  function latestPos() {
    return Store.all('pos').filter((p) => p.rowId && rows.some((r) => r.id === p.rowId)).sort((a, b) => (b.at || 0) - (a.at || 0))[0] || null;
  }
  function posLabel(p) {
    const r = rows.find((x) => x.id === p.rowId);
    const node = Panel.rowTree.get(p.rowId);
    const mine = p.id === 'pos:' + Store.device().id;
    const who = mine ? '이 기기' : (p.device || '다른 기기');
    return `${node ? node.anchor + ' ' : ''}${r ? r.title : p.rowId} (${who} · ${fmtTime(p.at)})`;
  }
  function goToPos(p) {
    if (!p) return;
    hideChip();
    let el = p.bid ? document.querySelector(`[data-bid="${CSS.escape(p.bid)}"]`) : null;
    if (el && document.body.classList.contains('mode-solo') && !el.closest('#solo-inner')) el = null;
    if (!el) {
      if (document.body.classList.contains('mode-solo')) App.setMode('parallel');
      el = (p.bid && document.querySelector(`[data-bid="${CSS.escape(p.bid)}"]`)) || document.getElementById(p.rowId);
    }
    if (!el) return;
    const row = el.closest('.row');
    const cell = el.closest('.cell');
    if (row && cell) App.setRowTab(row, cell.dataset.src);
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }
  function showChip(p) {
    if (!p || chipDismissed) return;
    const s = spot();
    if (s && s.rowId === p.rowId) return;
    chipPos = p;
    $('#resume-text').textContent = `이어서 보기 · ${posLabel(p)}`;
    $('#resume-chip').hidden = false;
    clearTimeout(chipTimer);
    chipTimer = setTimeout(hideChip, 25000);
  }
  function hideChip() { $('#resume-chip').hidden = true; chipPos = null; clearTimeout(chipTimer); }

  function onStore(ev) {
    let prog = false, pos = false;
    for (const id of ev.ids || []) {
      if (id.startsWith('p:')) prog = true;
      else if (id.startsWith('pos:')) pos = true;
    }
    if (prog || ev.type === 'merge') refresh();
    // 열고 얼마 안 되어 다른 기기의 더 최근 위치가 들어오면 칩을 갱신
    if (pos && !ev.local && Date.now() - bootAt < 30000) { const p = latestPos(); if (p) showChip(p); }
  }

  function migrate(prefs) {
    const done = prefs && prefs.done;
    if (!done || !Object.values(done).some(Boolean)) return;
    if (!Store.all('prog').length) {
      for (const r of rows) if (done[r.unit]) Store.put({ id: 'p:' + r.id, kind: 'prog', rowId: r.id, done: true });
    }
    App.savePref('done', {});
  }

  function init(content, prefs) {
    rows = content.rows || [];
    units = content.units || [];
    bootAt = Date.now();
    decorate();
    migrate(prefs);
    refresh();
    document.addEventListener('click', (e) => {
      const rd = e.target.closest('.row-done, .toc-check');
      if (rd) { e.preventDefault(); setDone(rd.dataset.row, !isDone(rd.dataset.row)); return; }
      const pu = e.target.closest('.pp-unit');
      if (pu) {
        togglePop(false);
        const t = document.getElementById(pu.dataset.target);
        if (document.body.classList.contains('mode-solo')) App.setMode('parallel');
        if (t) t.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
      if (!$('#prog-pop').hidden && !e.target.closest('#prog-pop, #prog-btn')) togglePop(false);
    });
    $$('.toc-done').forEach((cb) => cb.addEventListener('change', () => { setUnit(cb.dataset.unit, cb.checked); }));
    $('#prog-btn').addEventListener('click', () => togglePop());
    $('#pp-resume').addEventListener('click', () => { togglePop(false); goToPos(latestPos()); });
    $('#pp-reset').addEventListener('click', async () => {
      togglePop(false);
      const all = Store.all('prog').filter((p) => p.done);
      if (!all.length) { toast('다 봤음 표시가 없습니다.'); return; }
      if (!(await confirmDlg('진도 초기화', `다 봤음 표시 ${all.length}개를 모두 지웁니다. (되돌리기로 살릴 수 있습니다)`))) return;
      History.group('진도 초기화', () => all.forEach((p) => History.remove(p.id)));
    });
    $('#resume-go').addEventListener('click', () => goToPos(chipPos));
    $('#resume-close').addEventListener('click', () => { chipDismissed = true; hideChip(); });
    window.addEventListener('scroll', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(savePos, 1200);
      if (chipPos && Date.now() - bootAt > 4000 && window.scrollY > 0) {
        // 사용자가 직접 많이 움직이면 칩을 거둔다
        const s = spot();
        if (s && s.rowId === chipPos.rowId) hideChip();
      }
    }, { passive: true });
    Store.on(onStore);
    // 브라우저가 스크롤 위치를 되살릴 시간을 준 뒤 칩을 띄운다
    setTimeout(() => { if (!location.hash) showChip(latestPos()); }, 600);
  }

  return { init, refresh, isDone, setDone, stats, latestPos, goToPos, spot, togglePop, savePos };
})();

// ---- dock.js ----
// 아래 필기 도구바 — 형광펜·메모 펜을 고르면 드래그하고 손을 떼는 순간 바로 칠해진다 (따로 누를 필요 없음).
// 마우스·펜: 드래그 후 놓으면 칠함 · 손가락: 스크롤은 그대로, 길게 눌러 선택한 뒤 떼면 칠함.
const Dock = (() => {
  const TOOLS = ['select', 'yellow', 'green', 'pink', 'blue', 'memo', 'edit'];
  const PEN = new Set(['yellow', 'green', 'pink', 'blue', 'memo']);
  const TOOL_KO = { select: '선택 도구', yellow: '노랑 형광펜', green: '초록 형광펜', pink: '분홍 형광펜', blue: '파랑 형광펜', memo: '메모 펜', edit: '편집 모드' };
  const KEYS = { 1: 'yellow', 2: 'green', 3: 'pink', 4: 'blue', m: 'memo', M: 'memo', 'ㅡ': 'memo', v: 'select', V: 'select', 'ㅍ': 'select', e: 'edit', E: 'edit', 'ㄷ': 'edit' };
  let tool = 'select';
  let down = null;
  let hinted = false;

  const tool_ = () => tool;
  function setTool(t, opts) {
    if (!TOOLS.includes(t)) t = 'select';
    const prev = tool;
    tool = t;
    document.body.dataset.tool = t;
    $$('#pen-dock .dock-tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
    $('#dock-fab').dataset.tool = t;
    if (t !== 'select') Annot.hideToolbar();
    Editor.setActive(t === 'edit');
    if (t !== 'edit') App.savePref('tool', t);
    if (prev !== t && !(opts && opts.silent)) {
      if (PEN.has(t) && !hinted) { hinted = true; toast(`${TOOL_KO[t]} — 드래그하고 떼면 바로 칠해집니다. 선택 도구로 돌아가기: V 또는 Esc`); }
      else if (opts && opts.announce) toast(TOOL_KO[t]);
    }
  }

  // ---------- 바로 칠하기 ----------
  function startsOutside(el) {
    if (!el || !el.closest) return true;
    if (el.closest('input, textarea, select, button, [contenteditable="true"], .memo-lane, .memo-card, #hl-panel, dialog, #toc, .topbar, #pen-dock, .dock-pop, #edit-bar, #memo-sheet, .hl-toolbar, .hl-pop, .row-bar, #resume-chip, #hl-return')) return true;
    return !el.closest('#units, #solo-inner, #doc-head');
  }
  function applySelection() {
    if (!PEN.has(tool)) return null;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!Annot.selectionInContent(range)) return null;
    return Annot.createFromRange(range, tool === 'memo' ? 'yellow' : tool, tool === 'memo');
  }
  function bindPointer() {
    document.addEventListener('pointerdown', (e) => {
      down = null;
      if (!PEN.has(tool) || e.button !== 0 || e.pointerType === 'touch') return;
      if (startsOutside(e.target)) return;
      down = { t: Date.now(), type: e.pointerType };
    }, true);
    document.addEventListener('pointerup', (e) => {
      if (!down || e.pointerType === 'touch') return;
      down = null;
      setTimeout(applySelection, 0);
    }, true);
    // 드래그를 끝낸 클릭이 판례 상자를 접거나 편집 창을 여는 것을 막는다 (칠하기는 바로 뒤에 일어남)
    document.addEventListener('click', (e) => {
      if (!PEN.has(tool)) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount && Annot.selectionInContent(sel.getRangeAt(0)) && !startsOutside(e.target)) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    // 손가락: 길게 눌러 선택한 뒤 떼면 칠한다
    document.addEventListener('touchend', (e) => {
      if (!PEN.has(tool) || startsOutside(e.target)) return;
      setTimeout(applySelection, 380);
    }, { passive: true });
  }

  // ---------- 되돌리기 ----------
  function undo() { Editor.finish(); History.undo(); }
  function redo() { Editor.finish(); History.redo(); }
  function refreshHistory() {
    const u = $('#dock-undo'), r = $('#dock-redo');
    u.disabled = !History.canUndo();
    r.disabled = !History.canRedo();
    u.title = History.canUndo() ? `되돌리기: ${History.peek() || '마지막 동작'} (Ctrl+Z)` : '되돌리기 (Ctrl+Z)';
    r.title = History.canRedo() ? `다시하기: ${History.peekRedo() || '동작'} (Ctrl+Shift+Z)` : '다시하기 (Ctrl+Shift+Z)';
  }

  // ---------- 빈칸 ----------
  function refreshBlank() {
    const on = Annot.blankColors();
    $('#dock-blank').setAttribute('aria-pressed', String(on.length > 0));
    $$('#blank-pop .bp-c').forEach((b) => b.setAttribute('aria-pressed', String(on.includes(b.dataset.color))));
    $('#dock-blank').title = on.length ? `빈칸 모드: ${on.map((c) => Annot.COLOR_KO[c]).join('·')} 가림` : '빈칸 모드 — 하이라이트를 색깔별로 가리기';
  }
  function setBlank(colors) {
    Annot.setBlank(colors);
    App.savePref('blank', Annot.blankColors());
    refreshBlank();
    Panel.refresh();
  }
  function closePops() { $('#blank-pop').hidden = true; $('#dock-blank').setAttribute('aria-expanded', 'false'); }
  const popOpen = () => !$('#blank-pop').hidden;

  function setMin(min) {
    document.body.classList.toggle('dock-min', !!min);
    $('#pen-dock').hidden = !!min;
    $('#dock-fab').hidden = !min;
    App.savePref('dockMin', !!min);
    if (min) closePops();
  }
  function refreshLane() {
    const open = !document.body.classList.contains('lane-closed');
    const b = $('#dock-lane');
    b.setAttribute('aria-pressed', String(open));
    b.title = open ? '메모줄 접기' : '메모줄 펼치기';
  }

  function onKey(e) {
    if (e.altKey || inTypingTarget(e.target) || document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && (k === 'z' || k === 'Z') && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && (((k === 'z' || k === 'Z') && e.shiftKey) || k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return; }
    if (mod || Panel.isFull()) return;
    const t = KEYS[k];
    if (t) { e.preventDefault(); setTool(t, { announce: true }); }
  }

  function init(prefs) {
    bindPointer();
    const dock = $('#pen-dock');
    dock.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) { setTool(tool === b.dataset.tool && b.dataset.tool !== 'select' ? 'select' : b.dataset.tool); return; }
      switch (b.id) {
        case 'dock-undo': undo(); break;
        case 'dock-redo': redo(); break;
        case 'dock-blank': {
          const pop = $('#blank-pop');
          pop.hidden = !pop.hidden;
          b.setAttribute('aria-expanded', String(!pop.hidden));
          break;
        }
        case 'dock-lane': App.setLane(document.body.classList.contains('lane-closed')); break;
        case 'dock-panel': Panel.toggle(); break;
        case 'dock-min': setMin(true); break;
        default:
      }
    });
    $('#dock-fab').addEventListener('click', () => setMin(false));
    $('#blank-pop').addEventListener('click', (e) => {
      const c = e.target.closest('.bp-c');
      if (c) {
        const cur = new Set(Annot.blankColors());
        if (cur.has(c.dataset.color)) cur.delete(c.dataset.color); else cur.add(c.dataset.color);
        setBlank([...cur]);
        return;
      }
      if (e.target.closest('#bp-show')) { Annot.revealAll(true); Panel.refresh(); toast('가린 곳을 모두 열었습니다.'); }
      if (e.target.closest('#bp-hide')) { Annot.revealAll(false); Panel.refresh(); toast('모두 다시 가렸습니다.'); }
      if (e.target.closest('#bp-off')) { setBlank([]); closePops(); toast('빈칸 모드를 껐습니다.'); }
    });
    document.addEventListener('mousedown', (e) => { if (popOpen() && !e.target.closest('#blank-pop, #dock-blank')) closePops(); });
    document.addEventListener('keydown', onKey);
    History.on(refreshHistory);
    refreshHistory();
    Annot.setBlank(prefs.blank || []);
    refreshBlank();
    refreshLane();
    setTool(prefs.tool && prefs.tool !== 'edit' ? prefs.tool : 'select', { silent: true });
    if (prefs.dockMin) setMin(true);
  }

  return { init, tool: tool_, setTool, undo, redo, closePops, popOpen, refreshLane, refreshBlank, isPen: () => PEN.has(tool) };
})();

// ---- sync-github.js ----
// GitHub 동기화 — 서버 없이 브라우저가 GitHub REST API를 직접 부른다.
// 저장 위치: 비공개 저장소의 전용 브랜치(기본 annotations)에 JSON 파일 하나(하이라이트·메모·편집·진도). 저장할 때마다 커밋 1개가 생긴다.
// 마지막 위치처럼 자주 바뀌는 값은 바로 올리지 않고, 다른 변경을 올릴 때·창을 떠날 때·10분마다 함께 올린다.
// 순서: 변경 → 기기에 즉시 저장 → 2초 뒤 [최신 받기 → 항목별 합치기 → sha 붙여 PUT]. sha가 어긋나면 다시 받아 최대 3번 재시도.
const Sync = (() => {
  const SETTINGS_KEY = 'gongbeop2:gh';
  const API = 'https://api.github.com';
  let cfg = {};
  let s = {};
  let state = 'local', stateText = '로컬', lastError = '';
  let remoteSha = null, etag = null, branchMissing = false;
  let pushTimer = null, pollTimer = null, busy = false, again = false, lastPushAt = 0;
  const LAZY_FLUSH = 10 * 60 * 1000;
  const listeners = new Set();

  function defaults() {
    return {
      token: '', owner: cfg.owner || '', repo: cfg.repo || '',
      branch: cfg.annotationsBranch || 'annotations',
      path: cfg.annotationsPath || 'annotations/gongbeop2-kibonkwon.json',
      interval: 15,
    };
  }
  function loadSettings() {
    let saved = {};
    try { saved = JSON.parse(Store.lsGet(SETTINGS_KEY) || '{}') || {}; } catch (e) { saved = {}; }
    s = Object.assign(defaults(), saved);
  }
  function saveSettings(next) {
    s = Object.assign(s, next);
    Store.lsSet(SETTINGS_KEY, JSON.stringify(s));
    remoteSha = null; etag = null; branchMissing = false;
  }
  function settings() { return Object.assign({}, s); }
  function hasToken() { return !!(s.token && s.owner && s.repo); }

  function setState(st, text, err) {
    state = st; stateText = text; lastError = err || '';
    listeners.forEach((fn) => { try { fn({ state, text, error: lastError }); } catch (e) { /* noop */ } });
  }
  function on(fn) { listeners.add(fn); fn({ state, text: stateText, error: lastError }); return () => listeners.delete(fn); }

  // ---------- 인코딩 ----------
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(String(b64).replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

  // ---------- API ----------
  class GhError extends Error {
    constructor(status, message, extra) { super(message); this.status = status; Object.assign(this, extra || {}); }
  }
  async function gh(method, path, opts) {
    opts = opts || {};
    const headers = Object.assign({
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${s.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    }, opts.headers || {});
    let res;
    try {
      res = await fetch(API + path, {
        method, headers, cache: 'no-store', keepalive: !!opts.keepalive,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      throw new GhError(0, '네트워크에 연결할 수 없습니다.', { offline: true });
    }
    if (res.status === 304) return { status: 304, headers: res.headers };
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      const msg = (data && data.message) || res.statusText;
      const reset = res.headers.get('x-ratelimit-reset');
      throw new GhError(res.status, msg, { reset: reset ? Number(reset) * 1000 : null, remaining: res.headers.get('x-ratelimit-remaining') });
    }
    return { status: res.status, data, headers: res.headers };
  }
  function explain(e) {
    if (e.offline) return ['offline', '오프라인 — 기기에 보관 중'];
    if (e.status === 401) return ['error', '토큰 오류 — 다시 입력하세요'];
    if (e.status === 403) {
      if (e.remaining === '0' && e.reset) return ['error', `사용량 한도 — ${new Date(e.reset).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 이후 다시 시도`];
      return ['error', '권한 부족 — 토큰의 Contents 권한(읽기·쓰기)을 점검하세요'];
    }
    if (e.status === 404) return ['error', '저장소를 찾지 못함 — 소유자·저장소 이름과 토큰의 저장소 선택을 확인하세요'];
    return ['error', `동기화 오류 (${e.status || '?'}) ${e.message || ''}`];
  }

  // ---------- 받기 ----------
  async function fetchRemote(conditional) {
    const headers = {};
    if (conditional && etag) headers['If-None-Match'] = etag;
    let r;
    try {
      r = await gh('GET', `/repos/${enc(s.owner)}/${enc(s.repo)}/contents/${enc(s.path)}?ref=${encodeURIComponent(s.branch)}`, { headers });
    } catch (e) {
      if (e.status === 404) {
        // 브랜치가 없는지, 파일만 없는지 구분
        try {
          await gh('GET', `/repos/${enc(s.owner)}/${enc(s.repo)}/branches/${encodeURIComponent(s.branch)}`);
          branchMissing = false;
        } catch (e2) {
          if (e2.status === 404) {
            await gh('GET', `/repos/${enc(s.owner)}/${enc(s.repo)}`); // 저장소 자체가 없으면 여기서 404 오류
            branchMissing = true;
          } else throw e2;
        }
        remoteSha = null; etag = null;
        return { missing: true };
      }
      throw e;
    }
    if (r.status === 304) return { notModified: true };
    etag = r.headers.get('etag') || null;
    const d = r.data;
    remoteSha = d.sha;
    let text;
    if (d.encoding === 'base64' && d.content) text = b64decode(d.content);
    else {
      // 1MB가 넘으면 content가 비어 온다 → blob API로 받는다
      const b = await gh('GET', `/repos/${enc(s.owner)}/${enc(s.repo)}/git/blobs/${d.sha}`);
      text = b64decode(b.data.content);
    }
    let doc = null;
    try { doc = JSON.parse(text); } catch (e) { throw new GhError(422, '저장 파일을 읽을 수 없습니다(JSON 아님).'); }
    return { doc };
  }

  async function pull() {
    if (!hasToken()) return;
    const r = await fetchRemote(true);
    if (r.doc) {
      const changed = Store.mergeRemote(r.doc);
      if (changed.length) setState('pull', `다른 기기 변경 ${changed.length}건 반영`);
    }
    return r;
  }

  // ---------- 올리기 ----------
  function commitMessage() {
    const d = Store.device();
    const name = d.name || d.id.slice(0, 6);
    const now = Store.all();
    const hl = now.filter((i) => (i.kind || 'hl') === 'hl').length;
    const memo = now.filter((i) => (i.kind === 'hl' || i.kind === 'row') && (i.memo || '').trim()).length;
    const edits = now.filter((i) => i.kind === 'edit').length;
    const done = now.filter((i) => i.kind === 'prog' && i.done).length;
    const extra = [edits ? `편집 ${edits}` : '', done ? `다 봄 ${done}행` : ''].filter(Boolean).join(', ');
    return `annotations: 하이라이트 ${hl}, 메모 ${memo}${extra ? ', ' + extra : ''} (${name})`;
  }
  async function createBranchWithFile(content, message) {
    const base = `/repos/${enc(s.owner)}/${enc(s.repo)}`;
    const blob = await gh('POST', `${base}/git/blobs`, { body: { content, encoding: 'utf-8' } });
    const tree = await gh('POST', `${base}/git/trees`, { body: { tree: [{ path: s.path, mode: '100644', type: 'blob', sha: blob.data.sha }] } });
    const commit = await gh('POST', `${base}/git/commits`, { body: { message, tree: tree.data.sha, parents: [] } });
    await gh('POST', `${base}/git/refs`, { body: { ref: `refs/heads/${s.branch}`, sha: commit.data.sha } });
    branchMissing = false;
    remoteSha = blob.data.sha;
  }
  async function push(opts) {
    if (!hasToken()) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetchRemote(false);
      if (r.doc) Store.mergeRemote(r.doc, { markClean: true });
      if (!Store.isDirty() && !Store.isLazyDirty() && r.doc && !opts?.force) { Store.markSynced(); return; }
      const snap = Store.snapshot();
      const content = JSON.stringify(snap, null, 1);
      const message = commitMessage();
      try {
        if (branchMissing) {
          await createBranchWithFile(content, message);
        } else {
          const body = { message, content: b64encode(content), branch: s.branch };
          if (remoteSha) body.sha = remoteSha;
          const res = await gh('PUT', `/repos/${enc(s.owner)}/${enc(s.repo)}/contents/${enc(s.path)}`, { body, keepalive: opts?.keepalive && content.length < 48000 });
          remoteSha = res.data && res.data.content ? res.data.content.sha : null;
        }
        etag = null;
        lastPushAt = Date.now();
        Store.markSynced();
        return;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < 3) continue; // 다른 기기가 먼저 저장함 → 다시 받아 합친다
        if (e.status === 404 && !branchMissing && attempt < 3) { branchMissing = true; continue; }
        throw e;
      }
    }
  }

  async function run(kind, opts) {
    if (!hasToken()) { setState('local', '로컬'); return; }
    if (busy) { again = true; return; }
    busy = true;
    try {
      if (kind === 'push' || Store.isDirty()) {
        setState('busy', '저장 중');
        await push(opts);
      } else {
        await pull();
      }
      const t = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      setState('ok', `동기화됨 ${t}`);
    } catch (e) {
      const [st, txt] = explain(e);
      setState(st, txt, e.message);
    } finally {
      busy = false;
      if (again) { again = false; schedulePush(300); }
    }
  }

  function schedulePush(delay) {
    clearTimeout(pushTimer);
    if (!hasToken()) return;
    pushTimer = setTimeout(() => run('push'), delay == null ? 2000 : delay);
  }
  function startPolling() {
    clearInterval(pollTimer);
    if (!hasToken()) return;
    const sec = Math.max(5, Number(s.interval) || 15);
    pollTimer = setInterval(() => {
      if (document.visibilityState !== 'visible' || navigator.onLine === false) return;
      if (Store.isLazyDirty() && Date.now() - lastPushAt > LAZY_FLUSH) run('push');
      else run('pull');
    }, sec * 1000);
  }

  async function testConnection() {
    const r = await gh('GET', `/repos/${enc(s.owner)}/${enc(s.repo)}`);
    const remaining = r.headers.get('x-ratelimit-remaining');
    let branchInfo = '';
    try {
      await gh('GET', `/repos/${enc(s.owner)}/${enc(s.repo)}/branches/${encodeURIComponent(s.branch)}`);
      branchInfo = `저장 브랜치 '${s.branch}' 있음.`;
    } catch (e) {
      if (e.status === 404) branchInfo = `저장 브랜치 '${s.branch}'는 첫 저장 때 만들어집니다.`;
      else throw e;
    }
    return `저장소 ${r.data.full_name} (${r.data.private ? '비공개' : '공개'}) 연결됨. ${branchInfo} 남은 API 호출: ${remaining ?? '?'}회/시간. 쓰기 권한은 첫 저장 때 확인됩니다.`;
  }

  // 같은 브랜치에 임의 파일 저장 (하이라이트 모음 .md)
  async function putFile(filePath, text, message) {
    if (!hasToken()) throw new GhError(401, '토큰이 없습니다.');
    if (branchMissing) await run('push', { force: true });
    let sha;
    try {
      const r = await gh('GET', `/repos/${enc(s.owner)}/${enc(s.repo)}/contents/${enc(filePath)}?ref=${encodeURIComponent(s.branch)}`);
      sha = r.data.sha;
    } catch (e) { if (e.status !== 404) throw e; }
    const body = { message, content: b64encode(text), branch: s.branch };
    if (sha) body.sha = sha;
    await gh('PUT', `/repos/${enc(s.owner)}/${enc(s.repo)}/contents/${enc(filePath)}`, { body });
  }

  function historyUrl() { return `https://github.com/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/commits/${encodeURIComponent(s.branch)}`; }

  function init(config) {
    cfg = config || {};
    loadSettings();
    Store.on((ev) => { if (ev.local && !ev.lazy) schedulePush(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { if ((Store.isDirty() || Store.isLazyDirty()) && hasToken()) { clearTimeout(pushTimer); run('push', { keepalive: true }); } }
      else run('pull');
    });
    window.addEventListener('online', () => run(Store.isDirty() ? 'push' : 'pull'));
    window.addEventListener('offline', () => setState('offline', '오프라인 — 기기에 보관 중'));
    window.addEventListener('focus', () => run('pull'));
  }
  function start() {
    if (!hasToken()) { setState('local', '로컬'); return; }
    run(Store.isDirty() ? 'push' : 'pull');
    startPolling();
  }
  function restart() { clearInterval(pollTimer); clearTimeout(pushTimer); start(); }

  return { init, start, restart, settings, saveSettings, hasToken, on, run, testConnection, putFile, historyUrl, gh, b64decode, explain };
})();

// ---- content-loader.js ----
// 학습 내용 공급: ① 단일 HTML에 들어 있는 내용(inline) ② 비공개 저장소에서 토큰으로 받기(github) + IndexedDB 캐시
const Loader = (() => {
  const DB = 'gongbeop2-viewer', STORE = 'content', KEY = 'content';

  function inline() {
    const el = document.getElementById('content-data');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (e) { console.error(e); return null; }
  }

  function idb() {
    return new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(DB, 1); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }
  async function cacheGet() {
    const db = await idb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const r = db.transaction(STORE).objectStore(STORE).get(KEY);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  async function cachePut(v) {
    const db = await idb();
    if (!db) return;
    try { db.transaction(STORE, 'readwrite').objectStore(STORE).put(v, KEY); } catch (e) { /* 캐시 실패는 무시 */ }
  }
  async function cacheClear() {
    const db = await idb();
    if (!db) return;
    try { db.transaction(STORE, 'readwrite').objectStore(STORE).delete(KEY); } catch (e) { /* noop */ }
  }

  // 비공개 저장소에서 내용 묶음을 받는다. contentRefs 순서대로 시도(main이 없으면 작업 브랜치).
  async function fromGitHub(config, settings) {
    const cached = await cacheGet();
    const owner = settings.owner || config.owner, repo = settings.repo || config.repo;
    const refs = config.contentRefs || ['main'];
    let lastErr = null;
    for (const ref of refs) {
      const headers = {
        Accept: 'application/vnd.github.raw+json',
        Authorization: `Bearer ${settings.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      };
      const same = cached && cached.owner === owner && cached.repo === repo && cached.ref === ref;
      if (same && cached.etag) headers['If-None-Match'] = cached.etag;
      let res;
      try {
        const p = config.contentPath.split('/').map(encodeURIComponent).join('/');
        res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${p}?ref=${encodeURIComponent(ref)}`, { headers, cache: 'no-store' });
      } catch (e) {
        if (cached && cached.owner === owner && cached.repo === repo) return { content: cached.data, source: 'cache-offline' };
        throw Object.assign(new Error('네트워크에 연결할 수 없고, 이 기기에 저장된 내용도 없습니다.'), { offline: true });
      }
      if (res.status === 304 && same) return { content: cached.data, source: 'cache' };
      if (res.status === 404) { lastErr = Object.assign(new Error(`'${ref}' 브랜치에 내용 파일이 없습니다.`), { status: 404 }); continue; }
      if (!res.ok) {
        let msg = res.statusText;
        try { msg = (await res.json()).message || msg; } catch (e) { /* noop */ }
        throw Object.assign(new Error(msg), { status: res.status });
      }
      const text = await res.text();
      const data = JSON.parse(text);
      cachePut({ owner, repo, ref, etag: res.headers.get('etag'), data, savedAt: Date.now() });
      return { content: data, source: 'github', ref };
    }
    throw lastErr || new Error('내용을 찾지 못했습니다.');
  }

  return { inline, fromGitHub, cacheClear };
})();

// ---- app.js ----
// 화면 조립·보기 설정·대화 상자. 내용은 Loader가 공급한다.
const PREFS_KEY = 'gongbeop2:prefs';
const DEFAULT_CONFIG = {
  owner: 'chamcham02', repo: 'gong_mid', contentPath: 'dist/content.json',
  contentRefs: ['main'], annotationsBranch: 'annotations',
  annotationsPath: 'annotations/gongbeop2-kibonkwon.json', digestPath: 'annotations/하이라이트_모음.md',
};

const App = (() => {
  let prefs = { theme: 'system', ratio: '4:6', font: 16, supp: true, focus: false, toc: true, mode: 'parallel', done: {}, tool: 'select', lane: true, blank: [], hlFull: false, dockMin: false };
  let config = DEFAULT_CONFIG;
  let content = null;
  const slots = new Map();

  function loadPrefs() {
    try { prefs = Object.assign(prefs, JSON.parse(Store.lsGet(PREFS_KEY) || '{}')); } catch (e) { /* 기본값 */ }
  }
  function savePrefs() { Store.lsSet(PREFS_KEY, JSON.stringify(prefs)); }
  function savePref(k, v) { prefs[k] = v; savePrefs(); }

  function applyTheme() {
    if (prefs.theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', prefs.theme);
    $$('#seg-theme button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === prefs.theme)));
  }
  function applyRatio() {
    const [a, b] = prefs.ratio.split(':');
    document.documentElement.style.setProperty('--col-pdf', `${a}fr`);
    document.documentElement.style.setProperty('--col-md', `${b}fr`);
    $$('#seg-ratio button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.ratio === prefs.ratio)));
  }
  function applyFont() { document.documentElement.style.setProperty('--fs', `${prefs.font}px`); }
  function setSupp(on) {
    prefs.supp = on; savePrefs();
    document.body.classList.toggle('hide-supp', !on);
    $('#opt-supp').checked = on;
    scheduleSticky();
  }
  function setFocus(on) {
    prefs.focus = on; savePrefs();
    document.body.classList.toggle('focus-hc', on);
    $('#btn-focus').setAttribute('aria-pressed', String(on));
    $('#opt-focus').checked = on;
    scheduleSticky();
  }
  // 메모줄 펼치기/접기
  function setLane(open) {
    prefs.lane = !!open; savePrefs();
    document.body.classList.toggle('lane-closed', !open);
    const mi = $('#btn-lane-toggle');
    if (mi) mi.textContent = open ? '메모줄 접기' : '메모줄 펼치기';
    if (typeof Dock !== 'undefined') Dock.refreshLane();
    MemoLane.schedule();
  }
  function setToc(open) {
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    if (narrow) document.body.classList.toggle('toc-open', open);
    else { prefs.toc = open; savePrefs(); document.body.classList.toggle('toc-closed', !open); }
  }

  // ---------- 보기 방식 ----------
  function setMode(mode) {
    if (mode === prefs.mode && (mode === 'parallel' || $('#solo-inner').childElementCount)) { updateModeButtons(); return; }
    Editor.finish();
    restoreSolo();
    if (mode === 'solo-pdf' || mode === 'solo-md') {
      const src = mode === 'solo-pdf' ? 'pdf' : 'md';
      const inner = $('#solo-inner');
      inner.className = 'solo-inner src-' + src;
      inner.innerHTML = `<div class="solo-head" data-generated>${src === 'pdf' ? '요약본 (PDF) — 원래 쪽·단 순서' : '강의노트 (MD) — 원래 순서'} · 병렬 보기로 돌아가려면 위의 ‘병렬’</div>`;
      const els = $$(`#units [data-sb="${src}"], #doc-head [data-sb="${src}"]`).filter((el) => !el.parentElement.closest('[data-sb]'));
      els.sort((a, b) => Number(a.dataset.order) - Number(b.dataset.order));
      for (const el of els) {
        const ph = document.createElement('i');
        ph.className = 'slot';
        el.before(ph);
        slots.set(el, ph);
        if (el.classList.contains('unit-title-pdf')) el.classList.add('unit-mark');
        inner.appendChild(el);
      }
      document.body.classList.add('mode-solo');
      window.scrollTo({ top: 0 });
    } else {
      document.body.classList.remove('mode-solo');
    }
    prefs.mode = mode; savePrefs();
    updateModeButtons();
    scheduleSticky();
    MemoLane.schedule();
  }
  function restoreSolo() {
    for (const [el, ph] of slots) { el.classList.remove('unit-mark'); ph.replaceWith(el); }
    slots.clear();
    $('#solo-inner').innerHTML = '';
  }
  function updateModeButtons() { $$('#seg-mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === prefs.mode))); }

  function setRowTab(row, tab) {
    if (!row) return;
    if (tab === 'pdf' && row.dataset.hasPdf !== '1') return;
    if (tab === 'md' && row.dataset.hasMd !== '1') return;
    row.dataset.tab = tab;
    $$('.row-tabs button', row).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
  }

  // ---------- 짧은 칸 고정 ----------
  let stickyQueued = false;
  function scheduleSticky() {
    if (stickyQueued) return;
    stickyQueued = true;
    requestAnimationFrame(() => { stickyQueued = false; updateSticky(); });
  }
  function updateSticky() {
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    const vh = window.innerHeight - 110;
    for (const row of $$('#units .row')) {
      const p = row.querySelector('.cell-pdf'), m = row.querySelector('.cell-md');
      p.classList.remove('stick'); m.classList.remove('stick');
      if (narrow || document.body.classList.contains('mode-solo')) continue;
      const hp = p.offsetHeight, hm = m.offsetHeight;
      const short = hp < hm ? p : m, sh = Math.min(hp, hm), lh = Math.max(hp, hm);
      if (sh < vh && lh > sh + 120) short.classList.add('stick');
    }
  }

  // ---------- 목차 따라가기 ----------
  function trackToc() {
    const items = new Map($$('#toc .toc-row').map((li) => [li.dataset.row, li]));
    let active = null;
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const li = items.get(en.target.dataset.row);
        if (!li || li === active) continue;
        if (active) active.classList.remove('active');
        active = li;
        li.classList.add('active');
        const toc = $('#toc');
        const r = li.getBoundingClientRect(), tr = toc.getBoundingClientRect();
        if (r.top < tr.top + 40 || r.bottom > tr.bottom - 40) toc.scrollTop += r.top - tr.top - tr.height / 3;
      }
    }, { rootMargin: '-35% 0px -60% 0px' });
    $$('#units .row').forEach((r) => io.observe(r));
  }

  // ---------- 내용 그리기 ----------
  function render(c) {
    content = c;
    document.title = c.title || document.title;
    $('#brand-title').textContent = c.title || '';
    $('#brand-sub').textContent = c.sub || '';
    $('#doc-head').innerHTML = sanitize(c.headHtml);
    $('#toc').innerHTML = sanitize(c.tocHtml);
    $('#units').innerHTML = sanitize(c.unitsHtml);
    $('#toc').addEventListener('click', (e) => {
      if (e.target.closest('a') && window.matchMedia('(max-width: 900px)').matches) setToc(false);
    });
    $('#units').addEventListener('click', (e) => {
      const tb = e.target.closest('.row-tabs button');
      if (tb) setRowTab(tb.closest('.row'), tb.dataset.tab);
    });
    const ro = new ResizeObserver(() => { scheduleSticky(); MemoLane.schedule(); });
    $$('#units .cell').forEach((c2) => ro.observe(c2));
    ro.observe($('#solo-inner'));
    window.addEventListener('resize', () => { scheduleSticky(); MemoLane.schedule(); });
    trackToc();
    if (location.hash) {
      const t = document.getElementById(location.hash.slice(1));
      if (t) setTimeout(() => t.scrollIntoView(), 50);
    }
  }
  // 비공개 저장소의 내용은 직접 빌드한 결과물이지만, 혹시 모를 스크립트·이벤트 속성은 걸러낸다
  function sanitize(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    tpl.content.querySelectorAll('script, iframe, object, embed, link, meta, style').forEach((n) => n.remove());
    tpl.content.querySelectorAll('*').forEach((el) => {
      for (const a of [...el.attributes]) {
        if (/^on/i.test(a.name)) el.removeAttribute(a.name);
        if ((a.name === 'href' || a.name === 'src') && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
      }
    });
    const div = document.createElement('div');
    div.appendChild(tpl.content);
    return div.innerHTML;
  }

  // ---------- 연결 화면 (공개 뷰어, 토큰 없음) ----------
  function showGate(err) {
    document.body.classList.add('gated');
    $('#doc-head').innerHTML = '';
    $('#units').innerHTML = '';
    $('#toc').innerHTML = '';
    const g = document.createElement('div');
    g.className = 'gate';
    g.innerHTML = `<h1>병렬노트</h1>
      <p>이 페이지에는 화면만 있고, 내용은 비공개 저장소에 있습니다. GitHub 토큰을 넣으면 내용을 불러오고, 하이라이트와 메모도 그 저장소에 저장됩니다.</p>
      <div class="card">
        <div class="dlg-status" id="gate-status"></div>
        <p class="help">토큰은 이 기기 브라우저에만 저장되고 GitHub 말고는 어디에도 보내지 않습니다.</p>
        <div><button type="button" class="btn-primary" id="gate-open">GitHub 연결 설정</button></div>
      </div>`;
    $('#units').appendChild(g);
    $('#gate-status').textContent = err ? `불러오지 못했습니다: ${err.message || err}` : '아직 연결하지 않았습니다.';
    $('#gate-open').addEventListener('click', openSyncDialog);
  }

  // ---------- 동기화 대화 상자 ----------
  function openSyncDialog() {
    const st = Sync.settings();
    $('#gh-token').value = st.token || '';
    $('#gh-owner').value = st.owner || '';
    $('#gh-repo').value = st.repo || '';
    $('#gh-branch').value = st.branch || '';
    $('#gh-path').value = st.path || '';
    $('#gh-interval').value = st.interval || 15;
    $('#gh-device').value = Store.device().name || '';
    $('#gh-history').href = Sync.historyUrl();
    $('#dlg-sync').showModal();
  }
  function readSyncForm() {
    return {
      token: $('#gh-token').value.trim(), owner: $('#gh-owner').value.trim(), repo: $('#gh-repo').value.trim(),
      branch: $('#gh-branch').value.trim() || 'annotations', path: $('#gh-path').value.trim(),
      interval: Math.max(5, Number($('#gh-interval').value) || 15),
    };
  }
  function bindSyncDialog() {
    const status = $('#sync-status');
    $('#gh-save').addEventListener('click', async () => {
      Sync.saveSettings(readSyncForm());
      Store.setDeviceName($('#gh-device').value.trim());
      $('#dlg-sync').close();
      if (document.body.classList.contains('gated')) { location.reload(); return; }
      Sync.restart();
      toast(Sync.hasToken() ? 'GitHub 연결을 저장했습니다.' : '로컬 모드로 전환했습니다.');
    });
    $('#gh-test').addEventListener('click', async () => {
      Sync.saveSettings(readSyncForm());
      status.textContent = '확인 중…';
      try { status.textContent = await Sync.testConnection(); }
      catch (e) { status.textContent = Sync.explain(e)[1]; }
    });
    $('#gh-sync-now').addEventListener('click', async () => {
      Sync.saveSettings(readSyncForm());
      status.textContent = '동기화 중…';
      await Sync.run(Store.isDirty() ? 'push' : 'pull');
    });
    $('#gh-clear').addEventListener('click', async () => {
      if (!(await confirmDlg('토큰 지우기', '이 기기에서 토큰을 지웁니다. 하이라이트와 메모는 이 기기에 남습니다.'))) return;
      Sync.saveSettings({ token: '' });
      $('#gh-token').value = '';
      await Loader.cacheClear();
      Sync.restart();
      toast('토큰을 지웠습니다.');
    });
    Sync.on(({ state, text, error }) => {
      const b = $('#sync-badge');
      b.dataset.state = state;
      $('#sync-text').textContent = text;
      b.title = error ? `${text}\n${error}` : text;
      if ($('#dlg-sync').open) status.textContent = text + (error ? ` — ${error}` : '');
    });
  }

  // ---------- 상단 바·메뉴 ----------
  function bindTopbar() {
    $('#btn-toc').addEventListener('click', () => {
      const narrow = window.matchMedia('(max-width: 900px)').matches;
      setToc(narrow ? !document.body.classList.contains('toc-open') : document.body.classList.contains('toc-closed'));
    });
    $$('#seg-mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    $('#btn-focus').addEventListener('click', () => setFocus(!prefs.focus));
    $('#opt-focus').addEventListener('change', (e) => setFocus(e.target.checked));
    $('#opt-supp').addEventListener('change', (e) => setSupp(e.target.checked));
    const menu = $('#menu-panel'), mbtn = $('#btn-menu');
    mbtn.addEventListener('click', () => { menu.hidden = !menu.hidden; mbtn.setAttribute('aria-expanded', String(!menu.hidden)); });
    const closeMenu = () => { menu.hidden = true; mbtn.setAttribute('aria-expanded', 'false'); };
    menuClose = closeMenu;
    document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.menu')) closeMenu(); });
    // 동작 버튼(보기 설정 칸 제외)을 누르면 메뉴를 닫는다
    menu.addEventListener('click', (e) => { if (e.target.closest('.menu-panel > button')) closeMenu(); });
    $('#btn-cases-close').addEventListener('click', () => { $$('details.callout').forEach((d) => { d.open = false; }); scheduleSticky(); MemoLane.schedule(); toast('판례 상자를 모두 접었습니다.'); });
    $('#btn-cases-open').addEventListener('click', () => { $$('details.callout').forEach((d) => { d.open = true; }); scheduleSticky(); MemoLane.schedule(); toast('판례 상자를 모두 폈습니다.'); });
    $('#btn-memos-toggle').addEventListener('click', () => MemoLane.toggleAllMemos());
    $('#btn-lane-toggle').addEventListener('click', () => setLane(!prefs.lane));
    $('#opt-orig').addEventListener('change', (e) => { Editor.setShowOriginal(e.target.checked); toast(e.target.checked ? '고친 문단을 원본으로 보여줍니다.' : '고친 문단을 다시 보여줍니다.'); });
    $('#btn-edits-revert').addEventListener('click', () => Editor.revertAll());
    $$('#seg-ratio button').forEach((b) => b.addEventListener('click', () => { prefs.ratio = b.dataset.ratio; savePrefs(); applyRatio(); scheduleSticky(); MemoLane.schedule(); }));
    $('#btn-font-dec').addEventListener('click', () => { prefs.font = Math.max(13, prefs.font - 1); savePrefs(); applyFont(); scheduleSticky(); MemoLane.schedule(); });
    $('#btn-font-inc').addEventListener('click', () => { prefs.font = Math.min(21, prefs.font + 1); savePrefs(); applyFont(); scheduleSticky(); MemoLane.schedule(); });
    $$('#seg-theme button').forEach((b) => b.addEventListener('click', () => { prefs.theme = b.dataset.themeSet; savePrefs(); applyTheme(); }));
    $('#sync-badge').addEventListener('click', openSyncDialog);
    $('#btn-sync-settings').addEventListener('click', openSyncDialog);

    // 하이라이트 모아보기
    $('#btn-hl-panel').addEventListener('click', () => Panel.toggle());
    $('#hl-copy-md').addEventListener('click', () => copyText(Panel.toMarkdown()));
    $('#hl-dl-md').addEventListener('click', () => download(`하이라이트_모음_${stamp()}.md`, Panel.toMarkdown(), 'text/markdown;charset=utf-8'));
    $('#hl-push-md').addEventListener('click', async () => {
      if (!Sync.hasToken()) { toast('먼저 GitHub 연결을 설정하세요.'); openSyncDialog(); return; }
      try {
        await Sync.putFile(config.digestPath || 'annotations/하이라이트_모음.md', Panel.toMarkdown(), `하이라이트 모음 갱신 (${stamp()})`);
        toast('GitHub에 하이라이트 모음을 저장했습니다.');
      } catch (e) { toast(Sync.explain(e)[1]); }
    });

    // 백업
    $('#btn-export-json').addEventListener('click', () => download(`gongbeop2-annotations-${stamp()}.json`, JSON.stringify(Store.snapshot(), null, 1), 'application/json'));
    $('#btn-import-json').addEventListener('click', () => { $('#import-status').textContent = '파일을 고르세요.'; $('#import-file').value = ''; $('#dlg-import').showModal(); });
    $('#import-go').addEventListener('click', async () => {
      const f = $('#import-file').files[0];
      if (!f) { $('#import-status').textContent = '파일을 먼저 고르세요.'; return; }
      try {
        const doc = JSON.parse(await f.text());
        if (!doc || typeof doc.items !== 'object') throw new Error('하이라이트 백업 파일이 아닙니다.');
        const mode = $('input[name="import-mode"]:checked').value;
        if (mode === 'replace') Store.replaceAll(doc.items);
        else { Store.mergeRemote(doc); Store.markDirty(); }
        $('#dlg-import').close();
        Annot.paintAll();
        Progress.refresh();
        toast(`백업을 불러왔습니다 (${Object.keys(doc.items).length}개 항목).`);
      } catch (e) { $('#import-status').textContent = `불러오지 못했습니다: ${e.message}`; }
    });
    $('#btn-clear-all').addEventListener('click', async () => {
      const all = Store.all(['hl', 'row']);
      if (!all.length) { toast('지울 하이라이트·메모가 없습니다.'); return; }
      if (!(await confirmDlg('모두 지우기', `하이라이트·메모 ${all.length}개를 모두 지웁니다(편집·진도는 그대로). GitHub에 연결돼 있으면 다른 기기에서도 지워집니다. 되돌리기(Ctrl+Z)나 변경 이력으로 되살릴 수 있습니다.`))) return;
      History.group('모든 하이라이트·메모 지우기', () => all.forEach((it) => History.remove(it.id)));
      toast('모두 지웠습니다.');
    });
  }
  let menuClose = () => {};
  // Esc 우선순위: 대화 상자(브라우저) > 메뉴 > 떠 있는 창 > 전체 화면 모아보기 > 메모 시트 > 선택 도구막대 > 도구 → 선택 > 돌아가기 칩
  function onEscape(e) {
    if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if (e.target && e.target.closest && e.target.closest('.memo-card textarea, #memo-sheet textarea')) { e.target.blur(); return; }
    if (inTypingTarget(e.target)) return;
    if (!$('#menu-panel').hidden) { menuClose(); return; }
    if (Dock.popOpen()) { Dock.closePops(); return; }
    if (!$('#prog-pop').hidden) { Progress.togglePop(false); return; }
    if (Panel.isFull()) { Panel.setFull(false); savePref('hlFull', false); return; }
    if (MemoLane.sheetOpen()) { MemoLane.closeSheet(); return; }
    if (Annot.floatingOpen()) { Annot.hideToolbar(); Annot.hidePop(); return; }
    if (Dock.tool() !== 'select') { Dock.setTool('select', { announce: true }); return; }
    if (!$('#hl-return').hidden) { $('#hl-return').hidden = true; }
  }
  function openPanel() { Panel.open(); }
  function closePanel() { Panel.close(); }

  function showStorageBanner() {
    if (Store.storageOk()) return;
    const b = document.createElement('div');
    b.className = 'banner';
    b.textContent = '이 환경에서는 브라우저 저장소를 쓸 수 없어 하이라이트·메모가 기기에 저장되지 않습니다. GitHub 연결이나 백업 내보내기를 이용하세요.';
    $('#banner-area').appendChild(b);
  }

  async function loadConfig() {
    const inlineCfg = document.getElementById('viewer-config');
    if (inlineCfg) { try { return Object.assign({}, DEFAULT_CONFIG, JSON.parse(inlineCfg.textContent)); } catch (e) { /* 기본값 */ } }
    try {
      const r = await fetch('config.json', { cache: 'no-store' });
      if (r.ok) return Object.assign({}, DEFAULT_CONFIG, await r.json());
    } catch (e) { /* 단일 파일로 열었을 때 */ }
    return DEFAULT_CONFIG;
  }

  async function boot() {
    loadPrefs();
    applyTheme(); applyRatio(); applyFont();
    document.body.classList.toggle('toc-closed', !prefs.toc);
    bindTopbar();
    config = await loadConfig();
    Sync.init(config);
    bindSyncDialog();
    showStorageBanner();
    let c = Loader.inline();
    if (!c) {
      if (!Sync.hasToken()) { showGate(); return; }
      try {
        const r = await Loader.fromGitHub(config, Sync.settings());
        c = r.content;
        if (r.source === 'cache-offline') toast('오프라인 — 이 기기에 저장된 내용을 보여줍니다.');
      } catch (e) {
        showGate(e);
        Sync.start();
        return;
      }
    }
    render(c);
    setSupp(prefs.supp);
    setFocus(prefs.focus);
    document.body.classList.toggle('lane-closed', !prefs.lane);
    // 순서가 중요: 편집본 적용 → 메모줄 → 색칠 → 계층(병렬 배치에서 계산) → 진도 → 도구바 → 보기 방식 복원
    Editor.init();
    MemoLane.init();
    Annot.init(c);
    Panel.init();
    Progress.init(c, prefs);
    Dock.init(prefs);
    setLane(prefs.lane);
    if (prefs.hlFull) Panel.setFull(true, { silent: true });
    document.addEventListener('keydown', onEscape);
    if (prefs.mode !== 'parallel') { const m = prefs.mode; prefs.mode = 'parallel'; setMode(m); }
    Sync.start();
    scheduleSticky();
    MemoLane.schedule();
  }

  return { boot, setMode, setSupp, setFocus, setRowTab, setLane, savePref, openPanel, closePanel, scheduleSticky, mode: () => prefs.mode };
})();

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => App.boot());
else App.boot();

})();

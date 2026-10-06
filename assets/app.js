/* 병렬노트 뷰어 — 학습 내용은 들어 있지 않음. 내용은 열람할 때 비공개 저장소에서 불러온다. */
(function () {
'use strict';
// ---- store.js ----
// 하이라이트·메모 데이터 — 기기에 먼저 저장(localStorage)하고, 동기화는 sync-github.js가 맡는다.
// 항목은 updatedAt이 늦은 쪽이 이긴다(같으면 deviceId 비교). 삭제는 묘비(deleted: true)로 남겨 다른 기기에 전파한다.
const Store = (() => {
  const DOC = 'gongbeop2-kibonkwon';
  const KEY = DOC + ':annotations:v1';
  const META_KEY = DOC + ':annotations-meta:v1';
  const DEVICE_KEY = 'gongbeop2:device';
  const TOMBSTONE_TTL = 30 * 24 * 3600 * 1000;
  let doc = { schema: 1, doc: DOC, items: {} };
  let meta = { dirty: false, lastSync: null };
  let storageOk = true;
  const listeners = new Set();

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { storageOk = false; return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { storageOk = false; return false; } }

  function probe() {
    try { localStorage.setItem(DOC + ':probe', '1'); localStorage.removeItem(DOC + ':probe'); } catch (e) { storageOk = false; }
  }

  function device() {
    let d = null;
    try { d = JSON.parse(lsGet(DEVICE_KEY) || 'null'); } catch (e) { d = null; }
    if (!d || !d.id) {
      d = { id: 'd' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4), name: '' };
      lsSet(DEVICE_KEY, JSON.stringify(d));
    }
    return d;
  }
  function setDeviceName(name) { const d = device(); d.name = name; lsSet(DEVICE_KEY, JSON.stringify(d)); }

  function load() {
    probe();
    try {
      const raw = lsGet(KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && d.items) doc = { schema: 1, doc: DOC, items: d.items };
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

  function put(item, opts) {
    const now = Date.now();
    const d = device();
    const prev = doc.items[item.id];
    const next = Object.assign({}, prev || {}, item, { updatedAt: now, deviceId: d.id });
    if (!next.createdAt) next.createdAt = now;
    doc.items[next.id] = next;
    meta.dirty = true;
    persist();
    emit({ type: 'put', ids: [next.id], local: true, silent: opts && opts.silent });
    return next;
  }
  function remove(id) {
    const prev = doc.items[id];
    if (!prev) return;
    doc.items[id] = { id, kind: prev.kind, deleted: true, updatedAt: Date.now(), deviceId: device().id, createdAt: prev.createdAt };
    meta.dirty = true;
    persist();
    emit({ type: 'remove', ids: [id], local: true });
  }
  function get(id) { const it = doc.items[id]; return it && !it.deleted ? it : null; }
  function all() { return Object.values(doc.items).filter((it) => !it.deleted); }

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
      if (wins(r, l) && JSON.stringify(r) !== JSON.stringify(l)) {
        doc.items[id] = r;
        changed.push(id);
      }
    }
    // 원격에 없는 로컬 항목이 있으면 올릴 것이 남아 있다
    const remoteIds = new Set(Object.keys(remote.items));
    let localAhead = false;
    for (const [id, l] of Object.entries(doc.items)) {
      const r = remote.items[id];
      if (!remoteIds.has(id) || wins(l, r) && JSON.stringify(l) !== JSON.stringify(r)) { localAhead = true; break; }
    }
    if (opts && opts.markClean && !localAhead) meta.dirty = false;
    else if (localAhead) meta.dirty = true;
    persist();
    if (changed.length) emit({ type: 'merge', ids: changed, local: false });
    return changed;
  }

  function replaceAll(items) {
    const now = Date.now();
    const d = device();
    const ids = new Set([...Object.keys(doc.items), ...Object.keys(items)]);
    for (const id of ids) {
      if (items[id] && !items[id].deleted) doc.items[id] = Object.assign({}, items[id], { updatedAt: now, deviceId: d.id });
      else if (doc.items[id] && !doc.items[id].deleted) doc.items[id] = { id, kind: doc.items[id].kind, deleted: true, updatedAt: now, deviceId: d.id };
    }
    meta.dirty = true;
    persist();
    emit({ type: 'merge', ids: [...ids], local: true });
  }
  function clearAll() { replaceAll({}); }

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
  function markSynced() { meta.dirty = false; meta.lastSync = Date.now(); persist(); }
  function isDirty() { return meta.dirty; }
  function lastSync() { return meta.lastSync; }
  function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  load();
  return { put, remove, get, all, mergeRemote, replaceAll, clearAll, snapshot, markSynced, markDirty, isDirty, lastSync, on, newId, device, setDeviceName, storageOk: () => storageOk, lsGet, lsSet };
})();

// ---- annotate.js ----
// 하이라이트·메모 화면 — 원문 HTML은 건드리지 않고 실행 중에만 <mark>와 메모 카드를 덧입힌다.
const Annot = (() => {
  const COLORS = ['yellow', 'green', 'pink', 'blue'];
  const COLOR_KO = { yellow: '노랑', green: '초록', pink: '분홍', blue: '파랑' };
  const SRC_KO = { pdf: '요약본', md: '강의노트', supp: '보완 현출' };
  let rowsMeta = [], unitsMeta = [];
  const bidRow = new Map();     // 블록 id → 행 id
  const bidPos = new Map();     // 블록 id → 병렬 보기 문서 순서
  const rowPos = new Map();
  const openMemos = new Set();  // 메모 카드를 열어 둔 하이라이트 (메모가 아직 비어 있어도 표시)
  const orphans = new Set();    // 본문에서 위치를 찾지 못한 항목
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
      if (cmp < 0) return t.start;
      if (cmp === 0) return t.start;
    }
    return list.length ? list[list.length - 1].end : 0;
  }
  function topBlock(el) {
    let b = el && el.closest('[data-bid]');
    while (b && b.parentElement && b.parentElement.closest('[data-bid]')) b = b.parentElement.closest('[data-bid]');
    return b;
  }

  function rangeToSegs(range) {
    let anc = range.commonAncestorContainer;
    if (anc.nodeType === 3) anc = anc.parentElement;
    if (!anc) return { segs: [] };
    if (anc.closest('.memo-card, .hl-toolbar, .hl-pop, [data-generated]') && !anc.closest('[data-bid]')) return { segs: [] };
    let blocks;
    const single = topBlock(anc);
    if (single) blocks = [single];
    else {
      const root = anc.closest('.cell, .solo-inner');
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
      m.className = 'uhl';
      m.dataset.hid = item.id;
      m.dataset.color = item.color || 'yellow';
      n.parentNode.insertBefore(m, n);
      m.appendChild(n);
      marks.push(m);
    }
    return marks;
  }
  function unpaint(id) {
    document.querySelectorAll(`mark.uhl[data-hid="${CSS.escape(id)}"]`).forEach((m) => {
      const p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    });
    document.querySelectorAll(`.memo-card[data-memo-for="${CSS.escape(id)}"]`).forEach((c) => c.remove());
  }
  function findBlock(bid) { return document.querySelector(`[data-bid="${CSS.escape(bid)}"]`); }

  // 저장된 위치의 글자가 다르면 칠한 글자와 앞뒤 문맥으로 다시 찾는다
  function locate(seg, item, block) {
    const txt = blockText(block);
    if (txt.slice(seg.s, seg.e) === seg.text) return [seg.s, seg.e];
    const cands = [];
    let i = txt.indexOf(seg.text);
    while (i >= 0) { cands.push(i); i = txt.indexOf(seg.text, i + 1); }
    if (!cands.length) return null;
    let best = cands[0], bestScore = -1;
    for (const c of cands) {
      let score = -Math.abs(c - seg.s) / 1000;
      if (item.pre && txt.slice(Math.max(0, c - item.pre.length), c) === item.pre) score += 2;
      if (item.post && txt.slice(c + seg.text.length, c + seg.text.length + item.post.length) === item.post) score += 2;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return [best, best + seg.text.length];
  }

  function paint(item) {
    unpaint(item.id);
    if (item.kind === 'row') { renderRowMemo(item); return true; }
    let ok = true;
    let lastBlock = null;
    const marks = [];
    for (const seg of item.segs || []) {
      const block = findBlock(seg.b);
      if (!block) { ok = false; continue; }
      const loc = locate(seg, item, block);
      if (!loc) { ok = false; continue; }
      marks.push(...wrap(block, loc[0], loc[1], item));
      lastBlock = block;
    }
    if (marks.length && (item.memo || openMemos.has(item.id))) {
      marks[marks.length - 1].classList.add('memo-tail');
      marks.forEach((m) => m.classList.add('has-memo'));
      if (lastBlock) lastBlock.appendChild(memoCard(item));
    }
    if (marks.length) orphans.delete(item.id); else orphans.add(item.id);
    return ok && marks.length > 0;
  }

  // ---------- 메모 카드 ----------
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function firstLine(s) { return (s || '').split('\n').find((l) => l.trim()) || ''; }
  function memoCard(item) {
    const card = document.createElement('div');
    card.className = 'memo-card' + (item.collapsed ? ' collapsed' : '');
    card.dataset.generated = '';
    card.dataset.memoFor = item.id;
    const isRow = item.kind === 'row';
    card.innerHTML =
      `<div class="memo-head"><button type="button" class="tw" aria-label="메모 접기/펼치기">${item.collapsed ? '▸' : '▾'}</button>` +
      `<span class="memo-dot" data-color="${isRow ? 'row' : item.color}"></span><span class="memo-prev"></span><span class="memo-kind">${isRow ? '행 메모' : '메모'}</span></div>` +
      `<div class="memo-body">${isRow ? '' : '<p class="memo-quote"></p>'}<textarea rows="3" placeholder="메모를 적으세요. 입력을 멈추면 자동 저장됩니다."></textarea>` +
      `<div class="memo-meta"><span class="memo-time"></span><button type="button" data-act="del">${isRow ? '행 메모 삭제' : '메모 삭제'}</button></div></div>`;
    card.querySelector('.memo-prev').textContent = firstLine(item.memo) || (isRow ? '빈 행 메모' : '빈 메모');
    if (!isRow) card.querySelector('.memo-quote').textContent = '“' + (item.text || '') + '”';
    const ta = card.querySelector('textarea');
    ta.value = item.memo || '';
    card.querySelector('.memo-time').textContent = item.updatedAt ? `수정 ${fmtTime(item.updatedAt)}` : '';
    let timer = null;
    ta.addEventListener('input', () => {
      clearTimeout(timer);
      card.querySelector('.memo-prev').textContent = firstLine(ta.value) || '빈 메모';
      timer = setTimeout(() => saveMemo(item.id, ta.value), 600);
    });
    ta.addEventListener('blur', () => { clearTimeout(timer); saveMemo(item.id, ta.value); });
    card.querySelector('.memo-head').addEventListener('click', (ev) => {
      if (ev.target.closest('textarea')) return;
      toggleCollapse(item.id);
    });
    card.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (isRow) {
        if (await confirmDlg('행 메모 삭제', '이 행 메모를 지울까요?')) Store.remove(item.id);
      } else {
        openMemos.delete(item.id);
        const cur = Store.get(item.id);
        if (cur) Store.put({ id: item.id, memo: '' });
      }
    });
    return card;
  }
  function saveMemo(id, value) {
    const cur = Store.get(id);
    if (!cur || (cur.memo || '') === value) return;
    Store.put({ id, memo: value }, { silent: true });
    const card = document.querySelector(`.memo-card[data-memo-for="${CSS.escape(id)}"] .memo-time`);
    if (card) card.textContent = `수정 ${fmtTime(Date.now())}`;
    refreshCounts();
  }
  function toggleCollapse(id, force) {
    const cur = Store.get(id);
    if (!cur) return;
    const collapsed = force === undefined ? !cur.collapsed : force;
    Store.put({ id, collapsed }, { silent: true });
    document.querySelectorAll(`.memo-card[data-memo-for="${CSS.escape(id)}"]`).forEach((c) => {
      c.classList.toggle('collapsed', collapsed);
      c.querySelector('.tw').textContent = collapsed ? '▸' : '▾';
    });
  }
  function toggleAllMemos() {
    const items = Store.all().filter((it) => it.kind === 'row' || it.memo);
    if (!items.length) { toast('메모가 아직 없습니다.'); return; }
    const anyOpen = items.some((it) => !it.collapsed);
    items.forEach((it) => toggleCollapse(it.id, anyOpen));
    toast(anyOpen ? '메모를 모두 접었습니다.' : '메모를 모두 펼쳤습니다.');
  }
  function renderRowMemo(item) {
    const row = document.getElementById(item.rowId);
    if (!row) { orphans.add(item.id); return; }
    orphans.delete(item.id);
    row.appendChild(memoCard(item));
  }
  function addRowMemo(rowId) {
    const it = Store.put({ id: Store.newId('r'), kind: 'row', rowId, memo: '', collapsed: false });
    setTimeout(() => {
      const ta = document.querySelector(`.memo-card[data-memo-for="${CSS.escape(it.id)}"] textarea`);
      if (ta) { ta.focus(); ta.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    }, 30);
  }

  // ---------- 선택 도구막대 ----------
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
  function hideToolbar() { toolbar.hidden = true; pendingRange = null; }
  function hidePop() { pop.hidden = true; popFor = null; }

  let selTimer = null;
  function onSelection() {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { if (!toolbar.contains(document.activeElement)) hideToolbar(); return; }
      const range = sel.getRangeAt(0);
      const host = range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentElement : range.commonAncestorContainer;
      if (!host || !host.closest('#units, #solo-inner') || host.closest('.memo-card, textarea, input')) { hideToolbar(); return; }
      const { segs, error } = rangeToSegs(range);
      if (error === 'cross') { hideToolbar(); toast('하이라이트는 한 칸(요약본 또는 강의노트) 안에서만 칠할 수 있습니다.'); return; }
      if (!segs.length) { hideToolbar(); return; }
      pendingRange = range.cloneRange();
      hidePop();
      placeFloating(toolbar, range.getBoundingClientRect(), coarse());
    }, 160);
  }

  function create(color, withMemo) {
    if (!pendingRange) return;
    const { segs, blocks } = rangeToSegs(pendingRange);
    if (!segs.length) { hideToolbar(); return; }
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
    if (withMemo) openMemos.add(item.id);
    window.getSelection().removeAllRanges();
    hideToolbar();
    Store.put(item);
    if (withMemo) focusMemo(item.id);
  }
  function focusMemo(id) {
    setTimeout(() => {
      const card = document.querySelector(`.memo-card[data-memo-for="${CSS.escape(id)}"]`);
      if (!card) return;
      if (card.classList.contains('collapsed')) toggleCollapse(id, false);
      const ta = card.querySelector('textarea');
      ta.focus({ preventScroll: true });
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 30);
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

  // ---------- 다시 그리기 ----------
  function onStore(ev) {
    if (ev.silent) { refreshCounts(); return; }
    for (const id of ev.ids) {
      const it = Store.get(id);
      const editing = document.activeElement && document.activeElement.closest && document.activeElement.closest(`.memo-card[data-memo-for="${CSS.escape(id)}"]`);
      if (editing && it && !ev.local) {
        // 입력 중인 메모 칸은 덮어쓰지 않는다 (색·위치만 반영)
        document.querySelectorAll(`mark.uhl[data-hid="${CSS.escape(id)}"]`).forEach((m) => { m.dataset.color = it.color; });
        continue;
      }
      if (!it) unpaint(id); else paint(it);
    }
    refreshCounts();
    if (!document.getElementById('hl-panel').hidden) renderPanel();
  }
  function paintAll() {
    for (const it of Store.all()) paint(it);
    refreshCounts();
  }

  function refreshCounts() {
    const items = Store.all();
    const hl = items.filter((i) => i.kind === 'hl');
    document.getElementById('hl-count').textContent = String(hl.length);
    const per = new Map();
    for (const it of items) {
      const r = it.kind === 'row' ? it.rowId : (it.rowId || bidRow.get(it.segs?.[0]?.b));
      if (r) per.set(r, (per.get(r) || 0) + 1);
    }
    document.querySelectorAll('[data-hl-count]').forEach((el) => {
      const n = per.get(el.dataset.hlCount) || 0;
      el.hidden = n === 0;
      el.textContent = n ? String(n) : '';
      el.title = n ? `하이라이트·메모 ${n}개` : '';
    });
  }

  // ---------- 모아보기 ----------
  function itemRow(it) { return it.kind === 'row' ? it.rowId : (it.rowId || bidRow.get(it.segs?.[0]?.b)); }
  function itemPos(it) {
    const r = itemRow(it);
    const seg = it.segs?.[0];
    return [rowPos.get(r) ?? 1e9, it.kind === 'row' ? 1e9 : (bidPos.get(seg?.b) ?? 1e9), seg?.s ?? 0];
  }
  function filtered() {
    const colors = new Set([...document.querySelectorAll('.f-color:checked')].map((x) => x.value));
    const src = document.getElementById('f-src').value;
    const unit = document.getElementById('f-unit').value;
    const memoOnly = document.getElementById('f-memo').checked;
    return Store.all().filter((it) => {
      if (memoOnly && !(it.memo || '').trim()) return false;
      if (it.kind === 'hl') {
        if (!colors.has(it.color)) return false;
        if (src !== 'all' && it.src !== src) return false;
      } else if (src !== 'all') return false;
      if (unit !== 'all') {
        const rm = rowsMeta.find((r) => r.id === itemRow(it));
        if (!rm || rm.unit !== unit) return false;
      }
      return true;
    });
  }
  function grouped(items) {
    const sort = document.getElementById('f-sort').value;
    items.sort((a, b) => {
      if (sort === 'recent') return (b.updatedAt || 0) - (a.updatedAt || 0);
      const pa = itemPos(a), pb = itemPos(b);
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    });
    if (sort === 'recent') return [{ unit: null, rows: [{ row: null, items }] }];
    const out = [];
    const lost = [];
    for (const it of items) {
      const rid = itemRow(it);
      const rm = rowsMeta.find((r) => r.id === rid);
      if (!rm || orphans.has(it.id)) { lost.push(it); continue; }
      let g = out.find((x) => x.unit === rm.unit);
      if (!g) { g = { unit: rm.unit, rows: [] }; out.push(g); }
      let rg = g.rows.find((x) => x.row === rid);
      if (!rg) { rg = { row: rid, items: [] }; g.rows.push(rg); }
      rg.items.push(it);
    }
    if (lost.length) out.push({ unit: '__lost', rows: [{ row: null, items: lost }] });
    return out;
  }
  function renderPanel() {
    const list = document.getElementById('hl-list');
    const groups = grouped(filtered());
    list.innerHTML = '';
    if (!groups.length || groups.every((g) => g.rows.every((r) => !r.items.length))) {
      list.innerHTML = '<p class="sp-empty">조건에 맞는 하이라이트가 없습니다. 본문에서 글자를 선택하면 칠할 수 있습니다.</p>';
      return;
    }
    for (const g of groups) {
      const um = unitsMeta.find((u) => u.id === g.unit);
      const det = document.createElement('details');
      det.className = 'sp-unit';
      det.open = true;
      const n = g.rows.reduce((a, r) => a + r.items.length, 0);
      const title = g.unit === '__lost' ? '위치를 잃은 하이라이트' : (um ? `${um.num} ${um.title}` : '최근 순');
      det.innerHTML = `<summary></summary>`;
      det.querySelector('summary').textContent = title;
      const nn = document.createElement('span'); nn.className = 'n'; nn.textContent = String(n);
      det.querySelector('summary').appendChild(nn);
      for (const rg of g.rows) {
        const box = document.createElement('div');
        box.className = rg.row ? 'sp-row' : '';
        if (rg.row) {
          const rm = rowsMeta.find((r) => r.id === rg.row);
          const t = document.createElement('div'); t.className = 'sp-row-title'; t.textContent = rm ? rm.title : rg.row;
          box.appendChild(t);
        }
        for (const it of rg.items) box.appendChild(panelItem(it));
        det.appendChild(box);
      }
      list.appendChild(det);
    }
  }
  function panelItem(it) {
    const wrapEl = document.createElement('div');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sp-item';
    if (it.kind === 'row') {
      b.innerHTML = `<span class="src md">행 메모</span><span class="sp-memo"></span>`;
      b.querySelector('.sp-memo').textContent = it.memo || '(비어 있음)';
    } else {
      b.innerHTML = `<span class="src ${it.src}">${SRC_KO[it.src] || ''}</span><span class="txt" data-color="${it.color}"></span>`;
      b.querySelector('.txt').textContent = it.text;
    }
    b.addEventListener('click', () => goTo(it));
    wrapEl.appendChild(b);
    if (it.kind === 'hl' && (it.memo || '').trim()) {
      const tg = document.createElement('button');
      tg.type = 'button'; tg.className = 'sp-memo-toggle';
      const memo = document.createElement('div'); memo.className = 'sp-memo'; memo.textContent = it.memo;
      memo.hidden = !!it.collapsed;
      tg.textContent = memo.hidden ? '▸ 메모 보기' : '▾ 메모 접기';
      tg.addEventListener('click', () => {
        memo.hidden = !memo.hidden;
        tg.textContent = memo.hidden ? '▸ 메모 보기' : '▾ 메모 접기';
      });
      wrapEl.appendChild(tg);
      wrapEl.appendChild(memo);
    }
    return wrapEl;
  }
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
    if (window.matchMedia('(max-width: 900px)').matches) App.closePanel();
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const flashEl = it.kind === 'row' ? target : (target.closest('[data-bid]') || target);
    flashEl.classList.remove('flash'); void flashEl.offsetWidth; flashEl.classList.add('flash');
  }

  function toMarkdown() {
    const groups = grouped(filtered());
    const lines = [`# 하이라이트 모음 — 기본권 병렬노트`, '', `내보낸 시각: ${new Date().toLocaleString('ko-KR')}`, ''];
    for (const g of groups) {
      const um = unitsMeta.find((u) => u.id === g.unit);
      lines.push(`## ${g.unit === '__lost' ? '위치를 잃은 하이라이트' : (um ? `${um.num} ${um.title}` : '최근 순')}`, '');
      for (const rg of g.rows) {
        if (rg.row) {
          const rm = rowsMeta.find((r) => r.id === rg.row);
          lines.push(`### ${rm ? rm.title : rg.row}`, '');
        }
        for (const it of rg.items) {
          if (it.kind === 'row') lines.push(`- [행 메모] ${(it.memo || '').replace(/\n/g, '\n  ')}`);
          else {
            lines.push(`- [${SRC_KO[it.src] || ''}·${COLOR_KO[it.color] || ''}] “${it.text}”`);
            if ((it.memo || '').trim()) lines.push(`  - 메모: ${it.memo.trim().replace(/\n/g, '\n    ')}`);
          }
        }
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  // ---------- 초기화 ----------
  function indexBlocks() {
    let i = 0;
    document.querySelectorAll('#units [data-bid]').forEach((b) => {
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
    toolbar = document.getElementById('hl-toolbar');
    pop = document.getElementById('hl-pop');
    indexBlocks();
    const fu = document.getElementById('f-unit');
    unitsMeta.forEach((u) => { const o = document.createElement('option'); o.value = u.id; o.textContent = `${u.num} ${u.title}`; fu.appendChild(o); });

    document.addEventListener('selectionchange', onSelection);
    toolbar.addEventListener('mousedown', (e) => e.preventDefault());
    toolbar.addEventListener('click', (e) => {
      const sw = e.target.closest('.hl-sw');
      if (sw) return create(sw.dataset.color);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'memo') create('yellow', true);
      if (act === 'cancel') { window.getSelection().removeAllRanges(); hideToolbar(); }
    });
    pop.addEventListener('click', async (e) => {
      if (!popFor) return;
      const id = popFor;
      const sw = e.target.closest('.hl-sw');
      if (sw) { Store.put({ id, color: sw.dataset.color }); hidePop(); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'memo') { openMemos.add(id); hidePop(); const it = Store.get(id); if (it) paint(it); focusMemo(id); }
      if (act === 'delete') {
        hidePop();
        const it = Store.get(id);
        if (it && it.memo && !(await confirmDlg('하이라이트 삭제', '메모도 함께 지워집니다. 지울까요?'))) return;
        openMemos.delete(id);
        Store.remove(id);
      }
    });
    document.getElementById('main').addEventListener('click', (e) => {
      const m = e.target.closest('mark.uhl');
      if (m && window.getSelection().isCollapsed) { e.preventDefault(); openPop(m); return; }
      const add = e.target.closest('.row-memo-add');
      if (add) addRowMemo(add.dataset.row);
    });
    document.addEventListener('mousedown', (e) => {
      if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('mark.uhl')) hidePop();
    });
    document.addEventListener('keydown', (e) => {
      if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'Escape') { hideToolbar(); hidePop(); return; }
      if (toolbar.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'h' || e.key === 'H' || e.key === 'ㅗ') { e.preventDefault(); create('yellow'); }
      if (e.key === 'm' || e.key === 'M' || e.key === 'ㅡ') { e.preventDefault(); create('yellow', true); }
    });
    window.addEventListener('resize', () => { hideToolbar(); hidePop(); });

    ['f-src', 'f-unit', 'f-memo', 'f-sort'].forEach((id) => document.getElementById(id).addEventListener('change', renderPanel));
    document.querySelectorAll('.f-color').forEach((c) => c.addEventListener('change', renderPanel));

    Store.on(onStore);
    paintAll();
  }

  return { init, renderPanel, toMarkdown, toggleAllMemos, refreshCounts, paintAll, unpaint, blockText, rangeToSegs };
})();

// ---- sync-github.js ----
// GitHub 동기화 — 서버 없이 브라우저가 GitHub REST API를 직접 부른다.
// 저장 위치: 비공개 저장소의 전용 브랜치(기본 annotations)에 JSON 파일 하나. 저장할 때마다 커밋 1개가 생긴다.
// 순서: 변경 → 기기에 즉시 저장 → 2초 뒤 [최신 받기 → 항목별 합치기 → sha 붙여 PUT]. sha가 어긋나면 다시 받아 최대 3번 재시도.
const Sync = (() => {
  const SETTINGS_KEY = 'gongbeop2:gh';
  const API = 'https://api.github.com';
  let cfg = {};
  let s = {};
  let state = 'local', stateText = '로컬', lastError = '';
  let remoteSha = null, etag = null, branchMissing = false;
  let pushTimer = null, pollTimer = null, busy = false, again = false;
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
  function commitMessage(prevItems) {
    const d = Store.device();
    const name = d.name || d.id.slice(0, 6);
    const now = Store.all();
    const hl = now.filter((i) => i.kind === 'hl').length;
    const memo = now.filter((i) => (i.memo || '').trim()).length;
    return `annotations: 하이라이트 ${hl}, 메모 ${memo} (${name})`;
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
      if (!Store.isDirty() && r.doc && !opts?.force) { Store.markSynced(); return; }
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
      if (document.visibilityState === 'visible' && navigator.onLine !== false) run('pull');
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
    Store.on((ev) => { if (ev.local) schedulePush(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { if (Store.isDirty() && hasToken()) { clearTimeout(pushTimer); run('push', { keepalive: true }); } }
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

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return [...(root || document).querySelectorAll(sel)]; }

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

const App = (() => {
  let prefs = { theme: 'system', ratio: '4:6', font: 16, supp: true, focus: false, toc: true, mode: 'parallel', done: {} };
  let config = DEFAULT_CONFIG;
  let content = null;
  const slots = new Map();

  function loadPrefs() {
    try { prefs = Object.assign(prefs, JSON.parse(Store.lsGet(PREFS_KEY) || '{}')); } catch (e) { /* 기본값 */ }
  }
  function savePrefs() { Store.lsSet(PREFS_KEY, JSON.stringify(prefs)); }

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
  function setToc(open) {
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    if (narrow) document.body.classList.toggle('toc-open', open);
    else { prefs.toc = open; savePrefs(); document.body.classList.toggle('toc-closed', !open); }
  }

  // ---------- 보기 방식 ----------
  function setMode(mode) {
    if (mode === prefs.mode && (mode === 'parallel' || $('#solo-inner').childElementCount)) { updateModeButtons(); return; }
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
    // 학습 완료 체크
    $$('.toc-done').forEach((cb) => {
      cb.checked = !!prefs.done[cb.dataset.unit];
      cb.addEventListener('change', () => { prefs.done[cb.dataset.unit] = cb.checked; savePrefs(); });
    });
    $('#toc').addEventListener('click', (e) => {
      if (e.target.closest('a') && window.matchMedia('(max-width: 900px)').matches) setToc(false);
    });
    $('#units').addEventListener('click', (e) => {
      const tb = e.target.closest('.row-tabs button');
      if (tb) setRowTab(tb.closest('.row'), tb.dataset.tab);
    });
    const ro = new ResizeObserver(() => scheduleSticky());
    $$('#units .cell').forEach((c2) => ro.observe(c2));
    window.addEventListener('resize', scheduleSticky);
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
    document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.menu')) closeMenu(); });
    // 동작 버튼(보기 설정 칸 제외)을 누르면 메뉴를 닫는다
    menu.addEventListener('click', (e) => { if (e.target.closest('.menu-panel > button')) closeMenu(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) closeMenu(); });
    $('#btn-cases-close').addEventListener('click', () => { $$('details.callout').forEach((d) => { d.open = false; }); scheduleSticky(); toast('판례 상자를 모두 접었습니다.'); });
    $('#btn-cases-open').addEventListener('click', () => { $$('details.callout').forEach((d) => { d.open = true; }); scheduleSticky(); toast('판례 상자를 모두 폈습니다.'); });
    $('#btn-memos-toggle').addEventListener('click', () => Annot.toggleAllMemos());
    $$('#seg-ratio button').forEach((b) => b.addEventListener('click', () => { prefs.ratio = b.dataset.ratio; savePrefs(); applyRatio(); scheduleSticky(); }));
    $('#btn-font-dec').addEventListener('click', () => { prefs.font = Math.max(13, prefs.font - 1); savePrefs(); applyFont(); scheduleSticky(); });
    $('#btn-font-inc').addEventListener('click', () => { prefs.font = Math.min(21, prefs.font + 1); savePrefs(); applyFont(); scheduleSticky(); });
    $$('#seg-theme button').forEach((b) => b.addEventListener('click', () => { prefs.theme = b.dataset.themeSet; savePrefs(); applyTheme(); }));
    $('#sync-badge').addEventListener('click', openSyncDialog);
    $('#btn-sync-settings').addEventListener('click', openSyncDialog);

    // 하이라이트 모아보기
    $('#btn-hl-panel').addEventListener('click', () => { const p = $('#hl-panel'); if (p.hidden) openPanel(); else closePanel(); });
    $('#hl-panel-close').addEventListener('click', closePanel);
    $('#hl-copy-md').addEventListener('click', () => copyText(Annot.toMarkdown()));
    $('#hl-dl-md').addEventListener('click', () => download(`하이라이트_모음_${stamp()}.md`, Annot.toMarkdown(), 'text/markdown;charset=utf-8'));
    $('#hl-push-md').addEventListener('click', async () => {
      if (!Sync.hasToken()) { toast('먼저 GitHub 연결을 설정하세요.'); openSyncDialog(); return; }
      try {
        await Sync.putFile(config.digestPath || 'annotations/하이라이트_모음.md', Annot.toMarkdown(), `하이라이트 모음 갱신 (${stamp()})`);
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
        toast(`백업을 불러왔습니다 (${Object.keys(doc.items).length}개 항목).`);
      } catch (e) { $('#import-status').textContent = `불러오지 못했습니다: ${e.message}`; }
    });
    $('#btn-clear-all').addEventListener('click', async () => {
      if (!(await confirmDlg('모두 지우기', '모든 하이라이트와 메모를 지웁니다. GitHub에 연결돼 있으면 다른 기기에서도 지워집니다. 변경 이력에서 되살릴 수는 있습니다.'))) return;
      Store.clearAll();
      toast('모두 지웠습니다.');
    });
  }
  function openPanel() {
    $('#hl-panel').hidden = false;
    $('#btn-hl-panel').setAttribute('aria-pressed', 'true');
    Annot.renderPanel();
  }
  function closePanel() {
    $('#hl-panel').hidden = true;
    $('#btn-hl-panel').setAttribute('aria-pressed', 'false');
  }

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
    Annot.init(c);
    if (prefs.mode !== 'parallel') { const m = prefs.mode; prefs.mode = 'parallel'; setMode(m); }
    Sync.start();
    scheduleSticky();
  }

  return { boot, setMode, setSupp, setFocus, setRowTab, openPanel, closePanel, scheduleSticky };
})();

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => App.boot());
else App.boot();

})();

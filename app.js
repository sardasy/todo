/**
 * 할 일 (TODO) — 의존성 없는 단일 페이지 앱.
 * 데이터는 localStorage에 저장된다.
 */
(function () {
  'use strict';

  var ITEMS_KEY = 'todo.items.v1';
  var PREFS_KEY = 'todo.prefs.v1';
  var MAX_LEN = 200;
  var UNDO_MS = 7000;

  var PRIORITY = {
    high:   { label: '높음', rank: 0 },
    normal: { label: '',     rank: 1 },
    low:    { label: '낮음', rank: 2 }
  };
  var THEMES = ['system', 'light', 'dark'];
  var THEME_ICON = { system: '#i-monitor', light: '#i-sun', dark: '#i-moon' };
  var THEME_LABEL = { system: '시스템 설정', light: '밝은 테마', dark: '어두운 테마' };

  // ---------- 상태 ----------
  var items = [];
  var prefs = { filter: 'all', sort: 'manual', theme: 'system' };
  var query = '';          // 검색어는 저장하지 않는다.
  var editingId = null;
  var editFocusPending = false; // 편집을 새로 열 때만 편집 입력으로 포커스를 옮긴다.
  var editDraft = null;         // 저장 전 편집 값. 재렌더·필터링에도 유지된다.
  var pendingUndo = null;  // [{ index, item }]
  var toastTimer = null;
  var dragId = null;

  // ---------- DOM ----------
  var $ = function (id) { return document.getElementById(id); };
  var listEl = $('list');
  var newForm = $('new-form');
  var newInput = $('new-input');
  var newPriority = $('new-priority');
  var newDue = $('new-due');
  var searchInput = $('search');
  var sortSelect = $('sort');
  var emptyEl = $('empty');
  var toastEl = $('toast');
  var helpDialog = $('help-dialog');
  var announcer = $('announcer');
  var itemTpl = $('tpl-item');
  var editTpl = $('tpl-edit');

  // ---------- 유틸 ----------
  function uid() {
    return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function ymd(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function parseYmd(s) {
    var p = s.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  /** 두 날짜(로컬 자정 기준)의 일수 차이. */
  function daysFromToday(due) {
    var today = parseYmd(ymd(new Date()));
    return Math.round((parseYmd(due) - today) / 86400000);
  }

  function formatDue(due) {
    var d = daysFromToday(due);
    if (d === 0) return '오늘';
    if (d === 1) return '내일';
    if (d === 2) return '모레';
    if (d === -1) return '어제';
    if (d < 0) return -d + '일 지남';
    if (d <= 7) return d + '일 뒤';
    var date = parseYmd(due);
    var y = date.getFullYear() !== new Date().getFullYear() ? date.getFullYear() + '년 ' : '';
    return y + (date.getMonth() + 1) + '월 ' + date.getDate() + '일';
  }

  function announce(msg) { announcer.textContent = msg; }

  // ---------- 저장소 ----------
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var title = typeof raw.title === 'string' ? raw.title.trim().slice(0, MAX_LEN) : '';
    if (!title) return null;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
      title: title,
      done: raw.done === true,
      priority: PRIORITY[raw.priority] ? raw.priority : 'normal',
      due: typeof raw.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.due) ? raw.due : null,
      createdAt: typeof raw.createdAt === 'number' && isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
      completedAt: typeof raw.completedAt === 'number' && isFinite(raw.completedAt) ? raw.completedAt : null
    };
  }

  function load() {
    try {
      var stored = JSON.parse(localStorage.getItem(ITEMS_KEY) || '[]');
      var list = Array.isArray(stored) ? stored : stored.items;
      var seen = Object.create(null);
      items = (Array.isArray(list) ? list : []).map(normalize).filter(function (it) {
        if (!it || seen[it.id]) return false;
        seen[it.id] = true;
        return true;
      });
    } catch (e) {
      items = [];
    }
    try {
      var p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      if (['all', 'active', 'done'].indexOf(p.filter) >= 0) prefs.filter = p.filter;
      if (['manual', 'due', 'priority', 'created'].indexOf(p.sort) >= 0) prefs.sort = p.sort;
      if (THEMES.indexOf(p.theme) >= 0) prefs.theme = p.theme;
    } catch (e) { /* 기본값 유지 */ }
  }

  function save() {
    try {
      localStorage.setItem(ITEMS_KEY, JSON.stringify(items));
    } catch (e) {
      showToast('저장하지 못했습니다. 브라우저 저장 공간을 확인하세요.');
    }
  }

  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* 무시 */ }
  }

  // ---------- 조회 ----------
  function byId(id) {
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  }

  function matchesFilter(it) {
    if (prefs.filter === 'active') return !it.done;
    if (prefs.filter === 'done') return it.done;
    return true;
  }

  function visibleItems() {
    var q = query.trim().toLowerCase();
    var list = items.filter(function (it) {
      if (!matchesFilter(it)) return false;
      return !q || it.title.toLowerCase().indexOf(q) >= 0;
    });

    if (prefs.sort === 'due') {
      list.sort(function (a, b) {
        if (a.due !== b.due) {
          if (!a.due) return 1;
          if (!b.due) return -1;
          return a.due < b.due ? -1 : 1;
        }
        return PRIORITY[a.priority].rank - PRIORITY[b.priority].rank;
      });
    } else if (prefs.sort === 'priority') {
      list.sort(function (a, b) {
        return PRIORITY[a.priority].rank - PRIORITY[b.priority].rank || b.createdAt - a.createdAt;
      });
    } else if (prefs.sort === 'created') {
      list.sort(function (a, b) { return b.createdAt - a.createdAt; });
    }
    return list;
  }

  // ---------- 렌더 ----------
  function captureFocus() {
    var el = document.activeElement;
    if (!el || !el.closest) return null;
    var row = el.closest('.item');
    if (!row) return null;
    var kinds = ['check', 'btn-edit', 'btn-del'];
    var kind = null;
    for (var i = 0; i < kinds.length; i++) if (el.classList.contains(kinds[i])) kind = kinds[i];
    return { id: row.dataset.id, kind: kind };
  }

  function restoreFocus(snap) {
    if (!snap) return;
    var row = listEl.querySelector('.item[data-id="' + (window.CSS && CSS.escape ? CSS.escape(snap.id) : snap.id) + '"]');
    if (!row) { listEl.focus(); return; }
    var target = snap.kind ? row.querySelector('.' + snap.kind) : null;
    (target || row).focus();
  }

  function renderRow(it) {
    var node = itemTpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = it.id;
    node.classList.toggle('done', it.done);
    node.draggable = prefs.sort === 'manual';

    var check = node.querySelector('.check');
    check.checked = it.done;
    check.setAttribute('aria-label', it.title + (it.done ? ' — 완료됨' : ''));

    node.querySelector('.title').textContent = it.title;
    node.querySelector('.badge-prio').textContent = PRIORITY[it.priority].label;
    node.querySelector('.badge-prio').className = 'badge badge-prio ' + it.priority;

    var dueEl = node.querySelector('.badge-due');
    if (it.due) {
      var diff = daysFromToday(it.due);
      dueEl.textContent = formatDue(it.due);
      dueEl.title = it.due;
      // 완료된 항목의 기한 초과 강조는 CSS(.item.done.overdue)가 중화한다.
      if (diff < 0) node.classList.add('overdue');
      else if (!it.done && diff <= 2) dueEl.classList.add('soon');
    }
    return node;
  }

  function openEdit(id) {
    editingId = id;
    editDraft = null;
    editFocusPending = true;
    render();
  }

  function closeEdit() {
    editingId = null;
    editDraft = null;
  }

  /** 재렌더 전에 편집 폼의 값을 editDraft로, 포커스·커서를 반환값으로 보존한다. */
  function captureEdit() {
    if (!editingId) return null;
    var row = listEl.querySelector('.item.editing');
    if (!row || row.dataset.id !== editingId) return null; // 폼이 화면에 없으면 기존 draft 유지
    var title = row.querySelector('.edit-title');
    editDraft = {
      title: title.value,
      prio: row.querySelector('.edit-prio').value,
      due: row.querySelector('.edit-due').value
    };
    var focusEl = document.activeElement;
    var kind = null;
    if (row.contains(focusEl) && focusEl.classList) {
      ['edit-title', 'edit-prio', 'edit-due'].forEach(function (c) {
        if (focusEl.classList.contains(c)) kind = c;
      });
    }
    return { focusKind: kind, selStart: title.selectionStart, selEnd: title.selectionEnd };
  }

  /** @returns {boolean} 편집 폼 안으로 포커스를 옮겼는지 여부 */
  function restoreEdit(snap) {
    var row = listEl.querySelector('.item.editing');
    if (!row) { editFocusPending = false; return false; }
    var title = row.querySelector('.edit-title');
    var moved = false;

    if (editFocusPending) {
      title.focus();
      title.setSelectionRange(title.value.length, title.value.length);
      moved = true;
    } else if (snap && snap.focusKind) {
      var el = row.querySelector('.' + snap.focusKind);
      el.focus();
      if (snap.focusKind === 'edit-title') title.setSelectionRange(snap.selStart, snap.selEnd);
      moved = true;
    }
    editFocusPending = false;
    return moved;
  }

  function renderEditRow(it) {
    var node = editTpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = it.id;
    node.querySelector('.edit-title').value = editDraft ? editDraft.title : it.title;
    node.querySelector('.edit-prio').value = editDraft ? editDraft.prio : it.priority;
    node.querySelector('.edit-due').value = editDraft ? editDraft.due : (it.due || '');
    return node;
  }

  function render() {
    var snap = captureFocus();
    var editSnap = captureEdit();
    var list = visibleItems();

    listEl.textContent = '';
    listEl.classList.toggle('no-drag', prefs.sort !== 'manual');
    var frag = document.createDocumentFragment();
    for (var i = 0; i < list.length; i++) {
      frag.appendChild(list[i].id === editingId ? renderEditRow(list[i]) : renderRow(list[i]));
    }
    listEl.appendChild(frag);

    renderCounts(list.length);

    if (editingId) {
      // 포커스가 편집 폼 밖(다른 항목의 체크박스 등)에 있었다면 그쪽을 복원한다.
      if (!restoreEdit(editSnap)) restoreFocus(snap);
    } else {
      restoreFocus(snap);
    }
  }

  function renderCounts(visibleCount) {
    var total = items.length;
    var done = items.filter(function (it) { return it.done; }).length;
    var active = total - done;

    $('cnt-all').textContent = total;
    $('cnt-active').textContent = active;
    $('cnt-done').textContent = done;

    var pct = total ? Math.round((done / total) * 100) : 0;
    $('bar-fill').style.width = pct + '%';
    $('bar').setAttribute('aria-valuenow', pct);
    $('progress-text').textContent = pct + '%';

    $('summary').textContent = total === 0
      ? '할 일이 없습니다'
      : '남은 할 일 ' + active + '개 · 완료 ' + done + '개';

    $('clear-done').disabled = done === 0;
    $('toggle-all').disabled = total === 0;
    $('toggle-all').textContent = total > 0 && active === 0 ? '전체 완료 해제' : '전체 완료';

    emptyEl.hidden = visibleCount > 0;
    if (visibleCount === 0) {
      var t, s;
      if (query.trim()) {
        t = '검색 결과가 없습니다';
        s = '"' + query.trim() + '"와 일치하는 할 일이 없어요.';
      } else if (total === 0) {
        t = '아직 할 일이 없습니다';
        s = '위 입력창에 할 일을 적고 Enter를 눌러 보세요.';
      } else if (prefs.filter === 'active') {
        t = '진행 중인 할 일이 없습니다';
        s = '모두 끝냈네요. 잘하셨습니다!';
      } else {
        t = '완료한 할 일이 없습니다';
        s = '체크박스를 눌러 할 일을 완료 처리해 보세요.';
      }
      $('empty-title').textContent = t;
      $('empty-sub').textContent = s;
    }
  }

  function refresh() { save(); render(); }

  // ---------- 동작 ----------
  function addItem(title, priority, due) {
    title = title.trim().slice(0, MAX_LEN);
    if (!title) return;
    items.unshift({
      id: uid(),
      title: title,
      done: false,
      priority: PRIORITY[priority] ? priority : 'normal',
      due: due || null,
      createdAt: Date.now(),
      completedAt: null
    });
    refresh();
    announce('추가됨: ' + title);
  }

  function toggleItem(id) {
    var it = byId(id);
    if (!it) return;
    it.done = !it.done;
    it.completedAt = it.done ? Date.now() : null;
    refresh();
    announce(it.title + (it.done ? ' 완료' : ' 완료 취소'));
  }

  function removeItems(ids, message) {
    var removed = [];
    ids.forEach(function (id) {
      var i = items.findIndex(function (x) { return x.id === id; });
      if (i >= 0) removed.push({ index: i, item: items[i] });
    });
    if (!removed.length) return;

    removed.slice().sort(function (a, b) { return b.index - a.index; })
      .forEach(function (r) { items.splice(r.index, 1); });

    pendingUndo = removed.slice().sort(function (a, b) { return a.index - b.index; });
    if (editingId && ids.indexOf(editingId) >= 0) closeEdit();
    refresh();
    showToast(message, '실행 취소', undoRemove);
    announce(message);
  }

  function undoRemove() {
    if (!pendingUndo) return;
    pendingUndo.forEach(function (r) {
      items.splice(Math.min(r.index, items.length), 0, r.item);
    });
    var n = pendingUndo.length;
    pendingUndo = null;
    refresh();
    announce(n + '개 항목을 복구했습니다');
  }

  function moveItem(id, dir) {
    if (prefs.sort !== 'manual') {
      showToast('순서를 바꾸려면 정렬을 "직접 정렬"로 바꾸세요.');
      return;
    }
    var visible = visibleItems();
    var vi = visible.findIndex(function (x) { return x.id === id; });
    var target = visible[vi + dir];
    if (vi < 0 || !target) return;

    var a = items.indexOf(byId(id));
    var b = items.indexOf(target);
    items.splice(b, 0, items.splice(a, 1)[0]);
    refresh();
    announce((dir < 0 ? '위로' : '아래로') + ' 이동: ' + byId(id).title);
  }

  /** 드래그 후 DOM 순서를 items 배열에 반영한다(필터된 부분만 자리바꿈). */
  function commitDomOrder() {
    var domIds = Array.prototype.map.call(listEl.querySelectorAll('.item'), function (el) { return el.dataset.id; });
    var set = new Set(domIds);
    var slots = [];
    items.forEach(function (it, i) { if (set.has(it.id)) slots.push(i); });
    if (slots.length !== domIds.length) return;
    var map = new Map(items.map(function (it) { return [it.id, it]; }));
    slots.forEach(function (pos, k) { items[pos] = map.get(domIds[k]); });
  }

  // ---------- 토스트 ----------
  function showToast(message, actionLabel, onAction) {
    clearTimeout(toastTimer);
    $('toast-msg').textContent = message;
    var btn = $('toast-action');
    btn.hidden = !actionLabel;
    btn.textContent = actionLabel || '';
    // 동작을 먼저 실행한다. hideToast()가 pendingUndo를 비우기 때문.
    btn.onclick = function () {
      clearTimeout(toastTimer);
      toastEl.hidden = true;
      if (onAction) onAction();
      pendingUndo = null;
    };
    toastEl.hidden = false;
    toastTimer = setTimeout(hideToast, actionLabel ? UNDO_MS : 3000);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastEl.hidden = true;
    pendingUndo = null;
  }

  // ---------- 테마 ----------
  function systemDark() { return matchMedia('(prefers-color-scheme: dark)').matches; }

  /** 시스템 → (지금과 반대) → (나머지) → 시스템. 첫 클릭부터 화면이 실제로 바뀐다. */
  function nextTheme() {
    var first = systemDark() ? 'light' : 'dark';
    var second = systemDark() ? 'dark' : 'light';
    if (prefs.theme === 'system') return first;
    if (prefs.theme === first) return second;
    return 'system';
  }

  function applyTheme() {
    var resolved = prefs.theme === 'system' ? (systemDark() ? 'dark' : 'light') : prefs.theme;
    document.documentElement.dataset.theme = resolved;
    $('theme-icon').setAttribute('href', THEME_ICON[prefs.theme]);
    $('theme-btn').setAttribute('aria-label', '테마: ' + THEME_LABEL[prefs.theme] + ' (클릭해서 변경)');
    $('theme-btn').title = '테마: ' + THEME_LABEL[prefs.theme];
  }

  // ---------- 내보내기 / 가져오기 ----------
  function exportJson() {
    var payload = { app: 'todo', version: 1, exportedAt: new Date().toISOString(), items: items };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'todo-' + ymd(new Date()) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    showToast(items.length + '개 항목을 내보냈습니다.');
  }

  function importJson(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var incoming;
      try {
        var parsed = JSON.parse(String(reader.result));
        incoming = Array.isArray(parsed) ? parsed : parsed && parsed.items;
      } catch (e) { /* 아래에서 처리 */ }
      if (!Array.isArray(incoming)) {
        showToast('불러올 수 없는 파일입니다.');
        return;
      }
      var existing = new Set(items.map(function (it) { return it.id; }));
      var added = 0;
      incoming.map(normalize).forEach(function (it) {
        if (!it) return;
        if (existing.has(it.id)) it.id = uid();
        existing.add(it.id);
        items.push(it);
        added++;
      });
      refresh();
      showToast(added ? added + '개 항목을 가져왔습니다.' : '가져올 항목이 없습니다.');
    };
    reader.onerror = function () { showToast('파일을 읽지 못했습니다.'); };
    reader.readAsText(file);
  }

  // ---------- 이벤트 ----------
  newForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!newInput.value.trim()) { newInput.focus(); return; }
    addItem(newInput.value, newPriority.value, newDue.value);
    newInput.value = '';
    newDue.value = '';
    newPriority.value = 'normal';
    newInput.focus();
  });

  searchInput.addEventListener('input', function () { query = searchInput.value; render(); });
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && searchInput.value) {
      e.stopPropagation();
      searchInput.value = '';
      query = '';
      render();
    }
  });

  document.querySelectorAll('.chip').forEach(function (chip) {
    chip.addEventListener('click', function () { setFilter(chip.dataset.filter); });
  });

  function setFilter(filter) {
    prefs.filter = filter;
    savePrefs();
    document.querySelectorAll('.chip').forEach(function (c) {
      c.setAttribute('aria-pressed', String(c.dataset.filter === filter));
    });
    render();
  }

  sortSelect.addEventListener('change', function () {
    prefs.sort = sortSelect.value;
    savePrefs();
    render();
  });

  listEl.addEventListener('change', function (e) {
    if (e.target.classList.contains('check')) {
      toggleItem(e.target.closest('.item').dataset.id);
    }
  });

  listEl.addEventListener('click', function (e) {
    var row = e.target.closest('.item');
    if (!row) return;
    var id = row.dataset.id;
    if (e.target.closest('.btn-edit')) {
      openEdit(id);
    } else if (e.target.closest('.btn-del')) {
      var it = byId(id);
      removeItems([id], '삭제됨: ' + (it ? it.title : ''));
    } else if (e.target.closest('.edit-cancel')) {
      closeEdit();
      render();
    }
  });

  listEl.addEventListener('dblclick', function (e) {
    var row = e.target.closest('.item');
    if (!row || row.classList.contains('editing') || e.target.closest('.check')) return;
    openEdit(row.dataset.id);
  });

  listEl.addEventListener('submit', function (e) {
    e.preventDefault();
    var row = e.target.closest('.item');
    var it = byId(row.dataset.id);
    if (!it) return;
    var title = row.querySelector('.edit-title').value.trim().slice(0, MAX_LEN);
    if (!title) {
      removeItems([it.id], '내용이 비어 삭제되었습니다');
      return;
    }
    it.title = title;
    it.priority = row.querySelector('.edit-prio').value;
    it.due = row.querySelector('.edit-due').value || null;
    closeEdit();
    refresh();
    announce('수정됨: ' + it.title);
  });

  listEl.addEventListener('keydown', function (e) {
    var row = e.target.closest('.item');
    if (!row) return;
    if (e.key === 'Escape' && row.classList.contains('editing')) {
      e.stopPropagation();
      closeEdit();
      render();
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      moveItem(row.dataset.id, e.key === 'ArrowUp' ? -1 : 1);
    }
  });

  // 드래그 정렬
  listEl.addEventListener('dragstart', function (e) {
    var row = e.target.closest('.item');
    if (!row || prefs.sort !== 'manual') { e.preventDefault(); return; }
    dragId = row.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    requestAnimationFrame(function () { row.classList.add('dragging'); });
  });

  listEl.addEventListener('dragover', function (e) {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    var dragged = listEl.querySelector('.item.dragging');
    if (!dragged) return;
    var after = null;
    var rows = listEl.querySelectorAll('.item:not(.dragging)');
    for (var i = 0; i < rows.length; i++) {
      var box = rows[i].getBoundingClientRect();
      if (e.clientY > box.top + box.height / 2) after = rows[i];
    }
    listEl.insertBefore(dragged, after ? after.nextSibling : listEl.firstChild);
  });

  listEl.addEventListener('drop', function (e) { e.preventDefault(); });

  listEl.addEventListener('dragend', function () {
    var dragged = listEl.querySelector('.item.dragging');
    if (dragged) dragged.classList.remove('dragging');
    if (!dragId) return;
    dragId = null;
    commitDomOrder();
    refresh();
  });

  $('toggle-all').addEventListener('click', function () {
    var makeDone = items.some(function (it) { return !it.done; });
    items.forEach(function (it) {
      it.done = makeDone;
      it.completedAt = makeDone ? (it.completedAt || Date.now()) : null;
    });
    refresh();
    announce(makeDone ? '모든 항목을 완료 처리했습니다' : '모든 항목의 완료를 해제했습니다');
  });

  $('clear-done').addEventListener('click', function () {
    var ids = items.filter(function (it) { return it.done; }).map(function (it) { return it.id; });
    if (ids.length) removeItems(ids, '완료 항목 ' + ids.length + '개를 삭제했습니다');
  });

  $('export-btn').addEventListener('click', exportJson);
  $('import-btn').addEventListener('click', function () { $('import-file').click(); });
  $('import-file').addEventListener('change', function (e) {
    if (e.target.files && e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = '';
  });

  $('theme-btn').addEventListener('click', function () {
    prefs.theme = nextTheme();
    savePrefs();
    applyTheme();
    announce('테마: ' + THEME_LABEL[prefs.theme]);
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    if (prefs.theme === 'system') applyTheme();
  });

  $('help-btn').addEventListener('click', function () {
    if (helpDialog.open) helpDialog.close(); else helpDialog.showModal();
  });

  // 전역 단축키 (입력 중일 때는 동작하지 않는다)
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var el = e.target;
    var typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

    if (e.key === '?' ) {
      if (typing) return;
      e.preventDefault();
      if (helpDialog.open) helpDialog.close(); else helpDialog.showModal();
      return;
    }
    if (e.key === 'Escape' && !typing) { hideToast(); return; }
    if (typing) return;

    if (e.key === '/') { e.preventDefault(); searchInput.focus(); searchInput.select(); }
    else if (e.key === 'n' || e.key === 'N' || e.key === 'ㅜ') { e.preventDefault(); newInput.focus(); }
    else if (e.key === '1') setFilter('all');
    else if (e.key === '2') setFilter('active');
    else if (e.key === '3') setFilter('done');
  });

  // ---------- 시작 ----------
  load();
  applyTheme();
  sortSelect.value = prefs.sort;
  document.querySelectorAll('.chip').forEach(function (c) {
    c.setAttribute('aria-pressed', String(c.dataset.filter === prefs.filter));
  });
  $('today').textContent = new Date().toLocaleDateString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });
  render();
  newInput.focus();
})();

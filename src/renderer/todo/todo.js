'use strict';
// Renderer for a single to-do list card. `api` is the contextBridge global.
// Reuses the card chrome (header/title/resize/collapse) from section.js patterns
// and adds a purpose-built task list, quick-add parser, and detail editor.
const id = new URLSearchParams(location.search).get('id');

const el = {
  body: document.body,
  card: document.getElementById('card'),
  header: document.getElementById('header'),
  chev: document.getElementById('chev'),
  title: document.getElementById('title'),
  titleInput: document.getElementById('title-input'),
  badge: document.getElementById('badge'),
  progressFill: document.getElementById('progress-fill'),
  qa: document.getElementById('qa'),
  qaAdd: document.getElementById('qa-add'),
  qaPreview: document.getElementById('qa-preview'),
  fchips: document.getElementById('fchips'),
  sortBtn: document.getElementById('sort-btn'),
  sortLabel: document.getElementById('sort-label'),
  list: document.getElementById('list'),
  completedGroup: document.getElementById('completed-group'),
  completedToggle: document.getElementById('completed-toggle'),
  completedLabel: document.getElementById('completed-label'),
  completedList: document.getElementById('completed-list'),
  empty: document.getElementById('empty'),
  emptyMsg: document.getElementById('empty-msg'),
};

let state = null;      // section record (incl. todo config + todos)
let settings = null;   // global settings
const expanded = new Set(); // todo ids with the detail editor open
let editing = null;    // todo id currently inline-editing text (suppress re-render)
let dragId = null;

const PRIORITY_ORDER = { high: 0, med: 1, low: 2, none: 3 };
const SORT_LABEL = { manual: 'Manual', due: 'Due date', priority: 'Priority', created: 'Created', alpha: 'A–Z' };
const REMIND_OFFSETS = [
  { v: 'off', label: 'No reminder' },
  { v: '0', label: 'At due time' },
  { v: '5', label: '5 min before' },
  { v: '10', label: '10 min before' },
  { v: '30', label: '30 min before' },
  { v: '60', label: '1 hour before' },
  { v: '1440', label: '1 day before' },
];

// ---------- boot ----------
(async function init() {
  settings = await api.getSettings();
  applySettings(settings);
  state = await api.getSection(id);
  if (!state) return;
  ensureTodoShape();
  render();
  wireEvents();
})();

function ensureTodoShape() {
  if (!state.todo) state.todo = { sort: 'manual', filter: 'active', tagFilter: null, showCompleted: true, tags: [] };
  if (!Array.isArray(state.todos)) state.todos = [];
  if (!Array.isArray(state.todo.tags)) state.todo.tags = [];
}

// ---------- settings / theme (mirrors section.js) ----------
function applySettings(s) {
  settings = s;
  const root = document.documentElement.style;
  root.setProperty('--accent', s.accent);
  root.setProperty('--card-opacity', String(s.opacity));
  root.setProperty('--radius', s.cornerRadius + 'px');
  el.body.classList.toggle('locked', !!s.locked);
  const theme = s.theme === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : s.theme;
  el.body.classList.toggle('theme-light', theme === 'light');
  el.body.classList.toggle('theme-dark', theme !== 'light');
}

// ---------- helpers ----------
function cfg() { return state.todo || {}; }
function tagById(tid) { return (cfg().tags || []).find((t) => t.id === tid) || null; }
function activeTodos() { return (state.todos || []).filter((t) => !t.done); }

function passesTag(t) {
  const tf = cfg().tagFilter;
  return !tf || (t.tags || []).includes(tf);
}

function sortComparator() {
  const sort = cfg().sort || 'manual';
  return (a, b) => {
    switch (sort) {
      case 'due': {
        const av = a.due == null ? Infinity : a.due;
        const bv = b.due == null ? Infinity : b.due;
        return av - bv || (a.order || 0) - (b.order || 0);
      }
      case 'priority':
        return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || (a.order || 0) - (b.order || 0);
      case 'created':
        return (a.createdAt || 0) - (b.createdAt || 0);
      case 'alpha':
        return String(a.text).localeCompare(String(b.text));
      case 'manual':
      default:
        return (a.order || 0) - (b.order || 0);
    }
  };
}

// ---------- render ----------
function render() {
  if (editing) return; // don't blow away an in-progress inline edit
  el.title.textContent = state.title || 'To-Do';
  el.body.classList.toggle('collapsed', !!state.collapsed);

  const all = state.todos || [];
  const done = all.filter((t) => t.done);
  const active = all.filter((t) => !t.done);
  el.badge.hidden = active.length === 0;
  el.badge.textContent = String(active.length);
  const pct = all.length ? Math.round((done.length / all.length) * 100) : 0;
  el.progressFill.style.width = pct + '%';

  // filter chips
  const filter = cfg().filter || 'active';
  for (const c of el.fchips.children) c.classList.toggle('active', c.dataset.filter === filter);
  el.sortLabel.textContent = SORT_LABEL[cfg().sort] || 'Manual';

  const cmp = sortComparator();
  let mainItems, showCompletedGroup = false;
  if (filter === 'completed') {
    mainItems = done.filter(passesTag).sort(cmp);
  } else if (filter === 'all') {
    // Everything in one flat list — open and completed intermingled by the sort.
    mainItems = all.filter(passesTag).sort(cmp);
  } else {
    // Active: open tasks on top, with a collapsible "Completed" drawer beneath —
    // so checking a task off drops it straight into Completed without needing to
    // switch filters first.
    mainItems = active.filter(passesTag).sort(cmp);
    showCompletedGroup = done.filter(passesTag).length > 0;
  }

  el.list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const t of mainItems) frag.appendChild(makeTask(t));
  el.list.appendChild(frag);

  // completed group
  if (showCompletedGroup) {
    el.completedGroup.hidden = false;
    const doneItems = done.filter(passesTag).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    el.completedLabel.textContent = `Completed (${doneItems.length})`;
    const collapsed = cfg().showCompleted === false;
    el.completedGroup.classList.toggle('collapsed', collapsed);
    el.completedList.innerHTML = '';
    const cf = document.createDocumentFragment();
    for (const t of doneItems) cf.appendChild(makeTask(t));
    el.completedList.appendChild(cf);
  } else {
    el.completedGroup.hidden = true;
  }

  // empty state
  const visible = mainItems.length + (showCompletedGroup ? 1 : 0);
  if (all.length === 0) {
    el.empty.hidden = false; el.emptyMsg.textContent = 'All clear — add your first task';
  } else if (mainItems.length === 0 && !showCompletedGroup) {
    el.empty.hidden = false;
    el.emptyMsg.textContent = filter === 'active'
      ? 'All done! 🎉'
      : (filter === 'completed' ? 'Nothing completed yet' : 'No tasks match this filter');
  } else {
    el.empty.hidden = true;
  }
}

function svgCheck() {
  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';
}

function makeTask(t) {
  const li = document.createElement('li');
  li.className = 'task' + (t.done ? ' done' : '') + (t.priority && t.priority !== 'none' ? ' prio-' + t.priority : '')
    + (expanded.has(t.id) ? ' expanded' : '');
  li.dataset.tid = t.id;

  // drag handle
  const handle = document.createElement('span');
  handle.className = 'thandle'; handle.draggable = true; handle.title = 'Drag to reorder';
  // priority bar
  const prio = document.createElement('span'); prio.className = 'tprio';
  // checkbox
  const check = document.createElement('button');
  check.className = 'tcheck'; check.title = 'Toggle complete'; check.innerHTML = svgCheck();

  // main
  const main = document.createElement('div'); main.className = 'tmain';
  const text = document.createElement('div'); text.className = 'ttext'; text.textContent = t.text || '(untitled)';
  main.appendChild(text);

  const meta = document.createElement('div'); meta.className = 'tmeta';
  if (t.done && t.completedAt) meta.appendChild(completedChip(t));
  if (t.due != null) {
    const d = dueChip(t); meta.appendChild(d);
  }
  if (t.remindAt != null && !t.done) {
    const bell = chip('bell', bellSvg() + reminderShort(t));
    meta.appendChild(bell);
  }
  if (t.recurrence) meta.appendChild(chip('sub', '↻ ' + recurrenceShort(t.recurrence)));
  if ((t.subtasks || []).length) {
    const dn = t.subtasks.filter((s) => s.done).length;
    meta.appendChild(chip('sub', `☑ ${dn}/${t.subtasks.length}`));
  }
  for (const tid of t.tags || []) {
    const tag = tagById(tid); if (!tag) continue;
    const c = document.createElement('span'); c.className = 'ttag'; c.textContent = tag.name;
    c.style.background = tag.color; meta.appendChild(c);
  }
  if (meta.children.length) main.appendChild(meta);

  // expand caret
  const exp = document.createElement('button');
  exp.className = 'texpand'; exp.title = 'Details';
  exp.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  li.append(handle, prio, check, main, exp);

  if (expanded.has(t.id)) li.appendChild(makeDetail(t));
  return li;
}

function chip(cls, html) {
  const c = document.createElement('span'); c.className = 'tchip ' + cls; c.innerHTML = html; return c;
}
function bellSvg() {
  return '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5a3 3 0 0 0-3 3c0 2.4-.8 3.6-1.3 4.2-.3.3 0 .8.4.8h7.8c.4 0 .7-.5.4-.8C11.8 8.1 11 6.9 11 4.5a3 3 0 0 0-3-3zM6.6 11a1.4 1.4 0 0 0 2.8 0z"/></svg>';
}

function dueChip(t) {
  const now = new Date();
  const d = new Date(t.due);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((day - today) / 86400000);
  let label;
  if (diffDays === 0) label = 'Today';
  else if (diffDays === 1) label = 'Tomorrow';
  else if (diffDays === -1) label = 'Yesterday';
  else label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (t.dueHasTime) label += ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  let cls = 'due';
  const overdue = (t.dueHasTime ? d.getTime() : day.getTime() + 86400000 - 1) < now.getTime();
  if (!t.done && overdue) cls += ' overdue';
  else if (diffDays === 0) cls += ' today';
  else if (diffDays > 0 && diffDays <= 2) cls += ' soon';
  const c = document.createElement('span'); c.className = 'tchip ' + cls;
  c.innerHTML = calSvg() + '<span>' + escapeHtml(label) + '</span>';
  return c;
}
function calSvg() {
  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/></svg>';
}

// "Completed" stamp for done tasks — date + time, relative for today, with the
// year only when it isn't the current one. Full timestamp on hover.
function completedChip(t) {
  const d = new Date(t.completedAt);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  let label;
  if (d.toDateString() === now.toDateString()) {
    label = 'Today ' + time;
  } else {
    const dateOpts = d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' };
    label = d.toLocaleDateString(undefined, dateOpts) + ', ' + time;
  }
  const c = chip('done', svgCheck() + '<span>' + escapeHtml(label) + '</span>');
  c.title = 'Completed ' + d.toLocaleString();
  return c;
}
function reminderShort(t) {
  const d = new Date(t.remindAt);
  return '<span>' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + '</span>';
}
function recurrenceShort(rec) {
  const map = { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', monthly: 'Monthly' };
  return map[rec.freq] || 'Repeats';
}

// ---------- detail editor ----------
function makeDetail(t) {
  const box = document.createElement('div'); box.className = 'detail';
  box.addEventListener('click', (e) => e.stopPropagation());

  // priority
  const prow = drow('Priority');
  const pseg = document.createElement('div'); pseg.className = 'dseg';
  for (const [val, lab, pc] of [['none', 'None', ''], ['low', 'Low', 'p-low'], ['med', 'Med', 'p-med'], ['high', 'High', 'p-high']]) {
    const b = document.createElement('button');
    b.textContent = lab;
    if ((t.priority || 'none') === val) b.className = 'on ' + pc;
    b.addEventListener('click', () => api.patchTodo(id, t.id, { priority: val }));
    pseg.appendChild(b);
  }
  prow.appendChild(pseg); box.appendChild(prow);

  // due date + time
  const durow = drow('Due');
  const dateIn = document.createElement('input'); dateIn.type = 'date';
  const timeIn = document.createElement('input'); timeIn.type = 'time';
  if (t.due != null) {
    const d = new Date(t.due);
    dateIn.value = toDateInput(d);
    if (t.dueHasTime) timeIn.value = toTimeInput(d);
  }
  const commitDue = () => {
    if (!dateIn.value) { api.patchTodo(id, t.id, { due: null, dueHasTime: false, remindAt: null }); return; }
    const hasTime = !!timeIn.value;
    const d = fromInputs(dateIn.value, timeIn.value);
    const oldOffset = (t.due != null && t.remindAt != null) ? t.due - t.remindAt : null;
    const patch = { due: d.getTime(), dueHasTime: hasTime };
    if (oldOffset != null) patch.remindAt = d.getTime() - oldOffset;
    api.patchTodo(id, t.id, patch);
  };
  dateIn.addEventListener('change', commitDue);
  timeIn.addEventListener('change', commitDue);
  durow.append(dateIn, timeIn);
  if (t.due != null) {
    const clr = document.createElement('button'); clr.className = 'linkbtn'; clr.textContent = 'Clear';
    clr.addEventListener('click', () => api.patchTodo(id, t.id, { due: null, dueHasTime: false, remindAt: null }));
    durow.appendChild(clr);
  }
  box.appendChild(durow);

  // reminder
  const rrow = drow('Remind');
  const rsel = document.createElement('select');
  const curOffset = reminderOffsetValue(t);
  for (const o of REMIND_OFFSETS) {
    const opt = document.createElement('option'); opt.value = o.v; opt.textContent = o.label;
    if (o.v === curOffset) opt.selected = true;
    rsel.appendChild(opt);
  }
  rsel.disabled = t.due == null;
  rsel.addEventListener('change', () => setReminderOffset(t, rsel.value));
  rrow.appendChild(rsel);
  if (t.due == null) { const hint = document.createElement('span'); hint.className = 'dlabel'; hint.style.textTransform = 'none'; hint.textContent = 'set a due date first'; rrow.appendChild(hint); }
  box.appendChild(rrow);

  // recurrence
  const rcrow = drow('Repeat');
  const rcsel = document.createElement('select');
  for (const [val, lab] of [['none', 'Does not repeat'], ['daily', 'Daily'], ['weekdays', 'Every weekday'], ['weekly', 'Weekly'], ['monthly', 'Monthly']]) {
    const opt = document.createElement('option'); opt.value = val; opt.textContent = lab;
    if ((t.recurrence && t.recurrence.freq) === val || (!t.recurrence && val === 'none')) opt.selected = true;
    rcsel.appendChild(opt);
  }
  rcsel.addEventListener('change', () => {
    const v = rcsel.value;
    api.patchTodo(id, t.id, { recurrence: v === 'none' ? null : { freq: v, interval: 1 } });
  });
  rcrow.appendChild(rcsel); box.appendChild(rcrow);

  // tags
  const tgrow = drow('Tags');
  const tags = document.createElement('div'); tags.className = 'tags-edit';
  for (const tag of cfg().tags || []) {
    const b = document.createElement('button');
    b.className = 'tag-opt' + ((t.tags || []).includes(tag.id) ? ' on' : '');
    b.textContent = tag.name; b.style.background = tag.color;
    b.addEventListener('click', () => {
      const has = (t.tags || []).includes(tag.id);
      const next = has ? (t.tags || []).filter((x) => x !== tag.id) : [...(t.tags || []), tag.id];
      api.patchTodo(id, t.id, { tags: next });
    });
    tags.appendChild(b);
  }
  const newTag = document.createElement('input'); newTag.className = 'tag-new'; newTag.placeholder = '+ tag';
  newTag.addEventListener('keydown', async (e) => {
    e.stopPropagation();
    if (e.key !== 'Enter' || !newTag.value.trim()) return;
    const color = TAG_COLORS[(cfg().tags || []).length % TAG_COLORS.length];
    const tag = await api.addTag(id, newTag.value.trim(), color);
    if (tag && tag.id) await api.patchTodo(id, t.id, { tags: [...(t.tags || []), tag.id] });
  });
  tags.appendChild(newTag);
  tgrow.appendChild(tags); box.appendChild(tgrow);

  // subtasks
  const srow = drow('Subtasks');
  const subs = document.createElement('div'); subs.className = 'subs';
  for (const s of t.subtasks || []) subs.appendChild(makeSub(t, s));
  const addSub = document.createElement('input'); addSub.className = 'sub-add'; addSub.placeholder = '+ add subtask';
  addSub.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key !== 'Enter' || !addSub.value.trim()) return;
    const next = [...(t.subtasks || []), { id: uid(), text: addSub.value.trim(), done: false }];
    addSub.value = '';
    api.patchTodo(id, t.id, { subtasks: next });
  });
  subs.appendChild(addSub);
  srow.appendChild(subs); box.appendChild(srow);

  // notes
  const nrow = document.createElement('div'); nrow.className = 'drow';
  const notes = document.createElement('textarea'); notes.className = 'notes'; notes.placeholder = 'Notes…';
  notes.value = t.notes || '';
  notes.addEventListener('keydown', (e) => e.stopPropagation());
  notes.addEventListener('blur', () => { if (notes.value !== (t.notes || '')) api.patchTodo(id, t.id, { notes: notes.value }); });
  nrow.appendChild(notes); box.appendChild(nrow);

  // delete
  const frow = document.createElement('div'); frow.className = 'drow';
  const del = document.createElement('button'); del.className = 'linkbtn danger'; del.textContent = 'Delete task';
  del.addEventListener('click', () => { expanded.delete(t.id); api.removeTodo(id, t.id); });
  frow.appendChild(del); box.appendChild(frow);

  return box;
}

function makeSub(t, s) {
  const row = document.createElement('div'); row.className = 'sub' + (s.done ? ' done' : '');
  const chk = document.createElement('button'); chk.className = 'scheck'; chk.innerHTML = svgCheck();
  chk.addEventListener('click', () => {
    const next = (t.subtasks || []).map((x) => x.id === s.id ? { ...x, done: !x.done } : x);
    api.patchTodo(id, t.id, { subtasks: next });
  });
  const txt = document.createElement('span'); txt.className = 'stext'; txt.textContent = s.text;
  const del = document.createElement('button'); del.className = 'sdel'; del.textContent = '✕';
  del.addEventListener('click', () => {
    const next = (t.subtasks || []).filter((x) => x.id !== s.id);
    api.patchTodo(id, t.id, { subtasks: next });
  });
  row.append(chk, txt, del);
  return row;
}

function drow(label) {
  const r = document.createElement('div'); r.className = 'drow';
  const l = document.createElement('span'); l.className = 'dlabel'; l.textContent = label;
  r.appendChild(l); return r;
}

// reminder offset (minutes-before-due) currently stored, as a select value
function reminderOffsetValue(t) {
  if (t.remindAt == null) return 'off';
  if (t.due == null) return '0';
  const base = reminderBase(t.due, t.dueHasTime);
  const mins = Math.round((base - t.remindAt) / 60000);
  const match = ['0', '5', '10', '30', '60', '1440'].find((v) => Number(v) === mins);
  return match || '0';
}
function reminderBase(due, dueHasTime) {
  if (dueHasTime) return due;
  const d = new Date(due); d.setHours(9, 0, 0, 0); return d.getTime(); // all-day → 9:00 AM
}
function setReminderOffset(t, val) {
  if (val === 'off') { api.patchTodo(id, t.id, { remindAt: null }); return; }
  const base = reminderBase(t.due, t.dueHasTime);
  api.patchTodo(id, t.id, { remindAt: base - Number(val) * 60000 });
}

// ---------- quick add ----------
const TAG_COLORS = ['#6ea8fe', '#7ee7c4', '#f5a623', '#e574c4', '#b98cff', '#67d0e5'];
const WEEKDAYS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };

function parseQuickAdd(raw) {
  let s = ' ' + raw.trim() + ' ';
  let priority = 'none';
  const tagNames = [];
  let due = null, dueHasTime = false;

  // priority
  if (/\s!!\s/.test(s)) { priority = 'high'; s = s.replace(/\s!!\s/, ' '); }
  s = s.replace(/\s!(high|hi|h)\s/i, () => { priority = 'high'; return ' '; });
  s = s.replace(/\s!(med|mid|m)\s/i, () => { if (priority === 'none') priority = 'med'; return ' '; });
  s = s.replace(/\s!(low|lo|l)\s/i, () => { if (priority === 'none') priority = 'low'; return ' '; });

  // tags
  s = s.replace(/\s#([\p{L}0-9_-]+)/giu, (m, name) => { tagNames.push(name); return ' '; });

  // time
  let hours = null, mins = 0;
  s = s.replace(/\s(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s/i, (m, h, mm, ap) => {
    hours = parseInt(h, 10) % 12; if (/pm/i.test(ap)) hours += 12; mins = mm ? parseInt(mm, 10) : 0; dueHasTime = true; return ' ';
  });
  if (hours === null) s = s.replace(/\s(\d{1,2}):(\d{2})\s/, (m, h, mm) => { hours = parseInt(h, 10); mins = parseInt(mm, 10); dueHasTime = true; return ' '; });
  if (hours === null && /\stonight\s/i.test(s)) { hours = 20; dueHasTime = true; s = s.replace(/\stonight\s/i, ' '); }
  if (hours === null && /\snoon\s/i.test(s)) { hours = 12; dueHasTime = true; s = s.replace(/\snoon\s/i, ' '); }

  // date
  let date = null;
  const now = new Date();
  if (/\stoday\s/i.test(s)) { date = new Date(now); s = s.replace(/\stoday\s/i, ' '); }
  else if (/\s(tomorrow|tmr|tmrw)\s/i.test(s)) { date = new Date(now); date.setDate(date.getDate() + 1); s = s.replace(/\s(tomorrow|tmr|tmrw)\s/i, ' '); }
  else {
    const wm = s.match(/\s(next\s+)?(sun|sunday|mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)\s/i);
    if (wm) {
      const wd = WEEKDAYS[wm[2].toLowerCase()];
      date = new Date(now);
      let delta = (wd - date.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      if (wm[1]) delta += 7;
      date.setDate(date.getDate() + delta);
      s = s.replace(wm[0], ' ');
    } else {
      const inm = s.match(/\sin\s+(\d{1,3})\s+(day|days|week|weeks)\s/i);
      if (inm) { date = new Date(now); date.setDate(date.getDate() + parseInt(inm[1], 10) * (/week/i.test(inm[2]) ? 7 : 1)); s = s.replace(inm[0], ' '); }
      else {
        const dm = s.match(/\s(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s/);
        if (dm) {
          const mo = parseInt(dm[1], 10) - 1, dd = parseInt(dm[2], 10);
          let yr = dm[3] ? parseInt(dm[3], 10) : now.getFullYear();
          if (yr < 100) yr += 2000;
          date = new Date(yr, mo, dd);
          s = s.replace(dm[0], ' ');
        }
      }
    }
  }

  if (date && !dueHasTime) { date.setHours(0, 0, 0, 0); due = date.getTime(); }
  else if (dueHasTime) {
    const d = date ? date : new Date(now);
    d.setHours(hours, mins, 0, 0);
    if (!date && d.getTime() < now.getTime()) d.setDate(d.getDate() + 1);
    due = d.getTime();
  }

  const text = s.replace(/\s{2,}/g, ' ').trim();
  return { text: text || raw.trim(), priority, due, dueHasTime, tagNames };
}

function renderPreview(raw) {
  if (!raw.trim()) { el.qaPreview.hidden = true; el.qaPreview.innerHTML = ''; return; }
  const p = parseQuickAdd(raw);
  const chips = [];
  if (p.priority !== 'none') chips.push(`<span class="pchip prio-${p.priority}">! ${p.priority}</span>`);
  if (p.due != null) {
    const d = new Date(p.due);
    let lbl = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (p.dueHasTime) lbl += ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    chips.push(`<span class="pchip due">📅 ${escapeHtml(lbl)}</span>`);
  }
  for (const n of p.tagNames) chips.push(`<span class="pchip">#${escapeHtml(n)}</span>`);
  if (!chips.length) { el.qaPreview.hidden = true; el.qaPreview.innerHTML = ''; return; }
  el.qaPreview.hidden = false;
  el.qaPreview.innerHTML = chips.join('');
}

async function submitQuickAdd() {
  const raw = el.qa.value;
  if (!raw.trim()) return;
  const p = parseQuickAdd(raw);
  el.qa.value = '';
  el.qaPreview.hidden = true; el.qaPreview.innerHTML = '';

  // resolve tag names -> ids (create missing)
  const tagIds = [];
  for (const name of p.tagNames) {
    let tag = (cfg().tags || []).find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!tag) {
      const color = TAG_COLORS[(cfg().tags || []).length % TAG_COLORS.length];
      tag = await api.addTag(id, name, color);
      if (tag && tag.id) { state.todo.tags = [...(cfg().tags || []), tag]; }
    }
    if (tag && tag.id) tagIds.push(tag.id);
  }

  const fields = { priority: p.priority, due: p.due, dueHasTime: p.dueHasTime, tags: tagIds };
  if (p.due != null && p.dueHasTime && settings && settings.remindersEnabled) {
    fields.remindAt = p.due - (settings.reminderLeadMinutes || 0) * 60000;
  }
  await api.addTodo(id, p.text, fields);
}

// ---------- events ----------
function wireEvents() {
  el.chev.addEventListener('click', toggleCollapse);
  el.menuBtn = document.getElementById('menu-btn');
  el.menuBtn.addEventListener('click', () => api.headerMenu(id));
  el.header.addEventListener('contextmenu', (e) => { e.preventDefault(); api.headerMenu(id); });
  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) settingsBtn.addEventListener('click', () => api.openSettings());
  el.title.addEventListener('dblclick', startTitleRename);

  // quick add
  el.qa.addEventListener('input', () => renderPreview(el.qa.value));
  el.qa.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitQuickAdd(); } if (e.key === 'Escape') { el.qa.value = ''; renderPreview(''); } });
  el.qaAdd.addEventListener('click', submitQuickAdd);

  // filters
  el.fchips.addEventListener('click', (e) => {
    const b = e.target.closest('.fchip'); if (!b) return;
    api.setTodoConfig(id, { filter: b.dataset.filter });
  });
  el.sortBtn.addEventListener('click', () => api.headerMenu(id)); // sort lives in the header menu
  el.completedToggle.addEventListener('click', () => api.setTodoConfig(id, { showCompleted: !(cfg().showCompleted !== false) }));

  // list interactions (delegation)
  el.body.addEventListener('click', onListClick);
  el.list.addEventListener('dragstart', onDragStart);
  el.list.addEventListener('dragover', onDragOver);
  el.list.addEventListener('drop', onDrop);
  el.list.addEventListener('dragend', onDragEnd);

  setupResize();

  // main -> renderer
  api.onState((s) => { if (s && s.id === id) { state = s; ensureTodoShape(); render(); } });
  api.onSettings((s) => applySettings(s));
  api.onLock((locked) => el.body.classList.toggle('locked', !!locked));
  api.onUiAction((a) => {
    if (a.type === 'renameSection') startTitleRename();
    else if (a.type === 'focusAddTodo') { el.qa.focus(); }
  });
  api.onTodoHighlight((tid) => highlightTask(tid));

  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (settings && settings.theme === 'auto') applySettings(settings);
  });
}

function onListClick(e) {
  const li = e.target.closest('.task'); if (!li) return;
  const tid = li.dataset.tid;
  const t = (state.todos || []).find((x) => x.id === tid); if (!t) return;

  if (e.target.closest('.tcheck')) {
    li.classList.toggle('done'); // optimistic
    api.toggleTodo(id, tid);
    return;
  }
  if (e.target.closest('.texpand')) {
    if (expanded.has(tid)) expanded.delete(tid); else expanded.add(tid);
    render();
    return;
  }
  if (e.target.closest('.ttext') && !li.classList.contains('done')) {
    startTextEdit(li, t);
  }
}

function startTextEdit(li, t) {
  editing = t.id;
  const textEl = li.querySelector('.ttext');
  const input = document.createElement('input');
  input.className = 'ttext-input'; input.value = t.text || '';
  textEl.replaceWith(input);
  input.focus(); input.select();
  const finish = (save) => {
    editing = null;
    const v = input.value.trim();
    if (save && v && v !== t.text) api.patchTodo(id, t.id, { text: v });
    else render();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ---------- drag reorder ----------
function onDragStart(e) {
  const handle = e.target.closest('.thandle'); if (!handle) { e.preventDefault(); return; }
  const li = handle.closest('.task'); if (!li) return;
  dragId = li.dataset.tid;
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', dragId); } catch (_) { /* ignore */ }
}
function onDragOver(e) {
  if (!dragId) return;
  e.preventDefault();
  const li = e.target.closest('.task'); if (!li || li.dataset.tid === dragId) return;
  clearDropMarks();
  const r = li.getBoundingClientRect();
  const after = (e.clientY - r.top) > r.height / 2;
  li.classList.add(after ? 'drop-after' : 'drop-before');
}
function onDrop(e) {
  if (!dragId) return;
  e.preventDefault();
  const li = e.target.closest('.task');
  const ids = [...el.list.querySelectorAll('.task')].map((n) => n.dataset.tid).filter((x) => x !== dragId);
  if (li && li.dataset.tid !== dragId) {
    const r = li.getBoundingClientRect();
    const after = (e.clientY - r.top) > r.height / 2;
    const idx = ids.indexOf(li.dataset.tid) + (after ? 1 : 0);
    ids.splice(idx, 0, dragId);
  } else {
    ids.push(dragId);
  }
  clearDropMarks();
  if (cfg().sort !== 'manual') api.setTodoConfig(id, { sort: 'manual' });
  api.reorderTodos(id, ids);
}
function onDragEnd() { clearDropMarks(); const d = el.list.querySelector('.dragging'); if (d) d.classList.remove('dragging'); dragId = null; }
function clearDropMarks() { for (const n of el.list.querySelectorAll('.drop-before,.drop-after')) n.classList.remove('drop-before', 'drop-after'); }

function highlightTask(tid) {
  const li = el.list.querySelector(`.task[data-tid="${CSS.escape(tid)}"]`)
    || el.completedList.querySelector(`.task[data-tid="${CSS.escape(tid)}"]`);
  if (!li) return;
  li.scrollIntoView({ block: 'nearest' });
  li.classList.remove('pulse'); void li.offsetWidth; li.classList.add('pulse');
}

// ---------- collapse / title (mirror section.js) ----------
function toggleCollapse() {
  const next = !state.collapsed;
  state.collapsed = next;
  el.body.classList.toggle('collapsed', next);
  api.setCollapsed(id, next);
}

function startTitleRename() {
  el.title.hidden = true;
  el.titleInput.hidden = false;
  el.titleInput.value = state.title || '';
  el.titleInput.focus();
  el.titleInput.select();
  const commit = (save) => {
    el.titleInput.hidden = true;
    el.title.hidden = false;
    el.titleInput.removeEventListener('keydown', onKey);
    el.titleInput.removeEventListener('blur', onBlur);
    if (save) {
      const v = el.titleInput.value.trim() || 'To-Do';
      state.title = v; el.title.textContent = v; api.setTitle(id, v);
    }
  };
  const onKey = (e) => { e.stopPropagation(); if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') commit(false); };
  const onBlur = () => commit(true);
  el.titleInput.addEventListener('keydown', onKey);
  el.titleInput.addEventListener('blur', onBlur);
}

// ---------- resize via edge/corner grips (copied from section.js) ----------
function setupResize() {
  for (const h of document.querySelectorAll('.rh')) {
    const dir = [...h.classList].find((c) => c !== 'rh') || '';
    h.addEventListener('pointerdown', (e) => onResizeStart(e, dir));
  }
}
async function onResizeStart(e, dir) {
  if (settings && settings.locked) return;
  e.preventDefault();
  const handle = e.currentTarget || e.target;
  try { handle.setPointerCapture(e.pointerId); } catch (_) { /* best-effort */ }
  const start = (await api.getBounds(id)) || state.bounds || { x: 0, y: 0, width: 320, height: 300 };
  const sx = e.screenX, sy = e.screenY;
  const grid = settings && settings.snapToGrid ? Math.max(2, settings.gridSize || 16) : 1;
  const MIN_W = 220, MIN_H = 160;
  const has = (d) => dir.includes(d);
  const compute = (ev) => {
    const dx = ev.screenX - sx, dy = ev.screenY - sy;
    let { x, y, width, height } = start;
    if (has('e')) width = start.width + dx;
    if (has('s')) height = start.height + dy;
    if (has('w')) width = start.width - dx;
    if (has('n')) height = start.height - dy;
    width = Math.max(MIN_W, snap(width, grid));
    height = Math.max(MIN_H, snap(height, grid));
    if (has('w')) x = start.x + (start.width - width);
    if (has('n')) y = start.y + (start.height - height);
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  };
  const onMove = (ev) => { const b = compute(ev); state.bounds = b; api.setBounds(id, b); };
  const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}
function snap(v, grid) { return grid > 1 ? Math.round(v / grid) * grid : v; }

// ---------- misc ----------
function toDateInput(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function toTimeInput(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fromInputs(dateStr, timeStr) {
  const [y, mo, da] = dateStr.split('-').map(Number);
  let hh = 0, mm = 0;
  if (timeStr) { const p = timeStr.split(':').map(Number); hh = p[0] || 0; mm = p[1] || 0; }
  return new Date(y, mo - 1, da, hh, mm, 0, 0);
}
function pad(n) { return String(n).padStart(2, '0'); }
function uid() { return 'sx-' + Math.random().toString(36).slice(2, 10); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

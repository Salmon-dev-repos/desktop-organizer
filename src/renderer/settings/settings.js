'use strict';
// `api` is the contextBridge global (window.api).
const $ = (id) => document.getElementById(id);

let settings = null;

(async function init() {
  settings = await api.getSettings();
  fill(settings);
  applyThemeClass(settings.theme);
  wire();
  renderSections();
  api.onSectionsChanged(renderSections);
  api.onSettings((s) => { settings = s; applyThemeClass(s.theme); });
})();

function fill(s) {
  $('theme').value = s.theme;
  $('accent').value = s.accent;
  $('opacity').value = s.opacity; $('opacity-val').textContent = Math.round(s.opacity * 100) + '%';
  $('radius').value = s.cornerRadius; $('radius-val').textContent = s.cornerRadius + 'px';
  $('iconSize').value = s.iconSize || 44; $('icon-val').textContent = (s.iconSize || 44) + 'px';
  $('showLabels').checked = s.showItemLabels;
  $('hideDesktopIcons').checked = s.hideDesktopIcons;
  $('locked').checked = s.locked;
  $('snapToGrid').checked = s.snapToGrid;
  $('gridSize').value = s.gridSize; $('grid-val').textContent = s.gridSize + 'px';
  $('embedInDesktop').checked = s.embedInDesktop;
  $('launchAtLogin').checked = s.launchAtLogin;
  $('hotkey').value = s.hotkeyToggleLock || '';
  $('remindersEnabled').checked = s.remindersEnabled !== false;
  $('reminderLeadMinutes').value = String(s.reminderLeadMinutes || 0);
  $('reminderSound').checked = !!s.reminderSound;
}

function applyThemeClass(theme) {
  const t = theme === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme;
  document.body.classList.toggle('theme-light', t === 'light');
  document.body.classList.toggle('theme-dark', t !== 'light');
}

async function update(patch) { settings = await api.updateSettings(patch); }

function wire() {
  $('close').addEventListener('click', () => window.close());

  $('theme').addEventListener('change', (e) => { update({ theme: e.target.value }); applyThemeClass(e.target.value); });
  $('accent').addEventListener('input', (e) => update({ accent: e.target.value }));
  $('opacity').addEventListener('input', (e) => { $('opacity-val').textContent = Math.round(e.target.value * 100) + '%'; update({ opacity: parseFloat(e.target.value) }); });
  $('radius').addEventListener('input', (e) => { $('radius-val').textContent = e.target.value + 'px'; update({ cornerRadius: parseInt(e.target.value, 10) }); });
  $('iconSize').addEventListener('input', (e) => { $('icon-val').textContent = e.target.value + 'px'; update({ iconSize: parseInt(e.target.value, 10) }); });
  $('showLabels').addEventListener('change', (e) => update({ showItemLabels: e.target.checked }));

  $('hideDesktopIcons').addEventListener('change', (e) => update({ hideDesktopIcons: e.target.checked }));
  $('locked').addEventListener('change', (e) => update({ locked: e.target.checked }));
  $('snapToGrid').addEventListener('change', (e) => update({ snapToGrid: e.target.checked }));
  $('gridSize').addEventListener('input', (e) => { $('grid-val').textContent = e.target.value + 'px'; update({ gridSize: parseInt(e.target.value, 10) }); });
  $('embedInDesktop').addEventListener('change', (e) => update({ embedInDesktop: e.target.checked }));
  $('launchAtLogin').addEventListener('change', (e) => update({ launchAtLogin: e.target.checked }));
  $('hotkey').addEventListener('change', (e) => update({ hotkeyToggleLock: e.target.value.trim() }));

  $('remindersEnabled').addEventListener('change', (e) => update({ remindersEnabled: e.target.checked }));
  $('reminderLeadMinutes').addEventListener('change', (e) => update({ reminderLeadMinutes: parseInt(e.target.value, 10) }));
  $('reminderSound').addEventListener('change', (e) => update({ reminderSound: e.target.checked }));

  $('add-todo').addEventListener('click', () => api.addSection('todo'));
  $('add-bucket').addEventListener('click', () => api.addSection('bucket'));
  $('add-portal').addEventListener('click', async () => {
    const folder = await api.pickFolder();
    if (!folder) return;
    const s = await api.addSection('portal');
    await api.setPortalFolder(s.id, folder);
    renderSections();
  });

  $('export').addEventListener('click', () => api.exportConfig());
  $('import').addEventListener('click', async () => { const ok = await api.importConfig(); if (ok) { settings = await api.getSettings(); fill(settings); renderSections(); } });
  $('reset').addEventListener('click', async () => { const ok = await api.resetConfig(); if (ok) { settings = await api.getSettings(); fill(settings); renderSections(); } });
}

async function renderSections() {
  const list = await api.listSections();
  const box = $('sections-list');
  box.innerHTML = '';
  if (!list.length) { const n = document.createElement('div'); n.className = 'none'; n.textContent = 'No sections yet — add one above.'; box.appendChild(n); return; }
  for (const s of list) {
    const row = document.createElement('div'); row.className = 'srow';
    const type = document.createElement('span'); type.className = 'stype';
    type.textContent = { portal: '🗂', recycle: '🗑', todo: '✅', bucket: '🗃' }[s.type] || '🗃';
    const title = document.createElement('span'); title.className = 'stitle'; title.textContent = s.title || '(untitled)';
    const tag = document.createElement('span'); tag.className = 'stag'; tag.textContent = s.type;
    const del = document.createElement('button'); del.className = 'sdel'; del.textContent = '✕'; del.title = 'Delete section';
    del.addEventListener('click', async () => { await api.removeSection(s.id); renderSections(); });
    row.append(type, title, tag, del);
    box.appendChild(row);
  }
}

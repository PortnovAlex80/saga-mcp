// Specification Workspace — document change editor.
//
// Git branches/worktrees remain the storage mechanism, but the UI presents
// them as change sets. Opening an existing document for editing creates a
// change set first, so the editor always starts from the current integrated
// document instead of an empty textarea.

(() => {
  'use strict';

  const state = {
    currentProjectId: null,
    currentBranch: null,
    initialPath: null,
    dirty: false,
    switchingBranch: false,
  };

  window.docsGraphEditor = {
    openForPath(relPath) {
      state.initialPath = relPath;
      openEditor();
    },
    refreshBranches() {
      if (state.currentProjectId) loadBranches();
    },
  };

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('branches-btn').addEventListener('click', toggleBranchesDrawer);
    document.getElementById('branches-close').addEventListener('click', hideBranchesDrawer);
    document.getElementById('editor-close').addEventListener('click', () => closeEditor());
    document.getElementById('editor-save').addEventListener('click', onSave);
    document.getElementById('editor-discard').addEventListener('click', onDiscard);
    document.getElementById('editor-branch-select').addEventListener('change', onBranchSelect);
    document.getElementById('editor-textarea').addEventListener('input', () => {
      markDirty();
      renderPreview();
    });
    document.getElementById('editor-path').addEventListener('input', markDirty);

    document.getElementById('merge-close').addEventListener('click', closeMergeModal);
    document.getElementById('merge-confirm').addEventListener('click', onMergeConfirm);

    const projectSelect = document.getElementById('project-select');
    if (projectSelect) projectSelect.addEventListener('change', syncProjectId);
    syncProjectId();

    document.addEventListener('keydown', (event) => {
      const modal = document.getElementById('editor-modal');
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !modal.classList.contains('hidden')) {
        event.preventDefault();
        onSave();
      }
      if (event.key === 'Escape' && !modal.classList.contains('hidden')) closeEditor();
    });

    window.addEventListener('beforeunload', (event) => {
      if (!state.dirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
  });

  function syncProjectId() {
    const sel = document.getElementById('project-select');
    state.currentProjectId = sel ? sel.value : null;
    state.currentBranch = null;
    markClean();
  }

  // ---- change-set drawer -------------------------------------------------
  async function toggleBranchesDrawer() {
    const drawer = document.getElementById('branches-drawer');
    if (!drawer.classList.contains('hidden')) {
      hideBranchesDrawer();
      return;
    }
    if (!state.currentProjectId) {
      flash('Сначала выберите проект.');
      return;
    }
    drawer.classList.remove('hidden');
    await loadBranches();
  }

  function hideBranchesDrawer() {
    document.getElementById('branches-drawer').classList.add('hidden');
  }

  async function fetchBranches() {
    const r = await fetch(`/api/doc/branch/list?project=${encodeURIComponent(state.currentProjectId)}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j.branches || [];
  }

  async function loadBranches() {
    const list = document.getElementById('branches-list');
    list.innerHTML = '<div class="empty-state"><div class="big">Загрузка…</div></div>';
    try {
      renderBranchList(await fetchBranches());
    } catch (e) {
      list.innerHTML = `<div class="empty-state"><div class="big">Ошибка</div><div>${escapeHtml(e.message)}</div></div>`;
    }
  }

  function renderBranchList(branches) {
    const list = document.getElementById('branches-list');
    if (!branches.length) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="big">Нет активных изменений</div>
          <div>Выберите документ в графе и нажмите «Редактировать документ».</div>
        </div>`;
      return;
    }
    list.innerHTML = branches.map((b) => `
      <div class="branch-card">
        <div class="name">${escapeHtml(b.changeId)}</div>
        <div class="meta">git: docs/${escapeHtml(b.changeId)} · worktree ${b.hasWorktree ? 'ready' : 'missing'} · ${b.head ? b.head.slice(0, 8) : '—'}</div>
        <div class="row">
          <button data-branch="docs/${escapeAttr(b.changeId)}" data-action="open">Редактировать</button>
          <button data-branch="docs/${escapeAttr(b.changeId)}" data-action="merge">Проверить</button>
          <button data-change="${escapeAttr(b.changeId)}" data-action="discard" class="danger">Удалить</button>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'open') {
          state.currentBranch = btn.dataset.branch;
          openEditor();
        } else if (action === 'merge') {
          openMergeModal(btn.dataset.branch);
        } else if (action === 'discard') {
          discardBranch(btn.dataset.change);
        }
      });
    });
  }

  async function discardBranch(changeId, { skipConfirm = false } = {}) {
    if (!skipConfirm && !confirm(`Удалить набор изменений «${changeId}»? Все его версии документации будут удалены.`)) return false;
    try {
      const r = await fetch('/api/doc/branch/discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: state.currentProjectId, change_id: changeId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      flash(`Набор изменений «${changeId}» удалён.`);
      if (!document.getElementById('branches-drawer').classList.contains('hidden')) await loadBranches();
      if (window.__docsGraphReload) window.__docsGraphReload();
      return true;
    } catch (e) {
      flash('Не удалось удалить набор изменений: ' + e.message);
      return false;
    }
  }

  // ---- document editor ---------------------------------------------------
  async function openEditor() {
    if (!state.currentProjectId) {
      flash('Сначала выберите проект.');
      return;
    }
    if (state.dirty && !confirm('Есть несохранённые изменения. Открыть другой документ и потерять их?')) return;

    const modal = document.getElementById('editor-modal');
    modal.classList.remove('hidden');

    const pathInput = document.getElementById('editor-path');
    const requestedPath = state.initialPath || '';
    pathInput.value = requestedPath;
    state.initialPath = null;
    document.getElementById('editor-message').value = '';
    document.getElementById('editor-textarea').value = '';
    markClean();

    let branches = [];
    try {
      branches = await fetchBranches();
    } catch (e) {
      flash('Не удалось загрузить наборы изменений: ' + e.message);
    }

    // Editing an existing document is an explicit edit intent. Create a
    // dedicated change set before loading the file so content comes from a
    // real worktree based on the current integration branch.
    if (requestedPath && !state.currentBranch) {
      try {
        state.currentBranch = await createChangeBranch(autoChangeId());
        branches = await fetchBranches();
      } catch (e) {
        flash('Не удалось начать редактирование: ' + e.message);
      }
    }

    populateBranchSelect(branches, state.currentBranch);
    onBranchSelectUiOnly();

    if (state.currentBranch && pathInput.value) {
      await tryLoadFromBranch(state.currentBranch, pathInput.value);
    } else if (pathInput.value) {
      document.getElementById('editor-textarea').value = `# ${baseName(pathInput.value)}\n\n`;
    }
    renderPreview();
    markClean();
  }

  function closeEditor(force = false) {
    if (!force && state.dirty && !confirm('Закрыть редактор без сохранения изменений?')) return false;
    document.getElementById('editor-modal').classList.add('hidden');
    state.currentBranch = null;
    markClean();
    return true;
  }

  function populateBranchSelect(branches, selectedBranch) {
    const sel = document.getElementById('editor-branch-select');
    sel.innerHTML = '<option value="">Создать новый</option>';
    for (const b of branches || []) {
      const opt = document.createElement('option');
      opt.value = `docs/${b.changeId}`;
      opt.textContent = `${b.changeId}${b.hasWorktree ? '' : ' · worktree отсутствует'}`;
      sel.appendChild(opt);
    }
    sel.value = selectedBranch || '';
  }

  async function onBranchSelect() {
    if (state.switchingBranch) return;
    const sel = document.getElementById('editor-branch-select');
    const nextBranch = sel.value;
    const previousBranch = state.currentBranch;
    if (nextBranch === previousBranch) {
      onBranchSelectUiOnly();
      return;
    }
    if (state.dirty && !confirm('Переключить набор изменений? Несохранённый текст будет потерян.')) {
      state.switchingBranch = true;
      sel.value = previousBranch || '';
      state.switchingBranch = false;
      return;
    }
    state.currentBranch = nextBranch || null;
    onBranchSelectUiOnly();
    markClean();
    const relPath = document.getElementById('editor-path').value.trim();
    if (state.currentBranch && relPath) await tryLoadFromBranch(state.currentBranch, relPath);
    renderPreview();
    markClean();
  }

  function onBranchSelectUiOnly() {
    const sel = document.getElementById('editor-branch-select');
    const newBranchLabel = document.querySelector('label.new-branch');
    newBranchLabel.hidden = Boolean(sel.value);
  }

  async function createChangeBranch(changeId) {
    const r = await fetch('/api/doc/branch/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: state.currentProjectId, change_id: changeId }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j.worktree.branch;
  }

  async function tryLoadFromBranch(branch, relPath) {
    try {
      const r = await fetch(
        `/api/doc/read?project=${encodeURIComponent(state.currentProjectId)}&branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(relPath)}`,
      );
      if (r.status === 404) {
        document.getElementById('editor-textarea').value = `# ${baseName(relPath)}\n\n`;
        renderPreview();
        return;
      }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      if (typeof j.content === 'string') document.getElementById('editor-textarea').value = j.content;
      renderPreview();
    } catch (e) {
      flash('Не удалось прочитать документ: ' + e.message);
    }
  }

  function renderPreview() {
    const ta = document.getElementById('editor-textarea');
    const preview = document.getElementById('editor-preview');
    const md = ta.value || '';
    if (typeof window.marked === 'undefined') {
      preview.textContent = md;
      return;
    }
    preview.innerHTML = window.marked.parse(md);
  }

  async function onSave() {
    const relPath = document.getElementById('editor-path').value.trim();
    if (!relPath) return flash('Укажите путь документа.');
    const markdown = document.getElementById('editor-textarea').value;
    const message = document.getElementById('editor-message').value.trim() || `docs: update ${relPath}`;
    const sel = document.getElementById('editor-branch-select');

    let branch = sel.value;
    if (!branch) {
      let changeId = document.getElementById('editor-new-branch').value.trim() || autoChangeId();
      if (!/^[a-z0-9][a-z0-9-]*$/.test(changeId)) {
        return flash('Идентификатор изменения: только a-z, 0-9 и дефис.');
      }
      try {
        branch = await createChangeBranch(changeId);
        state.currentBranch = branch;
        const branches = await fetchBranches();
        populateBranchSelect(branches, branch);
        onBranchSelectUiOnly();
        flash(`Создан набор изменений «${changeId}».`);
      } catch (e) {
        return flash('Не удалось создать набор изменений: ' + e.message);
      }
    }

    const saveButton = document.getElementById('editor-save');
    saveButton.disabled = true;
    try {
      const r = await fetch('/api/doc/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: state.currentProjectId, branch, path: relPath, markdown, message }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      markClean();
      if (j.commit) flash(`Черновик сохранён · ${j.commit.slice(0, 8)}`);
      else flash('Изменений для сохранения нет.');
      if (!document.getElementById('branches-drawer').classList.contains('hidden')) loadBranches();
    } catch (e) {
      flash('Сохранение не выполнено: ' + e.message);
    } finally {
      saveButton.disabled = false;
    }
  }

  async function onDiscard() {
    const branch = document.getElementById('editor-branch-select').value || state.currentBranch;
    if (!branch) return flash('Нет выбранного набора изменений.');
    const changeId = branch.replace(/^docs\//, '');
    if (await discardBranch(changeId)) closeEditor(true);
  }

  // ---- review and apply --------------------------------------------------
  async function openMergeModal(branch) {
    if (!state.currentProjectId) return flash('Сначала выберите проект.');
    state.currentBranch = branch;
    const modal = document.getElementById('merge-modal');
    modal.classList.remove('hidden');
    document.getElementById('merge-status').textContent = 'Загрузка diff…';
    document.getElementById('merge-status').className = 'merge-status';
    document.getElementById('merge-confirm').disabled = true;
    document.getElementById('merge-files-list').innerHTML = '';
    document.getElementById('merge-files-count').textContent = '0';
    document.getElementById('merge-patch').textContent = '';

    try {
      const r = await fetch(`/api/doc/diff?project=${encodeURIComponent(state.currentProjectId)}&branch=${encodeURIComponent(branch)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      renderMergePreview(j, branch);
    } catch (e) {
      document.getElementById('merge-status').textContent = 'Ошибка: ' + e.message;
      document.getElementById('merge-status').className = 'merge-status error';
    }
  }

  function closeMergeModal() {
    document.getElementById('merge-modal').classList.add('hidden');
  }

  function renderMergePreview(diff, branch) {
    const target = diff.integrationBranch || 'dev';
    document.getElementById('merge-target').textContent = target;
    document.getElementById('merge-title').textContent = `Проверка ${branch.replace(/^docs\//, '')}`;
    const filesCount = (diff.files || []).length;
    document.getElementById('merge-files-count').textContent = filesCount;

    const info = document.getElementById('merge-info');
    const existsNote = diff.integrationBranchExists === false
      ? `<div class="warn">Целевая ветка <code>${escapeHtml(target)}</code> ещё не существует и будет создана от <code>${escapeHtml(diff.baseRef)}</code>.</div>`
      : '';
    info.innerHTML = `
      <div>База: <code>${escapeHtml(diff.baseSha.slice(0, 8))}</code> · ${escapeHtml(diff.baseRef)}</div>
      <div>Цель: <code>${escapeHtml(target)}</code>${diff.integrationBranchExists === false ? ' · будет создана' : ''}</div>
      ${existsNote}
    `;

    const list = document.getElementById('merge-files-list');
    list.innerHTML = (diff.files || []).map((f) => {
      const cls = f.status === 'A' ? 'added' : f.status === 'D' ? 'deleted' : f.status === 'M' ? 'modified' : 'other';
      return `<div class="merge-file ${cls}"><span class="badge">${escapeHtml(f.status)}</span> <code>${escapeHtml(f.path)}</code></div>`;
    }).join('');
    document.getElementById('merge-patch').textContent = diff.patch || '(текстовых изменений нет)';

    if (filesCount === 0) {
      document.getElementById('merge-status').textContent = 'Нет изменений относительно базы.';
      document.getElementById('merge-status').className = 'merge-status warn';
      document.getElementById('merge-confirm').disabled = true;
    } else {
      document.getElementById('merge-status').textContent = '';
      document.getElementById('merge-confirm').disabled = false;
    }
  }

  async function onMergeConfirm() {
    const btn = document.getElementById('merge-confirm');
    btn.disabled = true;
    const status = document.getElementById('merge-status');
    status.textContent = 'Применение изменений…';
    status.className = 'merge-status';
    try {
      const r = await fetch('/api/doc/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: state.currentProjectId, branch: state.currentBranch }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      const result = j.result;
      if (result.kind === 'merged') {
        status.textContent = `Применено · ${result.mergeCommitSha.slice(0, 8)} → ${result.targetBranch}`;
        status.className = 'merge-status ok';
        if (!document.getElementById('branches-drawer').classList.contains('hidden')) loadBranches();
        if (window.__docsGraphReload) window.__docsGraphReload();
        setTimeout(closeMergeModal, 1800);
      } else if (result.kind === 'already_merged') {
        status.textContent = 'Этот набор уже применён.';
        status.className = 'merge-status warn';
      } else if (result.kind === 'conflict') {
        status.textContent = `Конфликт в ${result.conflictFiles.length} файл(ах): ${result.conflictFiles.join(', ')}`;
        status.className = 'merge-status error';
      } else if (result.kind === 'base_advanced') {
        status.textContent = `Целевая ветка изменилась (${result.observedTargetSha.slice(0, 8)}). Обновите diff и повторите.`;
        status.className = 'merge-status warn';
      } else {
        status.textContent = `${result.kind}: ${result.message || ''}`;
        status.className = 'merge-status error';
      }
    } catch (e) {
      status.textContent = 'Ошибка: ' + e.message;
      status.className = 'merge-status error';
    } finally {
      btn.disabled = false;
    }
  }

  function markDirty() {
    state.dirty = true;
    document.getElementById('editor-modal').classList.add('is-dirty');
  }

  function markClean() {
    state.dirty = false;
    document.getElementById('editor-modal')?.classList.remove('is-dirty');
  }

  function flash(msg) {
    let el = document.querySelector('.banner');
    if (!el) {
      el = document.createElement('div');
      el.className = 'banner info';
      document.body.appendChild(el);
    }
    el.className = 'banner info';
    el.textContent = msg;
    clearTimeout(el.__ttl);
    el.__ttl = setTimeout(() => el.remove(), 3500);
  }

  function autoChangeId() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
    return `doc-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}-${rand}`;
  }

  function baseName(p) {
    const parts = String(p || '').split('/');
    return parts[parts.length - 1].replace(/\.md$/i, '') || 'untitled';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }
})();

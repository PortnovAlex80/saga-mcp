// Docs Graph Viewer — branch editor (Phase B).
//
// Wires two pieces of UI:
//   1. The 🌿 Branches drawer — lists active docs/* branches for the current
//      project; each card has "Open editor", "Discard" actions.
//   2. The editor modal — markdown textarea + live preview, save commits
//      inside the chosen docs/* worktree.
//
// Branch naming follows docs-worktree.ts: `docs/<changeId>`, worktree
// `.worktrees/docs-<changeId>`. The editor never touches the main repo
// working directory — all writes go through the worktree.

(() => {
  'use strict';

  const state = {
    currentProjectId: null,
    currentBranch: null, // 'docs/<id>' selected in editor
    initialPath: null,   // path pre-filled when opening editor from a node
  };

  // ---- public API: open editor for a path (called from graph.js) ----
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
    document.getElementById('branches-close').addEventListener('click', () => hideBranchesDrawer());
    document.getElementById('editor-close').addEventListener('click', () => closeEditor());
    document.getElementById('editor-save').addEventListener('click', onSave);
    document.getElementById('editor-discard').addEventListener('click', onDiscard);
    document.getElementById('editor-branch-select').addEventListener('change', onBranchSelect);
    document.getElementById('editor-textarea').addEventListener('input', renderPreview);

    // Merge modal wiring (Phase C).
    document.getElementById('merge-close').addEventListener('click', () => closeMergeModal());
    document.getElementById('merge-confirm').addEventListener('click', onMergeConfirm);

    // Project changes propagate via graph.js — poll the select.
    const sel = document.getElementById('project-select');
    if (sel) sel.addEventListener('change', syncProjectId);
    syncProjectId();
  });

  function syncProjectId() {
    const sel = document.getElementById('project-select');
    state.currentProjectId = sel ? sel.value : null;
    state.currentBranch = null;
  }

  // ---- branches drawer ----
  async function toggleBranchesDrawer() {
    const drawer = document.getElementById('branches-drawer');
    if (!drawer.classList.contains('hidden')) {
      hideBranchesDrawer();
      return;
    }
    if (!state.currentProjectId) {
      flash('Select a project first.');
      return;
    }
    drawer.classList.remove('hidden');
    await loadBranches();
  }

  function hideBranchesDrawer() {
    document.getElementById('branches-drawer').classList.add('hidden');
  }

  async function loadBranches() {
    const list = document.getElementById('branches-list');
    list.innerHTML = '<div class="empty-state"><div class="big">Loading…</div></div>';
    try {
      const r = await fetch(`/api/doc/branch/list?project=${encodeURIComponent(state.currentProjectId)}`);
      const j = await r.json();
      renderBranchList(j.branches || []);
    } catch (e) {
      list.innerHTML = `<div class="empty-state"><div class="big">Error: ${escapeHtml(e.message)}</div></div>`;
    }
  }

  function renderBranchList(branches) {
    const list = document.getElementById('branches-list');
    if (!branches.length) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="big">No active docs branches</div>
          <div>Open any document node and click "Edit in branch".</div>
        </div>`;
      return;
    }
    list.innerHTML = branches.map((b) => `
      <div class="branch-card">
        <div class="name">docs/${escapeHtml(b.changeId)}</div>
        <div class="meta">worktree: ${b.hasWorktree ? '✓' : '✗'} · head: ${b.head ? b.head.slice(0, 8) : '—'}</div>
        <div class="row">
          <button data-branch="docs/${escapeAttr(b.changeId)}" data-action="open">Open editor</button>
          <button data-branch="docs/${escapeAttr(b.changeId)}" data-action="merge">Merge…</button>
          <button data-change="${escapeAttr(b.changeId)}" data-action="discard" class="danger">Discard</button>
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

  async function discardBranch(changeId) {
    if (!confirm(`Discard branch docs/${changeId}? All uncommitted work will be lost.`)) return;
    try {
      const r = await fetch('/api/doc/branch/discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: state.currentProjectId, change_id: changeId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      flash(`Branch docs/${changeId} discarded.`);
      await loadBranches();
      // Reload graph if it is currently displayed.
      if (window.__docsGraphReload) window.__docsGraphReload();
    } catch (e) {
      flash('Discard failed: ' + e.message);
    }
  }

  // ---- editor modal ----
  async function openEditor() {
    if (!state.currentProjectId) {
      flash('Select a project first.');
      return;
    }
    const modal = document.getElementById('editor-modal');
    modal.classList.remove('hidden');

    const pathInput = document.getElementById('editor-path');
    pathInput.value = state.initialPath || '';
    state.initialPath = null;

    document.getElementById('editor-message').value = '';
    document.getElementById('editor-textarea').value = '';

    // Populate branch select.
    const sel = document.getElementById('editor-branch-select');
    sel.innerHTML = '<option value="">(create new)</option>';
    try {
      const r = await fetch(`/api/doc/branch/list?project=${encodeURIComponent(state.currentProjectId)}`);
      const j = await r.json();
      for (const b of j.branches || []) {
        const opt = document.createElement('option');
        opt.value = `docs/${b.changeId}`;
        opt.textContent = `docs/${b.changeId}${b.hasWorktree ? '' : ' (no worktree)'}`;
        sel.appendChild(opt);
      }
    } catch (e) {
      flash('Could not load branches: ' + e.message);
    }
    sel.value = state.currentBranch || '';
    onBranchSelect();

    // If editing an existing path in an existing branch, pre-fill content.
    if (sel.value && pathInput.value) {
      tryLoadFromBranch(sel.value, pathInput.value);
    }
    renderPreview();
  }

  function closeEditor() {
    document.getElementById('editor-modal').classList.add('hidden');
    state.currentBranch = null;
  }

  function onBranchSelect() {
    const sel = document.getElementById('editor-branch-select');
    const newBranchLabel = document.querySelector('label.new-branch');
    if (sel.value) {
      state.currentBranch = sel.value;
      newBranchLabel.hidden = true;
    } else {
      state.currentBranch = null;
      newBranchLabel.hidden = false;
    }
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
      if (r.ok && typeof j.content === 'string') {
        document.getElementById('editor-textarea').value = j.content;
        renderPreview();
      }
    } catch (e) {
      // Leave the textarea empty — user can type a new doc.
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
    if (!relPath) return flash('Path required.');
    const markdown = document.getElementById('editor-textarea').value;
    const message =
      document.getElementById('editor-message').value.trim() ||
      `docs: update ${relPath}`;
    const sel = document.getElementById('editor-branch-select');

    let branch = sel.value;
    let newChangeId = null;
    if (!branch) {
      newChangeId = document.getElementById('editor-new-branch').value.trim();
      if (!newChangeId) {
        // Auto-generate one.
        newChangeId = autoChangeId();
      }
      if (!/^[a-z0-9][a-z0-9-]*$/.test(newChangeId)) {
        return flash('changeId must match [a-z0-9-]+.');
      }
      // Create the branch first.
      try {
        const r = await fetch('/api/doc/branch/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: state.currentProjectId, change_id: newChangeId }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || r.statusText);
        branch = j.worktree.branch;
        state.currentBranch = branch;
        flash(`Created branch ${branch}.`);
      } catch (e) {
        return flash('Create branch failed: ' + e.message);
      }
    }

    try {
      const r = await fetch('/api/doc/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: state.currentProjectId,
          branch,
          path: relPath,
          markdown,
          message,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      if (j.commit) {
        flash(`Saved: commit ${j.commit.slice(0, 8)} → ${branch}`);
      } else {
        flash('Nothing to commit (tree unchanged).');
      }
      // Refresh branch drawer if visible.
      if (!document.getElementById('branches-drawer').classList.contains('hidden')) {
        loadBranches();
      }
    } catch (e) {
      flash('Save failed: ' + e.message);
    }
  }

  async function onDiscard() {
    const sel = document.getElementById('editor-branch-select');
    if (!sel.value) return flash('No branch selected.');
    const changeId = sel.value.replace(/^docs\//, '');
    await discardBranch(changeId);
    closeEditor();
  }

  // ---- merge modal (Phase C) ----
  async function openMergeModal(branch) {
    if (!state.currentProjectId) return flash('Select a project first.');
    state.currentBranch = branch;
    const modal = document.getElementById('merge-modal');
    modal.classList.remove('hidden');
    document.getElementById('merge-status').textContent = 'Loading diff…';
    document.getElementById('merge-status').className = 'merge-status';
    document.getElementById('merge-confirm').disabled = true;

    document.getElementById('merge-files-list').innerHTML = '';
    document.getElementById('merge-files-count').textContent = '0';
    document.getElementById('merge-patch').textContent = '';

    try {
      const r = await fetch(
        `/api/doc/diff?project=${encodeURIComponent(state.currentProjectId)}&branch=${encodeURIComponent(branch)}`,
      );
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      renderMergePreview(j, branch);
    } catch (e) {
      document.getElementById('merge-status').textContent = 'Error: ' + e.message;
      document.getElementById('merge-status').className = 'merge-status error';
    }
  }

  function closeMergeModal() {
    document.getElementById('merge-modal').classList.add('hidden');
  }

  function renderMergePreview(diff, branch) {
    const target = diff.integrationBranch || 'dev';
    document.getElementById('merge-target').textContent = target;
    document.getElementById('merge-title').textContent = `Merge ${branch} → ${target}`;
    const filesCount = (diff.files || []).length;
    document.getElementById('merge-files-count').textContent = filesCount;

    const info = document.getElementById('merge-info');
    const existsNote = diff.integrationBranchExists === false
      ? `<div class="warn">⚠ Integration branch <code>${escapeHtml(target)}</code> does not exist — it will be auto-created from <code>${escapeHtml(diff.baseRef)}</code>.</div>`
      : '';
    info.innerHTML = `
      <div>Base: <code>${escapeHtml(diff.baseSha.slice(0, 8))}</code> (${escapeHtml(diff.baseRef)})</div>
      <div>Target: <code>${escapeHtml(target)}</code>${diff.integrationBranchExists === false ? ' (will be created)' : ''}</div>
      ${existsNote}
    `;

    const list = document.getElementById('merge-files-list');
    list.innerHTML = (diff.files || [])
      .map((f) => {
        const cls = f.status === 'A' ? 'added' : f.status === 'D' ? 'deleted' : f.status === 'M' ? 'modified' : 'other';
        return `<div class="merge-file ${cls}"><span class="badge">${escapeHtml(f.status)}</span> <code>${escapeHtml(f.path)}</code></div>`;
      })
      .join('');

    const patchEl = document.getElementById('merge-patch');
    patchEl.textContent = diff.patch || '(no textual diff)';

    if (filesCount === 0) {
      document.getElementById('merge-status').textContent = 'Nothing to merge — branch has no changes vs base.';
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
    status.textContent = 'Merging…';
    status.className = 'merge-status';
    try {
      const r = await fetch('/api/doc/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: state.currentProjectId,
          branch: state.currentBranch,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      const result = j.result;
      if (result.kind === 'merged') {
        status.textContent = `✓ Merged as ${result.mergeCommitSha.slice(0, 8)} into ${result.targetBranch}. Branch cleaned up.`;
        status.className = 'merge-status ok';
        // Refresh branch drawer + graph.
        if (!document.getElementById('branches-drawer').classList.contains('hidden')) {
          loadBranches();
        }
        if (window.__docsGraphReload) window.__docsGraphReload();
        setTimeout(closeMergeModal, 2500);
      } else if (result.kind === 'already_merged') {
        status.textContent = 'Already merged.';
        status.className = 'merge-status warn';
      } else if (result.kind === 'conflict') {
        status.innerHTML = `✗ Conflict in ${result.conflictFiles.length} file(s): ${result.conflictFiles.map(escapeHtml).join(', ')}. Resolve manually or discard.`;
        status.className = 'merge-status error';
      } else if (result.kind === 'base_advanced') {
        status.textContent = `Integration branch advanced (${result.observedTargetSha.slice(0, 8)}). Re-open diff and retry.`;
        status.className = 'merge-status warn';
      } else {
        status.textContent = `${result.kind}: ${result.message || ''}`;
        status.className = 'merge-status error';
      }
    } catch (e) {
      status.textContent = 'Error: ' + e.message;
      status.className = 'merge-status error';
    } finally {
      btn.disabled = false;
    }
  }

  // ---- helpers ----
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
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }
})();

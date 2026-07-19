// Docs Graph Viewer — frontend logic.
//
// Renders the unified documentation graph (saga artifacts + .md docs + traces)
// using cytoscape with the dagre layout extension. Clicking a node opens a
// detail card in the side panel; clicking an edge row highlights both ends.

(() => {
  'use strict';

  const TYPE_COLORS = {
    PRD: '#58a6ff', SRS: '#a371f7', UC: '#3fb950', AC: '#f1c40f',
    FR: '#e67e22', NFR: '#1abc9c', decision: '#9b59b6', theme: '#e84393',
    brief: '#f39c12', doc: '#8b949e', task: '#d19a66', RULE: '#56d364',
    SPEC: '#79c0ff', OQ: '#f85149', hypothesis: '#bc8cff',
    business_metric: '#ffa657', summary: '#6e7681',
  };
  // For nodes without a known type.
  const DEFAULT_COLOR = '#8b949e';

  const LINK_COLORS = {
    parent: '#30363d', covers: '#a371f7', implements: '#3fb950',
    derived_from: '#8b949e', depends_on: '#f39c12', verified_by: '#1abc9c',
    superseded_by: '#e74c3c', implements_spec: '#79c0ff',
  };
  const LINK_GLYPH = {
    parent: '↓ parent', covers: '↳ covers', implements: '↳ impl',
    derived_from: '↳ from', depends_on: '↳ dep', verified_by: '↳ verify',
    superseded_by: '↳ super', implements_spec: '↳ spec',
  };

  // Edges that touch task nodes — toggleable from the toolbar.
  const TASK_EDGE_TYPES = new Set(['implements', 'verified_by', 'depends_on']);

  let cy = null;
  let currentSnapshot = null;
  let selectedNodeId = null;

  // ---- bootstrap ----
  async function init() {
    if (typeof cytoscape === 'undefined') {
      banner('Не удалось загрузить cytoscape (CDN заблокирован?). Проверьте сеть.', 'error');
      return;
    }
    if (typeof window.dagre !== 'undefined' && typeof window.cytoscapeDagre !== 'undefined') {
      cytoscape.use(window.cytoscapeDagre);
    }

    cy = cytoscape({
      container: document.getElementById('cy'),
      wheelSensitivity: 0.2,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': (e) => colorFor(e.data('type')),
            'label': 'data(label)',
            'color': '#e6edf3',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 6,
            'text-wrap': 'wrap',
            'text-max-width': '120px',
            'font-size': '11px',
            'font-family': '-apple-system, "Segoe UI", sans-serif',
            'width': (e) => nodeSize(e, 'w'),
            'height': (e) => nodeSize(e, 'h'),
            'shape': (e) => e.data('kind') === 'task' ? 'diamond' : 'round-rectangle',
            'border-width': 0,
            'overlay-opacity': 0,
          },
        },
        {
          selector: 'node:selected',
          style: {
            'border-width': 3,
            'border-color': '#4f8cff',
            'border-opacity': 1,
          },
        },
        {
          selector: 'edge',
          style: {
            'width': 1.5,
            'line-color': (e) => LINK_COLORS[e.data('linkType')] || '#484f58',
            'target-arrow-color': (e) => LINK_COLORS[e.data('linkType')] || '#484f58',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'arrow-scale': 0.8,
            'opacity': 0.85,
            'overlay-opacity': 0,
          },
        },
        {
          selector: 'edge:selected',
          style: { 'width': 3, 'opacity': 1 },
        },
        {
          selector: '.faded',
          style: { 'opacity': 0.15 },
        },
        {
          selector: '.highlighted',
          style: { 'opacity': 1, 'border-width': 2, 'border-color': '#4f8cff' },
        },
      ],
      elements: [],
    });

    cy.on('select', 'node', (evt) => {
      selectedNodeId = evt.target.id();
      renderSidePanel(evt.target.id());
    });
    cy.on('select', 'edge', (evt) => {
      const edge = evt.target();
      highlightNeighborhood(edge.source(), edge.target());
    });
    cy.on('unselect', () => {
      cy.elements().removeClass('faded highlighted');
    });

    // Toolbar wiring.
    document.getElementById('refresh-btn').addEventListener('click', () => loadGraph());
    document.getElementById('layout-select').addEventListener('change', () => runLayout());
    document.getElementById('hide-task-edges').addEventListener('change', () => applyEdgeFilter());

    await loadProjects();
    // Honor ?project=NN in URL or hash.
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('project');
    if (fromUrl) {
      document.getElementById('project-select').value = fromUrl;
    }
    document.getElementById('project-select').addEventListener('change', () => loadGraph());
    if (document.getElementById('project-select').value) {
      loadGraph();
    }
  }

  // ---- data loading ----
  async function loadProjects() {
    try {
      const r = await fetch('/api/projects');
      const j = await r.json();
      const sel = document.getElementById('project-select');
      sel.innerHTML = '<option value="">— select —</option>';
      for (const p of j.projects || []) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.name} (${p.artifact_count || 0})`;
        sel.appendChild(opt);
      }
    } catch (e) {
      banner('Не удалось загрузить список проектов: ' + e.message, 'error');
    }
  }

  async function loadGraph() {
    const pid = document.getElementById('project-select').value;
    if (!pid) return;
    banner('Загрузка графа…', 'info', 800);
    try {
      const r = await fetch(`/api/graph?project=${encodeURIComponent(pid)}`);
      const j = await r.json();
      if (!r.ok || !j.available) {
        showEmpty(j.reason || j.error || 'unknown');
        return;
      }
      currentSnapshot = j;
      renderGraph(j);
      const s = j.stats || {};
      setStats(`📦 ${s.artifactCount || 0} artifacts · 📄 ${s.docCount || 0} docs · 🔧 ${s.taskCount || 0} tasks · 🔗 ${s.edgeCount || 0} edges`);
    } catch (e) {
      banner('Ошибка загрузки графа: ' + e.message, 'error');
    }
  }

  function renderGraph(snapshot) {
    cy.elements().remove();

    const hideTaskEdges = document.getElementById('hide-task-edges').checked;

    const nodes = (snapshot.nodes || []).map((n) => ({
      data: {
        id: n.id,
        label: nodeLabel(n),
        type: n.type,
        kind: n.kind,
        raw: n,
      },
    }));
    const edges = (snapshot.edges || [])
      .filter((e) => !hideTaskEdges || !isTaskEdge(e, snapshot))
      .map((e, i) => ({
        data: {
          id: `e${i}:${e.source}->${e.target}:${e.linkType}`,
          source: e.source,
          target: e.target,
          linkType: e.linkType,
        },
      }));

    cy.add([...nodes, ...edges]);
    runLayout();
    cy.fit(undefined, 60);
  }

  function runLayout() {
    const sel = document.getElementById('layout-select').value;
    const layoutOpts =
      sel === 'dagre'
        ? {
            name: 'dagre',
            rankDir: 'TB',
            nodeSep: 40,
            rankSep: 70,
            animate: false,
          }
        : sel === 'breadthfirst'
          ? { name: 'breadthfirst', directed: true, padding: 30, animate: false }
          : sel === 'cose'
            ? { name: 'cose', animate: false, nodeRepulsion: 8000, idealEdgeLength: 100 }
            : sel === 'circle'
              ? { name: 'circle', animate: false }
              : sel === 'concentric'
                ? { name: 'concentric', animate: false }
                : { name: 'grid' };
    const l = cy.layout(layoutOpts);
    l.one('layoutstop', () => cy.fit(undefined, 60));
    l.run();
  }

  function applyEdgeFilter() {
    if (!currentSnapshot) return;
    renderGraph(currentSnapshot);
  }

  // ---- node / edge presentation helpers ----
  function colorFor(type) {
    return TYPE_COLORS[type] || DEFAULT_COLOR;
  }

  function nodeSize(ele, dim) {
    const kind = ele.data('kind');
    const type = ele.data('type');
    // Artifact nodes: a bit bigger, sized by type importance.
    if (kind === 'artifact') {
      const big = new Set(['PRD', 'SRS', 'UC']).has(type);
      return dim === 'w' ? (big ? 52 : 38) : dim === 'h' ? (big ? 52 : 38) : 40;
    }
    if (kind === 'task') return dim === 'w' ? 28 : 28;
    return dim === 'w' ? 34 : 34;
  }

  function nodeLabel(n) {
    if (n.kind === 'artifact' && n.code) return n.code;
    if (n.kind === 'task' && n.taskId) return `#${n.taskId}`;
    // Doc nodes: trim the basename and drop extension.
    if (n.path) {
      const parts = n.path.split('/');
      const last = parts[parts.length - 1].replace(/\.md$/i, '');
      return last.length > 28 ? last.slice(0, 25) + '…' : last;
    }
    return n.title || '?';
  }

  function isTaskEdge(edge, snapshot) {
    const types = TASK_EDGE_TYPES;
    if (!types.has(edge.linkType)) return false;
    // Heuristic: edges that go to/from a task node OR carry a task-only
    // link_type are considered "task edges" for the filter.
    return true;
  }

  // ---- side panel ----
  function renderSidePanel(nodeId) {
    const node = (currentSnapshot.nodes || []).find((n) => n.id === nodeId);
    if (!node) return;
    const panel = document.getElementById('side-panel');
    panel.classList.remove('empty');

    const outgoing = (currentSnapshot.edges || []).filter((e) => e.source === nodeId);
    const incoming = (currentSnapshot.edges || []).filter((e) => e.target === nodeId);

    const html = `
      <div class="node-card">
        <div class="header">
          <span class="type-badge ${escapeAttr(node.type)}">${escapeHtml(node.type || '?')}</span>
          ${node.code ? `<span class="code-tag">${escapeHtml(node.code)}</span>` : ''}
          ${node.status ? `<span><span class="status-dot ${escapeAttr(node.status)}"></span>${escapeHtml(node.status)}</span>` : ''}
        </div>
        <h2 class="node-title">${escapeHtml(node.title || '(без названия)')}</h2>
        <div class="kv-list">
          ${kv('Kind', node.kind)}
          ${kv('Path', node.path)}
          ${node.epicName ? kv('Epic', node.epicName) : ''}
          ${kv('Content hash', shortHash(node.contentHash))}
          ${node.driftState ? kv('Drift', node.driftState) : ''}
          ${node.mtime ? kv('Modified', new Date(node.mtime).toISOString().replace('T', ' ').slice(0, 19)) : ''}
          ${(node.tags && node.tags.length) ? kv('Tags', node.tags.join(', ')) : ''}
        </div>

        ${node.path ? `
          <button class="edit-btn" data-path="${escapeAttr(node.path)}">✎ Edit in branch</button>
          ${node.kind === 'artifact' ? `<button class="edit-btn secondary" data-action="view-md" data-path="${escapeAttr(node.path)}">View source</button>` : ''}
        ` : ''}

        ${outgoing.length ? `
          <div>
            <div class="section-title">Outgoing (${outgoing.length})</div>
            <div class="edge-list">
              ${outgoing.map(edgeRow(currentSnapshot, 'out')).join('')}
            </div>
          </div>` : ''}
        ${incoming.length ? `
          <div>
            <div class="section-title">Incoming (${incoming.length})</div>
            <div class="edge-list">
              ${incoming.map(edgeRow(currentSnapshot, 'in')).join('')}
            </div>
          </div>` : ''}
      </div>
    `;
    panel.innerHTML = html;

    // Wire edge row clicks to focus the other end.
    panel.querySelectorAll('.edge-row').forEach((row) => {
      row.addEventListener('click', () => {
        const targetId = row.dataset.target;
        if (targetId) {
          cy.getElementById(targetId).select();
          cy.center(cy.getElementById(targetId));
        }
      });
    });

    // Wire "Edit in branch" / "View source" buttons → editor module.
    panel.querySelectorAll('.edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = btn.dataset.path;
        if (btn.dataset.action === 'view-md') {
          // Open raw markdown read-only in a new tab (best-effort: depends on
          // the repository serving files — falls back to the editor).
          window.open(p, '_blank');
          return;
        }
        if (window.docsGraphEditor && p) {
          window.docsGraphEditor.openForPath(p);
        }
      });
    });
  }

  function edgeRow(snapshot, dir) {
    return (e) => {
      const otherId = dir === 'out' ? e.target : e.source;
      const other = (snapshot.nodes || []).find((n) => n.id === otherId) || {};
      const glyph = LINK_GLYPH[e.linkType] || e.linkType;
      const label = other.code || other.title || other.path || otherId;
      return `
        <div class="edge-row" data-target="${escapeAttr(otherId)}">
          <span class="glyph">${escapeHtml(glyph)}</span>
          <span>${escapeHtml(truncate(String(label), 36))}</span>
        </div>`;
    };
  }

  function highlightNeighborhood(a, b) {
    cy.elements().removeClass('faded highlighted');
    const keep = cy.collection().union(a).union(b).union(cy.elements(`edge[source="${a.id()}"][target="${b.id()}"], edge[source="${b.id()}"][target="${a.id()}"]`));
    cy.elements().not(keep).addClass('faded');
    keep.addClass('highlighted');
  }

  // ---- misc UI helpers ----
  function showEmpty(reason) {
    document.getElementById('side-panel').classList.add('empty');
    const reasons = {
      'project-not-found': 'Проект не найден.',
      'no-artifacts-table': 'В этой БД нет таблицы artifacts (старая saga-mcp).',
    };
    const text = reasons[reason] || 'Граф пуст.';
    if (cy) cy.elements().remove();
    const cyEl = document.getElementById('cy');
    cyEl.innerHTML = `<div class="empty-state"><div class="big">${escapeHtml(text)}</div><div>Выберите другой проект.</div></div>`;
    setStats('');
  }

  function banner(msg, kind = 'info', ttl = 0) {
    let el = document.querySelector('.banner');
    if (!el) {
      el = document.createElement('div');
      el.className = 'banner';
      document.body.appendChild(el);
    }
    el.className = `banner ${kind}`;
    el.textContent = msg;
    if (ttl > 0) setTimeout(() => el.remove(), ttl);
  }

  function setStats(t) {
    document.getElementById('stats').textContent = t;
  }

  function kv(k, v) {
    if (v == null || v === '' || v === undefined) return '';
    return `<div class="kv"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(v))}</span></div>`;
  }
  function shortHash(h) {
    if (!h) return null;
    return h.length > 12 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h;
  }
  function truncate(s, n) {
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  document.addEventListener('DOMContentLoaded', init);

  // Expose a reload hook so editor.js can trigger a graph refresh after
  // branch/discard operations without reaching into internal state.
  window.__docsGraphReload = loadGraph;
})();

window.WD = window.WD || {};
(() => {
  const W = window.WD;
  const E = W.escape;

  const setPath = (obj, path, value) => {
    const parts = String(path).split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (cur[key] == null || typeof cur[key] !== 'object') cur[key] = {};
      cur = cur[key];
    }
    cur[parts.at(-1)] = value;
  };
  const field = (label, path, value, type = 'text', extra = '') => `<div class="field"><label>${E(label)}</label><input type="${type}" data-bind="${E(path)}" value="${E(value ?? '')}" ${extra}></div>`;
  const area = (label, path, value) => `<div class="field"><label>${E(label)}</label><textarea data-bind="${E(path)}">${E(value ?? '')}</textarea></div>`;
  const select = (label, path, value, values) => `<div class="field"><label>${E(label)}</label><select data-bind="${E(path)}">${values.map((v) => `<option value="${E(v)}"${v === value ? ' selected' : ''}>${E(v)}</option>`).join('')}</select></div>`;
  const section = (title, body, note = '') => `<section class="inspector-section"><h3>${E(title)}</h3>${note ? `<p class="section-note">${E(note)}</p>` : ''}${body}</section>`;
  const terminal = (id) => W.state.design.terminalNodeIds.includes(id);

  W.renderInspector = () => {
    const empty = W.byId('inspector-empty');
    const content = W.byId('inspector-content');
    const edge = W.edgeById(W.state.selectedEdgeId);
    const node = W.node(W.state.selectedNodeId);
    if (W.state.inspectModule) {
      empty.classList.add('hidden');
      content.classList.remove('hidden');
      content.innerHTML = moduleInspector();
      bindModule(content);
      return;
    }
    if (edge) {
      empty.classList.add('hidden');
      content.classList.remove('hidden');
      content.innerHTML = edgeInspector(edge);
      bindEdge(content, edge);
      return;
    }
    if (node) {
      empty.classList.add('hidden');
      content.classList.remove('hidden');
      content.innerHTML = nodeInspector(node);
      bindNode(content, node);
      return;
    }
    content.classList.add('hidden');
    empty.classList.remove('hidden');
  };

  function moduleInspector() {
    const d = W.state.design;
    return `<div class="eyebrow">ПАРАМЕТРЫ ЦЕХА</div><h2>${E(d.displayName)}</h2>`
      + section('Идентичность', field('Module id', 'id', d.id) + field('Version', 'version', d.version) + field('Display name', 'displayName', d.displayName) + area('Описание', 'description', d.description))
      + section('Граница', field('Input contract', 'inputContract', d.inputContract) + field('Output contract', 'outputContract', d.outputContract), 'Authority-контракты входа и выхода Process Module.')
      + section('Flow', `<div class="field"><label>Entry node</label><div class="readonly">${E(d.entryNodeId || '—')}</div></div><div class="field"><label>Terminal nodes</label><div class="pills">${d.terminalNodeIds.map((id) => `<span class="edit-pill">${E(id)}</span>`).join('') || '—'}</div></div>`, 'Entry/terminal роли назначаются из инспектора узла.')
      + '<button id="module-back" class="wide module-back">Вернуться к схеме</button>';
  }

  function bindModule(root) {
    root.querySelectorAll('[data-bind]').forEach((el) => el.addEventListener(el.tagName === 'TEXTAREA' ? 'input' : 'change', () => {
      W.state.design[el.dataset.bind] = el.value;
      W.changed?.({ render: false });
      W.renderStatus();
    }));
    W.byId('module-back').addEventListener('click', () => {
      W.state.inspectModule = false;
      W.renderInspector();
    });
  }

  function edgeInspector(e) {
    return `<div class="eyebrow">ПЕРЕХОД</div><h2>${E(e.from)} → ${E(e.to)}</h2>`
      + section('Маршрутизация', field('Event / on', 'on', e.on) + `<div class="two"><div class="field"><label>From</label><div class="readonly">${E(e.from)}</div></div><div class="field"><label>To</label><div class="readonly">${E(e.to)}</div></div></div>`, 'Event является частью детерминированного route contract.')
      + '<button id="edge-delete" class="wide">Удалить переход</button>';
  }

  function bindEdge(root, e) {
    root.querySelector('[data-bind="on"]').addEventListener('input', (ev) => {
      e.on = ev.target.value;
      W.changed?.({ render: false });
      W.renderEdges();
      W.renderStatus();
    });
    W.byId('edge-delete').addEventListener('click', () => W.deleteSelected?.());
  }

  function roles(n) {
    return `<div class="role-buttons"><button id="set-entry" class="mini">${W.state.design.entryNodeId === n.id ? '✓ Entry node' : 'Сделать Entry'}</button><button id="toggle-terminal" class="mini">${terminal(n.id) ? '✓ Terminal' : 'Сделать Terminal'}</button></div>`;
  }

  function nodeInspector(n) {
    let body = `<div class="eyebrow">${n.kind === 'production-cell' ? 'РАБОЧИЙ СТОЛ' : n.kind === 'kernel' ? 'АВТОМАТ' : 'РЕШЕНИЕ ЧЕЛОВЕКА'}</div><h2>${E(n.label)}</h2>`;
    body += section('Идентичность', field('Node id', 'id', n.id) + field('Название', 'label', n.label) + area('Назначение', 'description', n.description) + roles(n));
    if (n.kind === 'production-cell') body += productionCellInspector(n);
    else if (n.kind === 'kernel') body += kernelInspector(n);
    else if (n.kind === 'human') body += humanInspector(n);
    body += outgoingInspector(n);
    return body;
  }

  function productionCellInspector(n) {
    const inputs = (n.inputSelectors || []).map((x, i) => `<span class="edit-pill">${E(x)}<button data-remove-input="${i}" title="Удалить">×</button></span>`).join('');
    const products = (n.productContracts || []).map((p, i) => `<div class="transition-row"><div class="transition-card"><b>${E(p.binding || 'product')}</b><input data-product-schema="${i}" value="${E(p.schemaRef || '')}" title="Schema ref"></div><button class="mini" data-remove-product="${i}">×</button></div>`).join('');
    const review = n.review || { enabled: false };
    return section('Материалы', field('Primary input schema', 'inputSchema', n.inputSchema) + `<div class="field"><label>Input selectors</label><div class="pills">${inputs || '<span class="section-note">Нет входов</span>'}</div><div class="inline"><input id="new-input" placeholder="schema / selector"><button id="add-input" class="mini">Добавить</button></div></div>`, 'Стол должен получать точные входные материалы.')
      + section('Продукт', field('Primary output schema', 'outputSchema', n.outputSchema) + `<div class="field"><label>Product contracts</label>${products}<button id="add-product" class="mini">+ Product contract</button></div>`, 'CandidateSet запечатывается из заявленных product contracts.')
      + section('Автор', field('Skill ref', 'author.skillRef', n.author?.skillRef) + field('Capability preset', 'author.capabilityPreset', n.author?.capabilityPreset))
      + section('ОТК автора', field('Gate id', 'authorGate.gateId', n.authorGate?.gateId) + field('Check plan ref', 'authorGate.checkPlanRef', n.authorGate?.checkPlanRef), 'Gate является отдельной authority границей, а не self-check автора.')
      + section('Независимое ревью', `<div class="switch"><span>Reviewer desk</span><input id="review-enabled" type="checkbox" ${review.enabled ? 'checked' : ''}></div>${review.enabled ? field('Reviewer skill', 'review.skillRef', review.skillRef) + field('Capability preset', 'review.capabilityPreset', review.capabilityPreset) + field('Verdict schema', 'review.verdictSchemaRef', review.verdictSchemaRef) + field('Final Gate id', 'review.finalGateId', review.finalGateId) : '<p class="section-note">Отключено: author Gate должен быть финальным контролем стола.</p>'}`, 'Reviewer не должен получать авторские/write capabilities.')
      + section('Repair / recovery', `<div class="two">${field('Max attempts', 'recovery.maxAttempts', n.recovery?.maxAttempts, 'number', 'min="1"')}${select('On exhausted', 'recovery.onExhausted', n.recovery?.onExhausted, ['requeue', 'fail', 'pause'])}</div>${field('Total attempts', 'recovery.totalAttempts', n.recovery?.totalAttempts, 'number', 'min="1"')}`, 'Repair остаётся внутри того же Workplace; новый worker приходит к тому же столу.')
      + section('После приёмки', field('Post-acceptance effect', 'postAcceptanceEffect', n.postAcceptanceEffect), 'Опциональный package-registered effect; пусто = никакого эффекта.');
  }

  function kernelInspector(n) {
    return section('Kernel contract', field('Handler', 'handler', n.handler) + field('Input schema', 'inputSchema', n.inputSchema) + field('Output schema', 'outputSchema', n.outputSchema), 'Детерминированная станция. Не нанимает worker.')
      + section('Outcome', field('Emits terminal outcome', 'terminalOutcome', n.terminalOutcome), 'Для process-outcome-emitter укажите код outcome.');
  }

  function humanInspector(n) {
    return section('Human interaction', field('Interaction contract', 'interactionContract', n.interactionContract) + field('Input schema', 'inputSchema', n.inputSchema) + field('Output schema', 'outputSchema', n.outputSchema), 'Durable human decision boundary.');
  }

  function outgoingInspector(n) {
    const edges = W.state.design.transitions.filter((e) => e.from === n.id);
    return section('Выходы', edges.map((e) => `<div class="transition-row"><div class="transition-card"><b>→ ${E(e.to)}</b><input data-out-event="${E(e.id)}" value="${E(e.on)}"></div><button class="mini" data-remove-edge="${E(e.id)}">×</button></div>`).join('') || '<p class="section-note">Нет исходящих переходов.</p>', 'Событие определяет, по какому route покидается узел.');
  }

  function bindNode(root, n) {
    root.querySelectorAll('[data-bind]').forEach((el) => {
      const event = el.tagName === 'TEXTAREA' ? 'input' : 'change';
      el.addEventListener(event, () => {
        const path = el.dataset.bind;
        if (path === 'id') {
          renameNode(n, el.value);
          return;
        }
        const numeric = el.type === 'number';
        setPath(n, path, numeric ? (el.value === '' ? '' : Number(el.value)) : el.value);
        W.changed?.({ render: false });
        W.renderNodes();
        W.renderEdges();
        W.renderStatus();
      });
    });
    W.byId('set-entry').addEventListener('click', () => {
      W.state.design.entryNodeId = n.id;
      W.changed?.();
    });
    W.byId('toggle-terminal').addEventListener('click', () => {
      const a = W.state.design.terminalNodeIds;
      a.includes(n.id) ? a.splice(a.indexOf(n.id), 1) : a.push(n.id);
      W.changed?.();
    });
    if (n.kind === 'production-cell') bindCellActions(root, n);
    root.querySelectorAll('[data-out-event]').forEach((el) => el.addEventListener('input', () => {
      const e = W.edgeById(el.dataset.outEvent);
      if (e) e.on = el.value;
      W.changed?.({ render: false });
      W.renderEdges();
      W.renderStatus();
    }));
    root.querySelectorAll('[data-remove-edge]').forEach((el) => el.addEventListener('click', () => {
      W.state.design.transitions = W.state.design.transitions.filter((e) => e.id !== el.dataset.removeEdge);
      W.changed?.();
    }));
  }

  function bindCellActions(root, n) {
    W.byId('add-input')?.addEventListener('click', () => {
      const el = W.byId('new-input');
      const v = el.value.trim();
      if (!v) return;
      n.inputSelectors = n.inputSelectors || [];
      n.inputSelectors.push(v);
      W.changed?.();
    });
    root.querySelectorAll('[data-remove-input]').forEach((el) => el.addEventListener('click', () => {
      n.inputSelectors.splice(Number(el.dataset.removeInput), 1);
      W.changed?.();
    }));
    W.byId('add-product')?.addEventListener('click', () => {
      n.productContracts = n.productContracts || [];
      n.productContracts.push({ binding: `product-${n.productContracts.length + 1}`, schemaRef: 'schema.v1', mediaType: 'application/json', cardinality: '1' });
      W.changed?.();
    });
    root.querySelectorAll('[data-remove-product]').forEach((el) => el.addEventListener('click', () => {
      n.productContracts.splice(Number(el.dataset.removeProduct), 1);
      W.changed?.();
    }));
    root.querySelectorAll('[data-product-schema]').forEach((el) => el.addEventListener('input', () => {
      n.productContracts[Number(el.dataset.productSchema)].schemaRef = el.value;
      W.changed?.({ render: false });
      W.renderNodes();
      W.renderStatus();
    }));
    W.byId('review-enabled')?.addEventListener('change', (event) => {
      const enabled = event.target.checked;
      n.review = n.review || {};
      Object.assign(n.review, {
        enabled,
        ...(enabled && !n.review.skillRef ? { skillRef: 'reviewer-skill', capabilityPreset: 'review-readonly', verdictSchemaRef: 'factory.review-verdict.v1', finalGateId: `${n.id}.final` } : {}),
      });
      W.changed?.();
    });
  }

  function renameNode(n, raw) {
    const next = W.slug(raw);
    if (next === n.id) return;
    if (W.state.design.nodes.some((x) => x !== n && x.id === next)) {
      W.toast?.(`Node id «${next}» уже существует.`);
      W.renderInspector();
      return;
    }
    const prev = n.id;
    n.id = next;
    W.state.design.transitions.forEach((e) => {
      if (e.from === prev) e.from = next;
      if (e.to === prev) e.to = next;
    });
    if (W.state.design.entryNodeId === prev) W.state.design.entryNodeId = next;
    W.state.design.terminalNodeIds = W.state.design.terminalNodeIds.map((id) => id === prev ? next : id);
    W.state.selectedNodeId = next;
    W.changed?.();
  }
})();

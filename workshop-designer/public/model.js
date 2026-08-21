window.WD = window.WD || {};
(() => {
  const W = window.WD;
  W.STORAGE_KEY = 'saga.workshop-designer.v0';
  W.byId = (id) => document.getElementById(id);
  W.clone = (v) => JSON.parse(JSON.stringify(v));
  W.slug = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'node';
  W.escape = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  W.uid = (p='id') => `${p}-${Math.random().toString(36).slice(2,8)}`;
  W.edge = (from,to,on) => ({ id: W.uid('edge'), from, to, on });

  W.makeCell = (id,label,x,y,inputSchema,outputSchema,authorSkill='author-skill',reviewerSkill='reviewer-skill') => ({
    id, kind:'production-cell', label, description:'', x, y, inputSchema, outputSchema,
    inputSelectors:[inputSchema],
    productContracts:[{binding:'primary',schemaRef:outputSchema,mediaType:'application/json',cardinality:'1'}],
    author:{skillRef:authorSkill,capabilityPreset:'standard-author'},
    authorGate:{gateId:`${id}.author`,checkPlanRef:`${id}.checks`},
    review:{enabled:true,skillRef:reviewerSkill,capabilityPreset:'review-readonly',verdictSchemaRef:'factory.review-verdict.v1',finalGateId:`${id}.final`},
    recovery:{maxAttempts:5,onExhausted:'requeue',totalAttempts:30},
    postAcceptanceEffect:''
  });
  W.makeKernel = (id,label,x,y,inputSchema='',outputSchema='') => ({id,kind:'kernel',label,description:'',x,y,inputSchema,outputSchema,handler:id,terminalOutcome:''});
  W.makeHuman = (id,label,x,y) => ({id,kind:'human',label,description:'',x,y,inputSchema:'',outputSchema:'',interactionContract:'human.decision.v1'});
  const terminal = (id,label,x,y,outcome) => ({...W.makeKernel(id,label,x,y),handler:'process-outcome-emitter',terminalOutcome:outcome});

  W.template = {
    schemaVersion:'workshop-designer.v0', id:'factory.formalization.standard', version:'2.0.0',
    displayName:'Solution Formalization',
    description:'Converts an accepted discovery subject into a frozen, traceable and implementable solution contract.',
    inputContract:'formalization.case.v1', outputContract:'solution-contract-certificate.v1',
    entryNodeId:'define-product-contract', terminalNodeIds:['complete-formalized','complete-inconsistent','complete-failed'],
    nodes:[
      W.makeCell('define-product-contract','Define Product Contract',90,110,'formalization.case.v1','formalization.product-bundle.v1','formalization-product','formalization-requirements-reviewer'),
      W.makeCell('model-use-cases','Model Use Cases',390,110,'formalization.product-bundle.v1','formalization.use-case-bundle.v1','formalization-use-cases','formalization-requirements-reviewer'),
      W.makeCell('define-acceptance-contract','Define Acceptance Contract',690,110,'formalization.use-case-bundle.v1','formalization.acceptance-bundle.v1','formalization-acceptance','formalization-requirements-reviewer'),
      W.makeCell('reconcile-what','Reconcile WHAT Contract',990,110,'formalization.acceptance-bundle.v1','formalization.reconciliation.v1','formalization-reconciler','formalization-requirements-reviewer'),
      W.makeKernel('freeze-acceptance-baseline','Freeze Acceptance Baseline',1260,125,'formalization.reconciliation.v1','acceptance-baseline-snapshot.v1'),
      W.makeCell('define-architecture-contract','Define Architecture Contract',1260,390,'acceptance-baseline-snapshot.v1','formalization.architecture-bundle.v1','formalization-architect','formalization-architecture-reviewer'),
      W.makeKernel('settle-formalization','Settle Formalization',940,405,'formalization.architecture-bundle.v1','solution-contract-certificate.v1'),
      terminal('complete-formalized','Complete: formalized',660,405,'formalized'),
      terminal('complete-inconsistent','Complete: inconsistent',390,405,'inconsistent'),
      terminal('complete-failed','Complete: failed',90,405,'failed')
    ],
    transitions:[
      W.edge('define-product-contract','model-use-cases','domain.accepted'), W.edge('define-product-contract','complete-failed','domain.failed'),
      W.edge('model-use-cases','define-acceptance-contract','domain.accepted'), W.edge('model-use-cases','complete-failed','domain.failed'),
      W.edge('define-acceptance-contract','reconcile-what','domain.accepted'), W.edge('define-acceptance-contract','complete-failed','domain.failed'),
      W.edge('reconcile-what','freeze-acceptance-baseline','domain.accepted'), W.edge('reconcile-what','complete-failed','domain.failed'),
      W.edge('freeze-acceptance-baseline','define-architecture-contract','domain.frozen'), W.edge('freeze-acceptance-baseline','complete-inconsistent','domain.drift-detected'), W.edge('freeze-acceptance-baseline','complete-failed','domain.failed'),
      W.edge('define-architecture-contract','settle-formalization','domain.accepted'), W.edge('define-architecture-contract','complete-failed','domain.failed'),
      W.edge('settle-formalization','complete-formalized','domain.formalized'), W.edge('settle-formalization','complete-inconsistent','domain.inconsistent'), W.edge('settle-formalization','complete-failed','domain.failed')
    ]
  };

  W.load = () => {
    try { const raw = localStorage.getItem(W.STORAGE_KEY); if (raw) return W.normalize(JSON.parse(raw)); } catch {}
    return W.clone(W.template);
  };
  W.normalize = (d) => ({...W.clone(W.template),...d,nodes:Array.isArray(d?.nodes)?d.nodes:[],transitions:Array.isArray(d?.transitions)?d.transitions.map(e=>({id:e.id||W.uid('edge'),...e})):[],terminalNodeIds:Array.isArray(d?.terminalNodeIds)?d.terminalNodeIds:[]});
  W.state = { design:W.load(), selectedNodeId:null, selectedEdgeId:null, connectingFrom:null, mode:'design', dirty:false };
  W.node = (id) => W.state.design.nodes.find(n=>n.id===id);
  W.edgeById = (id) => W.state.design.transitions.find(e=>e.id===id);
})();

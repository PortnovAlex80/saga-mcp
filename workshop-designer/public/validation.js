window.WD = window.WD || {};
(() => {
  const W = window.WD;

  function reachability(d,start){const seen=new Set(),q=start?[start]:[];while(q.length){const id=q.shift();if(seen.has(id))continue;seen.add(id);for(const e of d.transitions)if(e.from===id&&!seen.has(e.to))q.push(e.to)}return seen}
  function duplicates(edges){const c=new Map();for(const e of edges){const k=`${e.from}::${e.on}`;c.set(k,(c.get(k)||0)+1)}return [...c].filter(([,n])=>n>1).map(([k])=>k.replace('::',' + '))}
  function cycle(d){const color=new Map(),stack=[];const visit=id=>{color.set(id,1);stack.push(id);for(const e of d.transitions.filter(x=>x.from===id)){if(color.get(e.to)===1)return [...stack.slice(stack.indexOf(e.to)),e.to];if(!color.get(e.to)){const c=visit(e.to);if(c)return c}}stack.pop();color.set(id,2);return null};for(const n of d.nodes)if(!color.get(n.id)){const c=visit(n.id);if(c)return c}return null}

  W.validate = (d) => {
    const out=[]; const add=(level,name,detail)=>out.push({level,name,detail});
    const ids=d.nodes.map(n=>n.id), set=new Set(ids);
    add(d.id&&d.version&&d.displayName?'pass':'fail','Идентичность цеха',d.id&&d.version&&d.displayName?`${d.id}@${d.version}`:'Заполните id, version и displayName.');
    add(d.inputContract&&d.outputContract?'pass':'fail','Граница Process Module',d.inputContract&&d.outputContract?`${d.inputContract} → ${d.outputContract}`:'Нужны inputContract и outputContract.');
    add(set.size===ids.length&&ids.every(Boolean)?'pass':'fail','Уникальные node identities',set.size===ids.length?'Все node ID уникальны.':'Есть пустые или повторяющиеся node ID.');
    const entry=d.nodes.find(n=>n.id===d.entryNodeId); add(entry?'pass':'fail','Entry node',entry?entry.id:'entryNodeId не указывает на существующий узел.');
    const terminals=d.terminalNodeIds.length>0&&d.terminalNodeIds.every(id=>set.has(id)); add(terminals?'pass':'fail','Terminal nodes',terminals?`${d.terminalNodeIds.length} terminal node(s).`:'Нужен минимум один существующий terminal node.');
    const broken=d.transitions.filter(e=>!set.has(e.from)||!set.has(e.to)||!String(e.on||'').trim()); add(broken.length?'fail':'pass','Ссылочная целостность переходов',broken.length?`${broken.length} переходов имеют неверный from/to/on.`:'Все переходы типизированы и ссылаются на существующие узлы.');
    const dup=duplicates(d.transitions); add(dup.length?'warn':'pass','Детерминизм маршрутизации',dup.length?`Повтор from+event: ${dup.join(', ')}.`:'Нет неоднозначных from+event маршрутов.');

    const cells=d.nodes.filter(n=>n.kind==='production-cell');
    const badProducts=cells.filter(n=>!n.inputSelectors?.length||!n.productContracts?.length||n.productContracts.some(p=>!p.binding||!p.schemaRef)); add(badProducts.length?'fail':'pass','Production Cell material contracts',badProducts.length?`Неполные контракты: ${badProducts.map(n=>n.id).join(', ')}.`:`${cells.length} Production Cell имеют inputs и products.`);
    const badAuthor=cells.filter(n=>!n.author?.skillRef||!n.author?.capabilityPreset||!n.authorGate?.gateId); add(badAuthor.length?'fail':'pass','Author + ОТК',badAuthor.length?`Неполный author/gate: ${badAuthor.map(n=>n.id).join(', ')}.`:'У каждого стола есть author profile и Gate.');
    const badReview=cells.filter(n=>n.review?.enabled&&(!n.review.skillRef||!n.review.verdictSchemaRef||!n.review.finalGateId||/write|author/i.test(n.review.capabilityPreset||''))); add(badReview.length?'fail':'pass','Независимость reviewer',badReview.length?`Проверьте reviewer contract: ${badReview.map(n=>n.id).join(', ')}.`:'Reviewer отделён от author и использует review-only capability.');
    const badRecovery=cells.filter(n=>!Number.isInteger(Number(n.recovery?.maxAttempts))||Number(n.recovery?.maxAttempts)<1||(n.recovery?.totalAttempts!==''&&Number(n.recovery?.totalAttempts)<Number(n.recovery?.maxAttempts))); add(badRecovery.length?'fail':'pass','Bounded recovery',badRecovery.length?`Невалидный recovery budget: ${badRecovery.map(n=>n.id).join(', ')}.`:'Repair loops имеют конечный budget.');
    const pause=cells.filter(n=>n.recovery?.onExhausted==='pause'); add(pause.length?'warn':'pass','No-human quality loop',pause.length?`pause требует human/infra boundary: ${pause.map(n=>n.id).join(', ')}.`:'Quality cells не паркуют линию на человека.');

    const reachable=entry?reachability(d,d.entryNodeId):new Set(); const unreachable=d.nodes.filter(n=>!reachable.has(n.id)); add(unreachable.length?'fail':'pass','Reachability',unreachable.length?`Недостижимые: ${unreachable.map(n=>n.id).join(', ')}.`:'Все узлы достижимы от entry.');
    const terminalReach=d.terminalNodeIds.filter(id=>reachable.has(id)); add(terminalReach.length===d.terminalNodeIds.length&&d.terminalNodeIds.length?'pass':'fail','Terminal reachability',terminalReach.length===d.terminalNodeIds.length?'Все terminal outcomes достижимы.':'Не все terminal outcomes достижимы.');
    const c=cycle(d); add(c?'warn':'pass','Flow topology',c?`Внешний cycle: ${c.join(' → ')}. Repair должен жить внутри Production Cell.`:'Внешний flow ацикличен; repair остаётся внутренним loop стола.');
    const forbidden=d.nodes.filter(n=>!['production-cell','kernel','human','composite'].includes(n.kind)); add(forbidden.length?'fail':'pass','Разрешённые physical node kinds',forbidden.length?`Запрещённые: ${forbidden.map(n=>n.kind).join(', ')}.`:'Нет external/backdoor node kinds.');
    return out;
  };
})();

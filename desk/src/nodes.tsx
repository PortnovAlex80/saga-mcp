import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { DeskNode } from './graph';

// Один кастомный узел 'saga' на все типы: цвет и подпись определяет
// data.sagaType. Слева target (вход), справа source (выход) — как у n8n.

const STYLE: Record<string, { accent: string; glyph: string }> = {
  emit: { accent: '#4ade80', glyph: '⏺' },
  template: { accent: '#60a5fa', glyph: '✎' },
  collect: { accent: '#f472b6', glyph: '⤵' },
  fail: { accent: '#f87171', glyph: '✕' },
  llm: { accent: '#a78bfa', glyph: '✦' },
  gate: { accent: '#fbbf24', glyph: '⚖' },
  effect: { accent: '#2dd4bf', glyph: '⚡' },
};

const STATUS_BADGE: Record<string, { glyph: string; title: string }> = {
  queued: { glyph: '…', title: 'в очереди' },
  running: { glyph: '▶', title: 'выполняется' },
  done: { glyph: '✓', title: 'принято' },
  failed: { glyph: '✗', title: 'отказ' },
  wait: { glyph: '⏳', title: 'ожидание (gate/оператор)' },
};

export function SagaNode({ data, selected }: NodeProps<DeskNode>) {
  const style = STYLE[data.sagaType] ?? { accent: '#94a3b8', glyph: '?' };
  const badge = data.status ? STATUS_BADGE[data.status] : undefined;
  return (
    <div className={`saga-node${selected ? ' selected' : ''}${data.status ? ` st-${data.status}` : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="saga-node-head" style={{ background: style.accent }}>
        <span>{style.glyph}</span>
        <span className="saga-node-type">{data.sagaType}</span>
        {badge && <span className={`st-badge st-${data.status}`} title={badge.title}>{badge.glyph}</span>}
      </div>
      <div className="saga-node-body">
        <code>{JSON.stringify(data.parameters)}</code>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const nodeTypes = { saga: SagaNode };

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { DeskNode } from './graph';

// Один кастомный узел 'saga' на все типы: цвет и подпись определяет
// data.sagaType. Слева target (вход), справа source (выход) — как у n8n.

const STYLE: Record<string, { accent: string; glyph: string }> = {
  emit: { accent: '#4ade80', glyph: '⏺' },
  template: { accent: '#60a5fa', glyph: '✎' },
  collect: { accent: '#f472b6', glyph: '⤵' },
  fail: { accent: '#f87171', glyph: '✕' },
};

export function SagaNode({ data, selected }: NodeProps<DeskNode>) {
  const style = STYLE[data.sagaType] ?? { accent: '#94a3b8', glyph: '?' };
  return (
    <div className={`saga-node${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="saga-node-head" style={{ background: style.accent }}>
        <span>{style.glyph}</span>
        <span className="saga-node-type">{data.sagaType}</span>
      </div>
      <div className="saga-node-body">
        <code>{JSON.stringify(data.parameters)}</code>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const nodeTypes = { saga: SagaNode };

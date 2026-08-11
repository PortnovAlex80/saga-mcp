export function createRepeatedToolLoopDetector({ limit = 12 } = {}) {
  let buffer = '';
  let lastSignature = null;
  let repetitions = 0;
  let tripped = false;
  return {
    push(chunk) {
      if (tripped) return null;
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event?.type !== 'assistant' || !Array.isArray(event.message?.content)) continue;
        for (const item of event.message.content) {
          if (item?.type !== 'tool_use' || typeof item.name !== 'string') continue;
          const signature = JSON.stringify([item.name, item.input ?? null]);
          if (signature === lastSignature) repetitions += 1;
          else { lastSignature = signature; repetitions = 1; }
          if (repetitions < limit) continue;
          tripped = true;
          return { tool: item.name, repetitions, signature };
        }
      }
      return null;
    },
  };
}

const PRIMARY_ARTIFACT_TYPE_ORDER = Object.freeze([
  'PRD', 'FR', 'NFR', 'RULE', 'UC', 'AC', 'SRS',
  'decision', 'theme', 'brief',
]);

export function orderedArtifactTypes(artifacts) {
  const present = new Set(
    (Array.isArray(artifacts) ? artifacts : [])
      .map(artifact => artifact?.type)
      .filter(type => typeof type === 'string' && type.length > 0),
  );
  const primary = PRIMARY_ARTIFACT_TYPE_ORDER.filter(type => present.delete(type));
  return [...primary, ...[...present].sort((left, right) => left.localeCompare(right))];
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function markdownValue(value) {
  if (Array.isArray(value)) {
    return value.length > 0
      ? value.map(item => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n')
      : '_none_';
  }
  if (value && typeof value === 'object') {
    return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  }
  if (value === null || value === undefined || value === '') return '_not recorded_';
  return String(value);
}

function payloadMarkdown(title, payload) {
  const lines = [`# ${title}`, ''];
  for (const [key, value] of Object.entries(payload)) {
    lines.push(`## ${key.replaceAll('_', ' ')}`, '', markdownValue(value), '');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Return a safe database-backed document projection when an artifact's
 * declared repository file is absent. This never invents product content:
 * module-provided document_markdown or a durable brief_payload is rendered
 * verbatim; otherwise only the authoritative artifact record is shown.
 */
export function artifactFallbackDocument(artifact) {
  const metadata = parseObject(artifact?.metadata);
  if (
    typeof metadata.document_markdown === 'string'
    && metadata.document_markdown.trim() !== ''
  ) {
    return {
      markdown: metadata.document_markdown,
      source: 'database document projection',
    };
  }

  const briefPayload = parseObject(metadata.brief_payload);
  if (Object.keys(briefPayload).length > 0) {
    return {
      markdown: payloadMarkdown(artifact?.title || 'Discovery Brief', briefPayload),
      source: 'database brief payload',
    };
  }

  const lines = [
    `# ${artifact?.title || 'Artifact'}`,
    '',
    '> The repository file is absent. This page is the durable database record, not reconstructed product content.',
    '',
    `- Type: ${artifact?.type || 'unknown'}`,
    `- Code: ${artifact?.code || 'none'}`,
    `- Status: ${artifact?.status || 'unknown'}`,
    `- Declared path: ${artifact?.path || 'none'}`,
  ];
  if (artifact?.content_hash) lines.push(`- Content hash: ${artifact.content_hash}`);
  if (artifact?.accepted_hash) lines.push(`- Accepted hash: ${artifact.accepted_hash}`);
  if (artifact?.drift_state) lines.push(`- Drift state: ${artifact.drift_state}`);
  return {
    markdown: lines.join('\n'),
    source: 'database artifact record',
  };
}

/**
 * md-site/src/render.mjs - the markdown documentation-site generator (plan
 * EK-11 P08): compiles content.md into a self-contained HTML page with the
 * render target the browser smoke verifies. Deterministic; no dependencies.
 */

/** Render one markdown subset (headings, paragraphs, lists, code, links). */
export function renderMarkdown(markdown) {
  const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const inline = (text) => escape(text)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const lines = markdown.split(/\r\n|\r|\n/);
  const html = [];
  let listOpen = false;
  let codeOpen = false;
  const closeList = () => { if (listOpen) { html.push('</ul>'); listOpen = false; } };
  for (const line of lines) {
    if (codeOpen) {
      if (/^```$/.test(line)) { html.push('</code></pre>'); codeOpen = false; }
      else html.push(`${escape(line)}\n`);
      continue;
    }
    if (/^```/.test(line)) { closeList(); html.push('<pre><code>'); codeOpen = true; continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { closeList(); const level = heading[1].length; html.push(`<h${level}>${inline(heading[2])}</h${level}>`); continue; }
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) { if (!listOpen) { html.push('<ul>'); listOpen = true; } html.push(`<li>${inline(item[1])}</li>`); continue; }
    if (line.trim().length === 0) { closeList(); continue; }
    closeList();
    html.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (codeOpen) throw new Error('unclosed code fence');
  return html.join('\n');
}

/** The full site document for one markdown page. */
export function renderSite(markdown, title = 'md-site') {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    `  <title>${title}</title>`,
    '</head>',
    '<body>',
    '  <main id="md-root">',
    renderMarkdown(markdown),
    '  </main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

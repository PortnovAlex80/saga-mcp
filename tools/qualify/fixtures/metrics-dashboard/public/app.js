/* metrics-dashboard/public/app.js - the read-only dashboard frontend: loads
   the summary and the series from the API and renders them. */
async function refresh() {
  const summary = await (await fetch('/api/metrics/summary')).json();
  document.getElementById('requests').textContent = String(summary.totals.requests);
  document.getElementById('errors').textContent = String(summary.totals.errors);
  document.getElementById('latency').textContent = `${summary.totals.meanLatencyMs} ms`;
  const document_ = await (await fetch('/api/metrics')).json();
  const table = document.getElementById('series');
  table.replaceChildren(...document_.series.slice(0, 10).map((row) => {
    const tr = document.createElement('tr');
    for (const value of [row.day, row.requests, row.errors, row.latencyMs]) {
      const td = document.createElement('td');
      td.textContent = String(value);
      tr.appendChild(td);
    }
    return tr;
  }));
}

refresh();

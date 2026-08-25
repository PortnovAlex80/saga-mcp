// static-site/public/app.js - the static product asset: it wires the
// stylesheet onto the render target and exposes the deterministic build
// stamp. No server, no fetch - a static product is fully materialized.
(function wire() {
  var root = document.getElementById('static-root');
  if (!root) return;
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/assets/style.css';
  document.head.appendChild(link);
  root.dataset.staticProduct = 'built';
})();

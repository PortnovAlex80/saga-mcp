/**
 * simple-server/public/app.js - the served frontend: fetches /api/message
 * and renders the returned value into #message (the integration the
 * acceptance contract owns).
 */
(async function renderMessage() {
  const target = document.getElementById('message');
  if (!target) throw new Error('simple-server frontend: #message element missing from the browser entry');
  try {
    const response = await fetch('/api/message');
    if (!response.ok) throw new Error('api status ' + response.status);
    const payload = await response.json();
    target.textContent = String(payload.message) + ' (code ' + String(payload.code) + ')';
  } catch (error) {
    target.textContent = 'failed to load message';
    throw error;
  }
})();

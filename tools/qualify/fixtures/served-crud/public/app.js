/* served-crud/public/app.js - the browser frontend: loads the item list from
   the API and renders it into the declared target; the form creates items. */
async function refresh() {
  const response = await fetch('/api/items');
  const payload = await response.json();
  const list = document.getElementById('item-list');
  list.replaceChildren(...payload.items.map((item) => {
    const li = document.createElement('li');
    li.dataset.id = String(item.id);
    li.textContent = item.done ? `[done] ${item.title}` : item.title;
    return li;
  }));
}

document.getElementById('new-item').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.getElementById('item-title');
  const title = input.value.trim();
  if (title.length === 0) return;
  await fetch('/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  input.value = '';
  await refresh();
});

refresh();

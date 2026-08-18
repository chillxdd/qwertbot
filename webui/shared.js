export const $ = (id) => document.getElementById(id);
export const esc = (v) => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');

export async function postJson(url, body = {}) {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let data;
  try { data = await response.json(); } catch (_) { data = { success: false, error: `HTTP ${response.status}` }; }
  if (response.status === 401 && url !== '/mod-login') {
    window.dispatchEvent(new CustomEvent('dashboard-auth-expired', { detail: data }));
  }
  return data;
}

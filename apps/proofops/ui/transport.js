// Owner capabilities are sent only in headers on same-origin run/task routes.
const tokens = new Map();
const runPath = /^\/api\/(?:runs|tasks)\/(run_\d{14}_[0-9a-f]{8,16})(?:\/|$)/;
export function rememberOwner(id, token) {
  if (typeof token === 'string' && token) tokens.set(id, token);
}
export function ownerHeaders(path) {
  const url = new URL(path, location.href);
  if (url.origin !== location.origin) return {};
  const id = runPath.exec(url.pathname)?.[1];
  return id && tokens.has(id) ? { 'x-run-token': tokens.get(id) } : {};
}
export function ownerFetch(path, options = {}) {
  return fetch(path, { ...options, headers: { ...ownerHeaders(path), ...(options.headers || {}) } });
}
export async function protectedImage(img, path) {
  img.dataset.requestPath = path;
  if (!Object.keys(ownerHeaders(path)).length) { img.src = path; return; }
  const r = await ownerFetch(path);
  if (!r.ok) { img.alt = 'Screenshot unavailable: access expired or service unavailable'; return; }
  const blob = await r.blob();
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  if (img.dataset.requestPath !== path) return;
  // The existing CSP permits data: images, not blob: images. No policy weakening required.
  img.src = data;
}
export function protectedLink(link) {
  if (!runPath.test(new URL(link.href, location.href).pathname)) return;
  link.addEventListener('click', async e => {
    e.preventDefault();
    try {
      const r = await ownerFetch(link.href);
      if (!r.ok) throw new Error('unavailable');
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a'); a.href = url;
      a.download = new URL(link.href).pathname.split('/').pop() || 'evidence';
      a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch { link.textContent = 'Evidence unavailable. Access may have expired.'; }
  });
}

// Small SSE client: UTF-8 chunk boundaries, replay IDs, bounded reconnect and owner headers.
export class OwnerStream {
  constructor(path) {
    this.path = path; this.listeners = new Map(); this.readyState = 0; this.lastId = '';
    this.closed = false; this.attempts = 0; this.errorStatus = null;
    queueMicrotask(() => this.connect());
  }
  addEventListener(type, fn) { const a = this.listeners.get(type) || []; a.push(fn); this.listeners.set(type, a); }
  emit(type, data) { for (const fn of this.listeners.get(type) || []) fn({ data }); }
  close() { this.closed = true; this.readyState = 2; this.abort?.abort(); clearTimeout(this.timer); }
  async connect() {
    if (this.closed) return;
    this.abort = new AbortController();
    try {
      const r = await ownerFetch(this.path, { signal: this.abort.signal, headers: this.lastId ? { 'last-event-id': this.lastId } : {} });
      if (!r.ok || !r.body) { this.errorStatus = r.status; throw new Error('stream unavailable'); }
      this.readyState = 1;
      const reader = r.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      while (!this.closed) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
          let type = 'message', data = [], id;
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) type = line.slice(6).trim();
            if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            if (line.startsWith('id:')) id = line.slice(3).trim();
          }
          if (id) this.lastId = id;
          if (data.length) { this.attempts = 0; this.emit(type, data.join('\n')); }
        }
      }
      if (!this.closed) throw new Error('stream ended');
    } catch {
      if (this.closed) return;
      const denied = [401, 403, 404].includes(this.errorStatus);
      this.readyState = denied || ++this.attempts >= 4 ? 2 : 0;
      this.onerror?.();
      if (this.readyState !== 2) this.timer = setTimeout(() => this.connect(), Math.min(this.attempts * 1000, 3000));
    }
  }
}

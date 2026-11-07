// A tiny fake DOM for testing client views in Node (no browser needed). The real-browser run (npm run e2e) covers the rest.
export class FakeText { constructor(t) { this.nodeType = 3; this.textContent = t; } }
export class FakeElement {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.kids = []; this.dataset = {}; this.listeners = {}; this.className = ''; this.focused = false; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, fn) { this.listeners[t] = fn; }
  append(...nodes) { this.kids.push(...nodes); }
  replaceChildren() { this.kids = []; }
  focus() { this.focused = true; }
}
export const walk = (node, fn) => { fn(node); for (const k of node.kids ?? []) walk(k, fn); };
export const find = (root, pred) => { let hit = null; walk(root, (n) => { if (!hit && n.nodeType === 1 && pred(n)) hit = n; }); return hit; };
export const textOf = (root) => { let t = ''; walk(root, (n) => { if (n.nodeType === 3) t += n.textContent; }); return t; };
export const byId = (root, id) => find(root, (n) => n.attrs.id === id);
export const button = (root, label) => find(root, (n) => n.tagName === 'button' && textOf(n) === label);
export const submit = async (form) => { await form.listeners.submit({ preventDefault() {} }); await new Promise((r) => setImmediate(r)); };
export const click = async (el) => { await el.listeners.click(); await new Promise((r) => setImmediate(r)); };

export function withDom(fn) {
  return async (t) => {
    globalThis.document = { createElement: (tag) => new FakeElement(tag), createTextNode: (x) => new FakeText(x) };
    globalThis.location = { origin: 'http://localhost:3000' };
    try { await fn(t); } finally { delete globalThis.document; delete globalThis.location; }
  };
}


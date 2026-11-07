// Tiny element builder. Strings are always inserted as text, never parsed as HTML, so player names,
// messages and news (all written by other players) cannot inject markup or scripts.
//
//   h('button', { class: 'btn', onClick: save, disabled: busy }, 'Save')
//   h('ul', {}, items.map((i) => h('li', {}, i.name)))

const applyAfterChildren = new Set(['value']); // a <select>'s value only sticks once its <option>s exist

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  const late = [];
  for (const [key, val] of Object.entries(props ?? {})) {
    if (val === undefined || val === null || val === false) continue;
    if (key === 'class') el.className = val;
    else if (key === 'dataset') Object.assign(el.dataset, val);
    else if (key.length > 2 && key.startsWith('on') && typeof val === 'function') el.addEventListener(key.slice(2).toLowerCase(), val);
    else if (applyAfterChildren.has(key)) late.push([key, val]);
    else if (['checked', 'disabled', 'selected', 'hidden', 'open', 'required', 'readOnly'].includes(key)) el[key] = true;
    else el.setAttribute(key, val === true ? '' : String(val));
  }
  append(el, children);
  for (const [key, val] of late) el[key] = val;
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(typeof child === 'object' && 'nodeType' in child ? child : document.createTextNode(String(child)));
  }
}

/** Replaces everything inside `el` with `children`. */
export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

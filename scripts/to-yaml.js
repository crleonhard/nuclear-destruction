// Tiny YAML emitter for plain JSON data (objects, arrays, strings, numbers, booleans, null).
// Strings are always emitted as JSON-quoted scalars, which are valid YAML, so no escaping rules to get wrong.

const scalar = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));
const key = (k) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : JSON.stringify(k));
const isContainer = (v) => v !== null && typeof v === 'object';
const isEmpty = (v) => (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);
const inline = (v) => (!isContainer(v) ? scalar(v) : Array.isArray(v) ? '[]' : '{}');

function render(v, ind) {
  return Array.isArray(v)
    ? v.map((x) => item(x, ind)).join('\n')
    : Object.entries(v).map(([k, x]) => entry(k, x, ind)).join('\n');
}
function entry(k, x, ind) {
  const pad = ' '.repeat(ind);
  if (isContainer(x) && !isEmpty(x)) return `${pad}${key(k)}:\n${render(x, ind + 2)}`;
  return `${pad}${key(k)}: ${inline(x)}`;
}
function item(x, ind) {
  const pad = ' '.repeat(ind);
  if (isContainer(x) && !isEmpty(x)) return `${pad}- ${render(x, ind + 2).slice(ind + 2)}`;
  return `${pad}- ${inline(x)}`;
}

export function toYaml(value) {
  return `${isContainer(value) && !isEmpty(value) ? render(value, 0) : inline(value)}\n`;
}

// A deliberately small JSON-Schema checker for the contract tests (no dependencies).
// Supports exactly what openapi.js uses: $ref, type (string or array), enum, const, properties,
// required, additionalProperties (boolean or schema), items, min/maxItems, minimum/maximum,
// min/maxLength, pattern, maxProperties, oneOf (exactly one), format: date-time.
// Anything else in a schema is ignored, so keep the spec within this subset.

export function resolveRef(spec, node) {
  let cur = node;
  const seen = new Set();
  while (cur && cur.$ref) {
    if (seen.has(cur.$ref)) throw new Error(`$ref cycle at ${cur.$ref}`);
    seen.add(cur.$ref);
    if (!cur.$ref.startsWith('#/')) throw new Error(`external $ref ${cur.$ref}`);
    cur = cur.$ref.slice(2).split('/').reduce((o, k) => {
      if (o == null || !(k in o)) throw new Error(`unresolved $ref ${node.$ref}`);
      return o[k];
    }, spec);
  }
  return cur;
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const matchesType = (v, t) => (t === 'number' ? typeof v === 'number' : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t);

/** Returns a list of human-readable problems; empty means the value conforms. */
export function check(spec, schema, value, path = '$') {
  const s = resolveRef(spec, schema);
  const problems = [];
  const add = (msg) => problems.push(`${path}: ${msg}`);

  if (s.oneOf) {
    const results = s.oneOf.map((sub) => check(spec, sub, value, path));
    const passing = results.filter((r) => r.length === 0).length;
    if (passing !== 1) {
      add(`must match exactly one of ${s.oneOf.length} alternatives, matched ${passing}` +
        (passing === 0 ? ` (${results.map((r) => r[0]).join(' | ')})` : ''));
    }
    return problems;
  }
  if ('const' in s && value !== s.const) { add(`expected ${JSON.stringify(s.const)}, got ${JSON.stringify(value)}`); return problems; }
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => matchesType(value, t))) { add(`expected ${types.join('|')}, got ${typeOf(value)}`); return problems; }
  }
  if (s.enum && !s.enum.includes(value)) add(`${JSON.stringify(value)} is not one of ${s.enum.slice(0, 6).join(', ')}${s.enum.length > 6 ? ', ...' : ''}`);

  if (typeof value === 'number') {
    if (s.minimum !== undefined && value < s.minimum) add(`${value} < minimum ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) add(`${value} > maximum ${s.maximum}`);
  }
  if (typeof value === 'string') {
    if (s.minLength !== undefined && value.length < s.minLength) add(`shorter than ${s.minLength}`);
    if (s.maxLength !== undefined && value.length > s.maxLength) add(`longer than ${s.maxLength}`);
    if (s.pattern && !new RegExp(s.pattern).test(value)) add(`${JSON.stringify(value)} does not match ${s.pattern}`);
    if (s.format === 'date-time' && Number.isNaN(Date.parse(value))) add(`${JSON.stringify(value)} is not a date-time`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) add(`fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && value.length > s.maxItems) add(`more than ${s.maxItems} items`);
    if (s.items) value.forEach((v, i) => problems.push(...check(spec, s.items, v, `${path}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (s.maxProperties !== undefined && keys.length > s.maxProperties) add(`more than ${s.maxProperties} properties`);
    for (const r of s.required ?? []) if (!(r in value)) add(`missing required "${r}"`);
    for (const k of keys) {
      if (s.properties?.[k]) problems.push(...check(spec, s.properties[k], value[k], `${path}.${k}`));
      else if (s.additionalProperties === false) add(`unexpected property "${k}"`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') {
        problems.push(...check(spec, s.additionalProperties, value[k], `${path}.${k}`));
      }
    }
  }
  return problems;
}

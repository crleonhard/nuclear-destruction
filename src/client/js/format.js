// Pure formatting helpers: no DOM, no network. Everything here is unit-tested in Node.

const ROMAN = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
export function roman(n) {
  let out = '';
  for (const [v, r] of ROMAN) while (n >= v) { out += r; n -= v; }
  return out;
}

/** "FRANCE" -> "France"; "USA" stays "USA". Works on country names, minor names and ids like "CUBA#2" (-> "Cuba (II)"). */
export function label(name) {
  if (!name) return '';
  const [base, gen] = String(name).split('#');
  const pretty = base === 'USA' ? 'USA' : base.charAt(0) + base.slice(1).toLowerCase();
  const g = Number(gen);
  return g > 1 ? `${pretty} (${roman(g)})` : pretty;
}

/** How AI players are described to people. Keep the keys in step with src/ai/personas.js (a test checks this). */
export const AI_STYLES = {
  HAWK: { label: 'Hawk', blurb: 'Builds missiles, declares war early and fires everything it has.' },
  DIPLOMAT: { label: 'Diplomat', blurb: 'Grows first, courts many minors, defends heavily and strikes late.' },
  OPPORTUNIST: { label: 'Opportunist', blurb: 'Balanced. Waits until it looks at least as strong as the rivals it has spied on.' },
};
export const aiStyleLabel = (key) => AI_STYLES[key]?.label ?? 'AI';

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Factories are held in thirds: 23 thirds is "7 2/3". */
export function thirdsText(thirds) {
  const whole = Math.floor(thirds / 3);
  const rest = thirds % 3;
  if (rest === 0) return String(whole);
  return whole === 0 ? `${rest}/3` : `${whole} ${rest}/3`;
}

/** Time left until an ISO deadline. */
export function countdown(deadlineIso, nowMs = Date.now()) {
  const ms = Date.parse(deadlineIso) - nowMs;
  if (!(ms > 0)) return { text: 'deadline passed', overdue: true, urgent: true };
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const hrs = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d >= 2) return { text: `${d}d ${hrs}h`, overdue: false, urgent: false };
  if (s >= 3600) return { text: `${Math.floor(s / 3600)}h ${m}m`, overdue: false, urgent: false };
  return { text: `${m}m ${String(s % 60).padStart(2, '0')}s`, overdue: false, urgent: true };
}

const SECTION = { build: 'Build', spies: 'Spies', declareWar: 'Declare war', worldNews: 'World news', offerFactory: 'Factory sale' };
const BUILD = { missiles: 'missile factories', abms: 'ABM factories', factories: 'new-factory builds' };
const TOTALS = { cash: 'Total cash given', missiles: 'Total missiles given', factories: 'Factories given and offered' };

/** Turns a server error `field` path into words a player understands. */
export function describeField(field) {
  if (!field || field === 'request') return '';
  const [head, a, b] = field.split('.');
  switch (head) {
    case 'build': return a ? `Build: ${BUILD[a] ?? a}` : 'Build';
    case 'giveCashToMinors': return `Cash to ${label(a)}`;
    case 'giveMissilesToMinors': return `Missiles to ${label(a)}`;
    case 'giveCashToEveryMinor': return 'Cash to every minor';
    case 'giveToPlayers': return b ? `${b[0].toUpperCase()}${b.slice(1)} to ${label(a)}` : `Gift to ${label(a)}`;
    case 'messages': return `Message to ${label(a)}`;
    case 'fire': return a === 'HOME' ? 'Fire from your home country' : `Fire from ${label(a)}`;
    default: break;
  }
  if (SECTION[head]) return SECTION[head];
  if (TOTALS[head]) return TOTALS[head];
  return head;
}

/** Groups server errors so each is shown once, with a readable field. */
export const prettyErrors = (errors) => errors.map((e) => ({ where: describeField(e.field), message: e.message, code: e.code }));

export const turnTypeLabel = (type) => (type === 'BATTLE' ? 'Battle turn' : 'Normal turn');

// The full record of a finished game: who won, every submitted sheet's source, and the event log.
// The server releases it only once the game is over, because it includes the game seed.
import { h, mount } from '../dom.js';
import { label, plural } from '../format.js';

export async function replayView({ api, outlet, params, flash }) {
  const id = Number(params.id);
  const back = h('p', {}, h('a', { href: `#/games/${id}` }, '← Back to the game'));
  mount(outlet, h('h1', {}, `Game #${id}: replay`), back, h('p', { class: 'muted' }, 'Loading…'));
  let r;
  try { r = await api.get(`/api/v1/games/${id}/replay`); } catch (err) {
    if (err.errors?.[0]?.code === 'GAME_NOT_FINISHED') {
      mount(outlet, h('h1', {}, `Game #${id}: replay`), back, h('div', { class: 'banner info' }, 'The replay is released when the game ends, because it reveals every player\'s orders.'));
    } else { flash('error', err.message); mount(outlet, h('h1', {}, `Game #${id}: replay`), back); }
    return {};
  }

  const byTurn = new Map();
  for (const s of r.sheets) { if (!byTurn.has(s.turn)) byTurn.set(s.turn, []); byTurn.get(s.turn).push(s); }
  const eventsHost = h('div');
  let drawn = false;
  const events = h('details', { onToggle: (e) => {
    if (!e.target.open || drawn) return;                     // build the (possibly long) table only when asked for
    drawn = true;
    mount(eventsHost, h('div', { class: 'scroll' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', { class: 'num' }, '#'), h('th', {}, 'Event'), h('th', {}, 'Details'))),
      h('tbody', {}, r.events.map((ev) => h('tr', {}, h('td', { class: 'num' }, ev.seq), h('td', {}, ev.type), h('td', {}, h('pre', { class: 'json' }, JSON.stringify(ev.payload)))))))));
  } }, h('summary', {}, `Event log (${r.events.length} events)`), eventsHost);

  const sheetRows = [...byTurn.entries()].flatMap(([turn, list]) => list.map((s) => h('tr', {},
    h('td', {}, turn),
    h('td', {}, label(s.player)),
    h('td', {}, s.source === 'SERVER_DEFAULT'
      ? 'Default (missed the deadline)'
      : h('details', {}, h('summary', {}, 'Submitted'), h('pre', { class: 'json' }, JSON.stringify(s.payload, null, 2)))))));
  const sheetsTable = h('div', { class: 'scroll' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Turn'), h('th', {}, 'Player'), h('th', {}, 'Orders'))),
    h('tbody', {}, sheetRows)));

  mount(outlet,
    h('h1', {}, `Game #${id}: replay`),
    back,
    h('div', { class: `banner ${r.outcome === 'WIN' ? 'win' : 'info'}` },
      r.outcome === 'WIN' ? `${label(r.winner)} won.` : 'Nobody won: everyone was destroyed on the same turn.'),
    h('section', { class: 'card' }, h('h2', {}, 'Summary'),
      h('p', {}, `${plural(r.turns.length, 'turn')} ${r.turns.length === 1 ? 'was' : 'were'} played. The random seed was `, h('code', {}, String(r.seed)), '. Every turn can be replayed exactly from the seed and the sheets.')),
    h('section', { class: 'card' }, h('h2', {}, 'Sheets by turn'),
      h('p', { class: 'hint' }, '"Default" means the player missed the deadline and the server filled in the standard orders.'),
      sheetsTable),
    h('section', { class: 'card' }, events));
  return {};
}

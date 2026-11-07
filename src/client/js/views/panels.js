// Read-only cards shown beside the sheet. Each takes plain data and returns an element (or null when empty).
import { h } from '../dom.js';
import { label, thirdsText, plural } from '../format.js';

const stat = (k, v) => h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));

export function assetsCard(assets) {
  if (!assets) return null;
  return h('section', { class: 'card' }, h('h2', {}, `Your country: ${label(assets.country)}`),
    h('div', { class: 'stats' },
      stat('Population (M)', assets.population), stat('Cash ($M)', assets.cash),
      stat('Factories', thirdsText(assets.thirds)), stat('Missiles', assets.missiles), stat('ABMs', assets.abms)));
}

export function playersCard(players, myCountry) {
  return h('section', { class: 'card' }, h('h2', {}, 'Players'),
    h('div', { class: 'scroll' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Country'), h('th', { class: 'num' }, 'Population (M)'), h('th', {}, 'Status'))),
      h('tbody', {}, players.map((p) => h('tr', {},
        h('td', {}, label(p.country), p.country === myCountry ? h('span', { class: 'chip you' }, 'you') : null),
        h('td', { class: 'num' }, p.population),
        h('td', {}, p.alive ? 'In the game' : h('span', { class: 'chip out' }, p.forfeited ? 'Forfeited' : 'Eliminated'))))))));
}

function spyLine(report) {
  const p = report.payload;
  if (report.kind === 'SPY_PLAYER') {
    return p.eliminated
      ? h('li', {}, `${label(p.country)} has been eliminated.`)
      : h('li', {}, h('strong', {}, label(p.country)), `: ${plural(p.missiles, 'missile')}, ${plural(p.abms, 'ABM')} (end of last turn).`);
  }
  if (report.kind === 'SPY_MINOR') {
    if (p.destroyed) return h('li', {}, `${label(p.minor)} was destroyed.`);
    const rows = Object.entries(p.indices).sort((a, b) => b[1] - a[1]);
    return h('li', {}, h('strong', {}, `Popularity in ${label(p.minor)}`),
      h('table', { class: 'data' }, h('tbody', {}, rows.map(([c, v]) => h('tr', {}, h('td', {}, label(c)), h('td', { class: 'num' }, v))))));
  }
  return null;
}

export function reportsCard(reports) {
  const spies = reports.filter((r) => r.kind === 'SPY_PLAYER' || r.kind === 'SPY_MINOR');
  const ranks = reports.find((r) => r.kind === 'FIRST_SECOND');
  if (!spies.length && !ranks) return null;
  return h('section', { class: 'card' }, h('h2', {}, 'Intelligence'),
    ranks ? h('p', {}, h('strong', {}, 'You rank first or second in: '), ranks.payload.minors.length ? ranks.payload.minors.map(label).join(', ') : 'no minors yet.',
      h('span', { class: 'hint' }, ' (Send a spy to a minor to see where exactly.)')) : null,
    spies.length ? h('ul', {}, spies.map(spyLine)) : null);
}

export function messagesCard(messages) {
  if (!messages.length) return null;
  return h('section', { class: 'card' }, h('h2', {}, 'Messages received'),
    h('ul', {}, messages.map((m) => h('li', {}, h('strong', {}, m.from ? label(m.from) : 'Anonymous'), ': ', m.text))));
}

export function newsCard(news) {
  if (!news.length) return null;
  return h('section', { class: 'card' }, h('h2', {}, 'World news'),
    h('ul', {}, news.map((n) => h('li', {}, n.text, n.from ? h('span', { class: 'muted' }, ` — ${label(n.from)}`) : null))));
}

export function battleCard(result, title = 'Last battle') {
  if (!result) return null;
  const fired = [...result.fired].sort((a, b) => b.n - a.n);
  return h('section', { class: 'card' }, h('h2', {}, title),
    fired.length ? h('div', { class: 'scroll' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'From'), h('th', {}, 'At'), h('th', { class: 'num' }, 'Missiles'))),
      h('tbody', {}, fired.map((f) => h('tr', {}, h('td', {}, label(f.from)), h('td', {}, label(f.to)), h('td', { class: 'num' }, f.n)))))) : h('p', {}, 'Nobody fired.'),
    result.damaged.length ? [h('h3', {}, 'Damage'), h('div', { class: 'scroll' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Country'), h('th', { class: 'num' }, 'Incoming'), h('th', { class: 'num' }, 'Stopped'), h('th', { class: 'num' }, 'Hit'), h('th', { class: 'num' }, 'Population left (M)'))),
      h('tbody', {}, result.damaged.map((d) => h('tr', {}, h('td', {}, label(d.target)), h('td', { class: 'num' }, d.incoming), h('td', { class: 'num' }, d.intercepted), h('td', { class: 'num' }, d.through), h('td', { class: 'num' }, d.population))))))]
      : h('p', { class: 'muted' }, 'Every missile was intercepted or missed.'));
}

export function minorsCard(minors) {
  return h('section', { class: 'card' }, h('details', {}, h('summary', {}, `The minor countries (${minors.filter((m) => !m.destroyed).length} left)`),
    h('div', { class: 'scroll' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Minor'), h('th', { class: 'num' }, 'Population (M)'), h('th', {}, 'Status'))),
      h('tbody', {}, minors.map((m) => h('tr', {}, h('td', {}, label(m.id)), h('td', { class: 'num' }, m.population), h('td', {}, m.destroyed ? 'Destroyed' : 'Standing'))))))));
}

// What every player could see about past turns: battle reports and world news. Nothing private.
import { h, mount } from '../dom.js';
import { label, turnTypeLabel } from '../format.js';
import { battleCard } from './panels.js';

export async function historyView({ api, outlet, params, flash }) {
  const id = Number(params.id);
  const back = h('p', {}, h('a', { href: `#/games/${id}` }, '← Back to the game'));
  mount(outlet, h('h1', {}, `Game #${id}: history`), back, h('p', { class: 'muted' }, 'Loading…'));
  try {
    const { turns } = await api.get(`/api/v1/games/${id}/history`);
    mount(outlet, h('h1', {}, `Game #${id}: history`), back,
      turns.length === 0 ? h('p', { class: 'muted' }, 'No turn has been resolved yet.')
        : [...turns].reverse().map((t) => h('div', {},
          h('h2', {}, `Turn ${t.number} · ${turnTypeLabel(t.type)}`),
          t.battleResult ? battleCard(t.battleResult, 'Battle') : null,
          t.news.length ? h('section', { class: 'card' }, h('h3', {}, 'World news'),
            h('ul', {}, t.news.map((n) => h('li', {}, n.text, n.from ? h('span', { class: 'muted' }, ` — ${label(n.from)}`) : null)))) : null,
          !t.battleResult && !t.news.length ? h('p', { class: 'muted' }, 'Nothing public happened this turn.') : null)));
  } catch (err) {
    flash('error', err.message);
    mount(outlet, h('h1', {}, `Game #${id}: history`), back, h('p', { class: 'muted' }, 'This history is only visible to the players of the game.'));
  }
  return {};
}

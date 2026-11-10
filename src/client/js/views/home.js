import { h, mount } from '../dom.js';
import { plural } from '../format.js';
import { loadEmailSettings } from './email-settings.js';

/** Pulls a game number out of "12", "#/games/12" or a full invite link. */
export function parseGameRef(text) {
  const m = String(text ?? '').trim().match(/(\d+)\s*\/?\s*$/);
  return m ? Number(m[1]) : null;
}

export async function homeView({ api, session, outlet, navigate, flash }) {
  const list = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));

  async function loadGames() {
    try {
      const { games } = await api.get('/api/v1/games');
      mount(list, games.length === 0
        ? h('p', { class: 'muted' }, 'You are not in any games yet. Create one, or join a friend\'s with their game number.')
        : h('div', { class: 'scroll' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Game'), h('th', {}, 'Status'), h('th', {}, 'Turn'), h('th', {}, ''))),
          h('tbody', {}, games.map((g) => h('tr', {},
            h('td', {}, `#${g.id}`),
            h('td', {}, h('span', { class: `chip ${g.status.toLowerCase()}` }, g.status === 'LOBBY' ? 'Waiting for players' : g.status === 'ACTIVE' ? 'In progress' : 'Finished')),
            h('td', {}, g.turnNumber ?? '—'),
            h('td', {}, h('a', { href: `#/games/${g.id}` }, g.status === 'FINISHED' ? 'View' : 'Open'))))))));
    } catch (err) { mount(list, h('p', { class: 'muted' }, 'Could not load your games.')); flash('error', err.message); }
  }

  const hours = h('input', { id: 'hours', type: 'number', min: 1, max: 168, step: 1, value: '24' });
  const forfeit = h('input', { id: 'forfeit', type: 'number', min: 0, max: 30, step: 1, value: '5' });
  const aiCount = h('input', { id: 'ai', type: 'number', min: 0, max: 8, step: 1, value: '0' });
  const create = h('form', {
    onSubmit: async (e) => {
      e.preventDefault();
      try {
        const { gameId } = await api.post('/api/v1/games', { turnDeadlineHours: Number(hours.value), forfeitAfterN: Number(forfeit.value), aiPlayers: Number(aiCount.value || 0) });
        navigate(`/games/${gameId}`);
      } catch (err) { flash('error', err.message); }
    },
  },
  h('div', { class: 'rowform' },
    h('label', { class: 'field', for: 'hours' }, h('span', {}, 'Hours per turn'), hours),
    h('label', { class: 'field', for: 'forfeit' }, h('span', {}, 'Forfeit after missed turns (0 = never)'), forfeit),
    h('label', { class: 'field', for: 'ai' }, h('span', {}, 'AI players (0 to 8)'), aiCount),
    h('button', { class: 'primary', type: 'submit' }, 'Create game')));

  const ref = h('input', { id: 'ref', type: 'text', placeholder: 'Game number or invite link' });
  const join = h('form', {
    onSubmit: (e) => {
      e.preventDefault();
      const id = parseGameRef(ref.value);
      if (!id) { flash('error', 'Enter a game number such as 12, or paste an invite link.'); return; }
      navigate(`/games/${id}`);
    },
  }, h('div', { class: 'rowform' }, h('label', { class: 'field', for: 'ref' }, h('span', {}, 'Join a game'), ref), h('button', { type: 'submit' }, 'Go')));

  const emailHolder = h('div', {});
  mount(outlet,
    h('h1', {}, `Welcome, ${session.user?.displayName ?? 'player'}`),
    h('section', { class: 'card' }, h('h2', {}, 'Your games'), list),
    h('div', { class: 'cols' },
      h('section', { class: 'card' }, h('h2', {}, 'Create a game'), create,
        h('p', { class: 'hint' }, `You will be the creator: you choose when to start, once ${plural(3, 'player')} to 9 have joined. AI players count as players, and you can add or remove them in the lobby.`)),
      h('section', { class: 'card' }, h('h2', {}, 'Join a game'), join)),
    emailHolder);
  await Promise.all([loadGames(), loadEmailSettings({ api, holder: emailHolder, flash })]);
  return {};
}

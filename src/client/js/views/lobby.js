import { h, mount } from '../dom.js';
import { label, plural, AI_STYLES, aiStyleLabel } from '../format.js';

export function createLobbyView({ ctx, gameId, resync }) {
  const { api, session, flash } = ctx;
  const base = `/api/v1/games/${gameId}`;
  const el = h('div');
  let data = null;
  let busy = false;

  async function act(fn) {
    if (busy) return;
    busy = true;
    render();
    try { await fn(); } catch (err) { flash('error', err.message); } finally { busy = false; }
    await resync();
  }

  function copyInvite(input, button) {
    const text = input.value;
    const done = () => { button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy'; }, 1500); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => { input.select(); });
    else { input.select(); }
  }

  function aiCard() {
    const { game, seats } = data.lobby;
    const full = seats.length >= game.limits.maxPlayers;
    const style = h('select', { id: 'ai-style', disabled: busy || full, 'aria-label': 'Play style' },
      h('option', { value: '' }, 'Random style'),
      Object.entries(AI_STYLES).map(([key, v]) => h('option', { value: key }, v.label)));
    return h('section', { class: 'card' },
      h('h2', {}, 'AI players'),
      h('p', { class: 'hint' }, 'An AI takes a seat, gets a random country if the others do not claim it, and sends in its orders by itself each turn. It sees only what a player in its seat would see. It counts towards the players you need.'),
      h('div', { class: 'rowform' },
        h('label', { class: 'field', for: 'ai-style' }, h('span', {}, 'Play style'), style),
        h('button', { type: 'button', disabled: busy || full, onClick: () => act(() => api.post(`${base}/ai`, style.value ? { persona: style.value } : {})) }, 'Add AI player')),
      full ? h('p', { class: 'hint' }, 'The game is full.') : null,
      h('dl', { class: 'styles' }, Object.values(AI_STYLES).flatMap((v) => [h('dt', {}, v.label), h('dd', {}, v.blurb)])));
  }

  function render() {
    if (!data) return;
    const { lobby, member } = data;
    const { game, seats, countries } = lobby;
    const me = seats.find((s) => s.userId === session.user?.id);
    const isCreator = game.creatorId === session.user?.id;
    const creatorName = seats.find((s) => s.userId === game.creatorId)?.displayName ?? 'the creator';
    const need = Math.max(0, game.limits.minPlayers - seats.length);
    const full = seats.length >= game.limits.maxPlayers;

    const invite = h('input', { type: 'text', readOnly: true, value: `${location.origin}/#/games/${gameId}`, 'aria-label': 'Invite link' });
    const copy = h('button', { type: 'button' }, 'Copy');
    copy.addEventListener('click', () => copyInvite(invite, copy));

    mount(el,
      h('div', { class: 'row spread' },
        h('h1', {}, `Game #${gameId}`),
        h('span', { class: 'chip lobby' }, 'Waiting for players')),
      h('p', { class: 'muted' },
        `Each turn lasts ${plural(game.settings.turnDeadlineHours, 'hour')}. `,
        game.settings.forfeitAfterN === 0 ? 'Players are never forfeited for missing turns.' : `A player who misses ${plural(game.settings.forfeitAfterN, 'turn')} in a row is forfeited.`),

      member ? null : h('section', { class: 'card' },
        h('h2', {}, 'Join this game'),
        h('p', {}, `${plural(seats.length, 'player')} so far. ${full ? 'This game is full.' : 'Join to pick a country and take part.'}`),
        h('button', { class: 'primary', disabled: busy || full, onClick: () => act(() => api.post(`${base}/join`)) }, 'Join game')),

      h('section', { class: 'card' },
        h('h2', {}, `Players (${seats.length} of ${game.limits.maxPlayers})`),
        h('div', { class: 'scroll' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Player'), h('th', {}, 'Country'), h('th', { class: 'num' }, 'Starting population (millions)'))),
          h('tbody', {}, seats.map((s) => h('tr', {},
            h('td', {}, s.displayName ?? `Player ${s.userId}`, s.userId === session.user?.id ? h('span', { class: 'chip you' }, 'you') : null, s.userId === game.creatorId ? h('span', { class: 'chip' }, 'creator') : null,
              s.ai ? h('span', { class: 'chip ai', title: AI_STYLES[s.ai]?.blurb ?? '' }, `AI · ${aiStyleLabel(s.ai)}`) : null,
              s.ai && isCreator ? h('button', { type: 'button', class: 'link danger', disabled: busy, 'aria-label': `Remove ${s.displayName}`, onClick: () => act(() => api.del(`${base}/ai/${s.userId}`)) }, 'Remove') : null),
            h('td', {}, s.country ? label(s.country) : h('span', { class: 'muted' }, 'Random at start')),
            h('td', { class: 'num' }, isCreator
              ? h('input', {
                type: 'number', min: 25, max: 99, step: 1, placeholder: 'random', value: s.startPopulation ?? '', disabled: busy,
                'aria-label': `Starting population for ${s.displayName ?? 'player'}`,
                onChange: (e) => act(() => api.put(`${base}/population`, { userId: s.userId, population: e.target.value === '' ? null : Number(e.target.value) })),
              })
              : (s.startPopulation ?? h('span', { class: 'muted' }, 'random')))))))),
        isCreator ? h('p', { class: 'hint' }, 'Leave a population blank to draw one at random (25 to 99).') : null),

      isCreator ? aiCard() : null,

      member ? h('section', { class: 'card' },
        h('h2', {}, 'Choose your country'),
        h('p', { class: 'hint' }, 'First come, first served. If you do not choose, you are assigned a random free country when the game starts.'),
        h('div', { class: 'countries' }, countries.map((c) => {
          const mine = me?.country === c.country;
          const taken = Boolean(c.takenBy) && !mine;
          return h('button', {
            type: 'button', class: `country${mine ? ' mine' : ''}`, disabled: busy || taken, 'aria-pressed': String(mine),
            onClick: () => act(() => api.put(`${base}/country`, { country: mine ? null : c.country })),
          }, h('strong', {}, label(c.country)), h('small', {}, mine ? 'Yours (click to release)' : taken ? `Taken by ${c.takenBy}` : 'Free'));
        }))) : null,

      h('section', { class: 'card' },
        h('h2', {}, 'Invite players'),
        h('p', { class: 'hint' }, 'Share this link. They will need to sign in first.'),
        h('div', { class: 'invite' }, invite, copy)),

      member ? h('section', { class: 'card' },
        isCreator
          ? [h('h2', {}, 'Start the game'),
            h('p', {}, need > 0 ? `Waiting for ${plural(need, 'more player')} (at least ${game.limits.minPlayers} are needed).` : 'Everyone here will play. Players without a country are assigned one at random.'),
            h('button', { class: 'primary', disabled: busy || need > 0, onClick: () => act(() => api.post(`${base}/start`)) }, 'Start game')]
          : [h('h2', {}, 'Waiting to start'), h('p', {}, `${creatorName} will start the game when everyone is ready.`),
            h('button', { class: 'danger', disabled: busy, onClick: () => act(async () => { await api.del(`${base}/membership`); flash('info', 'You left the game.'); }) }, 'Leave game')]) : null);
  }

  return {
    el,
    update({ lobby, member }) { data = { lobby, member }; render(); },
    onEvent() {},
    unmount() {},
  };
}

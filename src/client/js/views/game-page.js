// One page per game. It looks at the lobby to decide what to show (lobby, play screen, or "already started"),
// keeps a single live event stream open, and switches views when the game changes state.
import { h, mount } from '../dom.js';
import { openStream } from '../api.js';
import { createLobbyView } from './lobby.js';
import { createPlayView } from './play.js';

const message = (title, ...rest) => h('section', { class: 'card narrow' }, h('h1', {}, title), ...rest, h('p', {}, h('a', { href: '#/' }, 'Back to your games')));

export async function gameView(ctx) {
  const { api, tokens, session, outlet } = ctx;
  const id = Number(ctx.params.id);
  if (!Number.isSafeInteger(id) || id < 1) { mount(outlet, message('Game not found')); return {}; }

  const root = h('div');
  mount(outlet, root);
  let child = null;
  let childKind = null;
  let stream = null;
  let disposed = false;
  let creatorId = null;

  function make(kind) {
    if (kind === 'lobby') return createLobbyView({ ctx, gameId: id, resync: sync });
    if (kind === 'play') return createPlayView({ ctx, gameId: id });
    return { el: message('This game has already started', h('p', { class: 'muted' }, 'Only the players who joined it can open it.')) };
  }

  function watch(member) {
    if (member && !stream) stream = openStream(id, tokens.get(), onEvent);
    if (!member && stream) { stream.close(); stream = null; }
  }

  async function sync() {
    let lobby;
    try { lobby = await api.get(`/api/v1/games/${id}/lobby`); } catch (err) {
      if (!disposed) mount(root, message(err.status === 404 ? 'Game not found' : 'Could not open this game', h('p', { class: 'muted' }, err.message)));
      return;
    }
    if (disposed) return;
    creatorId = lobby.game.creatorId;
    const member = lobby.seats.some((s) => s.userId === session.user?.id);
    const kind = lobby.game.status === 'LOBBY' ? 'lobby' : member ? 'play' : 'closed';
    if (kind !== childKind) {
      child?.unmount?.();
      childKind = kind;
      child = make(kind);
      mount(root, child.el);
    }
    watch(member);
    await child.update?.({ lobby, member });
  }

  function onEvent(event) {
    if (disposed) return;
    if (event.type === 'game_cancelled') {
      // The creator's own lobby screen has already said so and moved on; everyone else is told and sent back to their games.
      if (session.user?.id !== creatorId) { ctx.flash('info', 'The creator cancelled this game.'); ctx.navigate('/'); }
      return;
    }
    // Anything that can change what kind of page this is goes back through the lobby check first.
    if (event.type === 'lobby_changed' || event.type === 'game_started' || (event.type === 'ready' && childKind === 'lobby')) { sync(); return; }
    child?.onEvent?.(event);
  }

  await sync();
  return {
    unmount() {
      disposed = true;
      stream?.close();
      child?.unmount?.();
    },
  };
}

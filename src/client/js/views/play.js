// The play screen: turn header, banners, the sheet editor, and the information panels.
// The editor keeps what you have typed, so only a new turn (or an explicit reset) replaces it;
// everything else (header counts, panels) refreshes around it.
import { h, mount } from '../dom.js';
import { countdown, label, turnTypeLabel, plural } from '../format.js';
import { assetsCard, playersCard, reportsCard, messagesCard, newsCard, battleCard, minorsCard } from './panels.js';
import { createNormalEditor, createBattleEditor } from './editor.js';

export function createPlayView({ ctx, gameId }) {
  const { api, flash, session } = ctx;
  const base = `/api/v1/games/${gameId}`;
  const headerEl = h('section', { class: 'card' });
  const bannerEl = h('div');
  const editorHost = h('div');
  const sideEl = h('div');
  const el = h('div', {}, headerEl, bannerEl, h('div', { class: 'cols' }, editorHost, sideEl));

  let state = null;
  let sheetView = null;
  let editor = null;
  let editorKey = null;
  let myCountry = null;
  let started = false;
  let readySeen = false;
  let disposed = false;
  let loadSeq = 0;
  let validateSeq = 0;
  let validateTimer = null;
  let lastPoll = 0;
  let countdownEl = null;
  const tick = setInterval(onTick, 1000);

  // ───────── loading ─────────

  async function load({ reset = false } = {}) {
    const seq = ++loadSeq;
    try {
      const s = await api.get(`${base}/state`);
      const canEdit = s.game.status === 'ACTIVE' && Boolean(s.assets) && s.turn?.status === 'OPEN';
      const sv = canEdit ? await api.get(`${base}/sheet`) : null;
      if (disposed || seq !== loadSeq) return;           // a newer load is already on its way
      state = s;
      sheetView = sv;
      if (canEdit) {
        if (reset || !editor || editorKey !== String(s.turn.number)) buildEditor();
      } else {
        editor = null;
        editorKey = null;
        mount(editorHost, idleCard());
      }
      renderAround();
    } catch (err) {
      if (!disposed) flash('error', err.message);
    }
  }

  async function refreshTurn() {
    try {
      const r = await api.get(`${base}/turn`);
      if (disposed || !state) return;
      state.turn = r.turn;
      renderHeader();
    } catch { /* the next full load will correct it */ }
  }

  // ───────── the editor ─────────

  function buildEditor() {
    const common = { state, sheetView, myCountry, onChange: scheduleValidate, onSaveDraft: () => save(false), onSubmit: () => save(true) };
    editor = state.turn.type === 'BATTLE' ? createBattleEditor(common) : createNormalEditor(common);
    editorKey = String(state.turn.number);
    editor.setSaved({ saved: Boolean(sheetView.sheet), isFinal: sheetView.isFinal });
    mount(editorHost, editor.el);
    runValidate();
  }

  function scheduleValidate() {
    clearTimeout(validateTimer);
    validateTimer = setTimeout(runValidate, 350);
  }

  async function runValidate() {
    if (!editor) return;
    const mine = editor;
    const seq = ++validateSeq;
    const { sheet, problems } = mine.getSheet();
    mine.setProblems(problems);
    if (problems.length) return;
    try {
      const result = await api.post(`${base}/sheet/validate`, sheet);
      if (seq === validateSeq && editor === mine && !disposed) mine.setValidation(result);
    } catch (err) {
      if (err.status === 409) load({ reset: true });      // the turn closed while editing
    }
  }

  async function save(final) {
    if (!editor) return;
    const mine = editor;
    const { sheet, problems } = mine.getSheet();
    mine.setProblems(problems);
    if (problems.length) return;
    mine.setBusy(true);
    try {
      const r = final ? await api.post(`${base}/sheet/submit`, sheet) : await api.put(`${base}/sheet`, sheet);
      if (disposed) return;
      if (r.resolved) { flash('ok', 'Everyone had submitted, so the turn was resolved.'); await load({ reset: true }); return; }
      mine.setSaved({ saved: true, isFinal: final });
      mine.setValidation({ valid: true, errors: [] });
      flash('ok', final ? 'Final sheet submitted. You can still change it until the turn resolves.' : 'Draft saved.');
      await refreshTurn();
    } catch (err) {
      if (err.status === 422) mine.setValidation({ valid: false, errors: err.errors });
      else if (err.status === 409) { flash('error', err.message); await load({ reset: true }); }
      else flash('error', err.message);
    } finally { if (!disposed) mine.setBusy(false); }
  }

  // ───────── drawing ─────────

  function idleCard() {
    const finished = state?.game.status === 'FINISHED';
    const out = state && state.game.status === 'ACTIVE' && !state.assets;
    return h('section', { class: 'card' }, h('h2', {}, finished ? 'The game is over' : out ? 'You are out of the game' : 'Nothing to do right now'),
      h('p', { class: 'muted' }, finished ? 'See what happened turn by turn in the history, or replay the full record.' : out ? 'You can keep watching how the game ends.' : 'Waiting for the next turn.'));
  }

  function renderHeader() {
    const t = state.turn;
    const c = t ? countdown(t.deadlineAt) : null;
    countdownEl = h('span', { class: `countdown${c?.urgent ? ' urgent' : ''}` }, c?.text ?? '');
    mount(headerEl, h('div', { class: 'row spread' },
      h('div', {}, h('h1', {}, `Game #${gameId}`),
        state.game.status === 'FINISHED'
          ? h('div', { class: 'row' }, h('span', { class: 'chip finished' }, 'Finished'), t ? `Ended on turn ${t.number}` : null)
          : h('div', { class: 'row' },
            t ? h('span', { class: `chip ${t.type === 'BATTLE' ? 'battle' : 'active'}` }, turnTypeLabel(t.type)) : null,
            t ? `Turn ${t.number}` : null)),
      h('div', {},
        state.game.status === 'ACTIVE' && t ? [h('div', {}, 'Deadline in ', countdownEl), h('div', { class: 'hint' }, `${t.submitted} of ${plural(t.active, 'player')} have submitted`)] : null,
        h('div', { class: 'row' }, h('a', { href: `#/games/${gameId}/history` }, 'History'), state.game.status === 'FINISHED' ? h('a', { href: `#/games/${gameId}/replay` }, 'Replay') : null))));
  }

  function renderBanner() {
    const alive = state.public.players.filter((p) => p.alive);
    let banner = null;
    if (state.game.status === 'FINISHED') {
      if (state.game.outcome === 'DRAW') banner = h('div', { class: 'banner info' }, 'Everyone left was destroyed on the same turn. Nobody wins.');
      else if (alive[0]?.country === myCountry) banner = h('div', { class: 'banner win' }, 'You won! You are the last country standing.');
      else banner = h('div', { class: 'banner out' }, `${alive[0] ? label(alive[0].country) : 'Someone'} won the game.`);
    } else if (!state.assets) {
      banner = h('div', { class: 'banner out' }, 'You have been eliminated. You can keep watching.');
    } else if (state.turn?.type === 'BATTLE') {
      banner = h('div', { class: 'banner warn' }, 'Nuclear war has begun. This is a battle turn: choose where to fire.');
    }
    mount(bannerEl, banner);
  }

  function renderSide() {
    mount(sideEl,
      assetsCard(state.assets),
      reportsCard(state.reports),
      battleCard(state.battleResult),
      messagesCard(state.messages),
      newsCard(state.news),
      playersCard(state.public.players, myCountry),
      minorsCard(state.public.minors));
  }

  function renderAround() { renderHeader(); renderBanner(); renderSide(); }

  function onTick() {
    if (!state?.turn || state.game.status !== 'ACTIVE') return;
    const c = countdown(state.turn.deadlineAt);
    if (countdownEl) { countdownEl.textContent = c.text; countdownEl.className = `countdown${c.urgent ? ' urgent' : ''}`; }
    // The server resolves overdue turns about once a minute; the live stream normally tells us, and this is the backstop.
    if (c.overdue && Date.now() - lastPoll > 15000) { lastPoll = Date.now(); load(); }
  }

  return {
    el,
    update({ lobby }) {
      myCountry = lobby.seats.find((s) => s.userId === session.user?.id)?.country ?? myCountry;
      if (!started) { started = true; load(); }
    },
    onEvent(event) {
      if (event.type === 'player_submitted') refreshTurn();
      else if (event.type === 'turn_resolved') { flash('info', `Turn ${event.turnNumber} has been resolved.`); load({ reset: true }); }
      else if (event.type === 'game_finished') load({ reset: true });
      else if (event.type === 'ready') { if (readySeen) load(); readySeen = true; }   // the first one is just the connection opening
    },
    unmount() {
      disposed = true;
      clearInterval(tick);
      clearTimeout(validateTimer);
    },
  };
}

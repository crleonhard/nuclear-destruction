// The turn sheet editors. Each keeps a "form" of the strings people type (see sheet-model.js) and shows
// live totals while the server's own validation (the same rules that will resolve the turn) runs in the background.
import { h, mount } from '../dom.js';
import { emptyForm, formToSheet, sheetToForm, fillMessages, committed, firedBySource, parseCount } from '../sheet-model.js';
import { label, describeField, prettyErrors } from '../format.js';

const num = (raw) => parseCount(raw).value ?? 0;

function numberInput(value, onInput, attrs = {}) {
  return h('input', { type: 'number', min: 0, step: 1, inputmode: 'numeric', value: value ?? '', onInput: (e) => onInput(e.target.value), ...attrs });
}
const labelled = (text, control, hint) => h('label', { class: 'field' }, h('span', {}, text), control, hint ? h('span', { class: 'hint' }, hint) : null);
const section = (title, ...body) => h('fieldset', { class: 'card' }, h('legend', {}, title), ...body);

/** "Problems" box: what is wrong with the sheet, local (not a number) and server (rules). */
function problemsBox() {
  const el = h('div', { class: 'problems', role: 'alert', hidden: true });
  let local = [];
  let server = [];
  const draw = () => {
    const items = [...local.map((p) => ({ where: describeField(p.field), message: p.message })), ...server];
    el.hidden = items.length === 0;
    mount(el, items.length
      ? [h('strong', {}, items.length === 1 ? 'One thing to fix:' : `${items.length} things to fix:`),
        h('ul', {}, items.map((i) => h('li', {}, i.where ? `${i.where}: ${i.message}` : i.message)))]
      : null);
  };
  return {
    el,
    setLocal(list) { local = list; draw(); },
    setServer(errors) { server = prettyErrors(errors); draw(); },
    hasLocal: () => local.length > 0,
  };
}

function actionBar({ onSaveDraft, onSubmit }) {
  const status = h('span', { class: 'muted small', 'aria-live': 'polite' });
  const draft = h('button', { type: 'button', onClick: onSaveDraft }, 'Save draft');
  const submit = h('button', { type: 'button', class: 'primary', onClick: onSubmit }, 'Submit final sheet');
  let busy = false;
  let blocked = false;
  const apply = () => { draft.disabled = busy; submit.disabled = busy || blocked; };
  return {
    el: h('div', { class: 'row actionbar' }, draft, submit, status),
    setBusy(b) { busy = b; apply(); },
    setBlocked(b) { blocked = b; apply(); },
    setStatus(text) { status.textContent = text; },
  };
}

const SAVED_TEXT = (saved, isFinal) => (saved
  ? (isFinal ? 'Final sheet submitted. You can change it until the turn resolves.' : 'Draft saved. It is not final yet.')
  : 'Not saved yet.');

/** Messages to other players, "same text to everyone", and a world-news line. Shared by both editors. */
function diplomacy({ form, others, onChange }) {
  const boxes = {};
  const message = (country) => (form.messages[country] ??= { text: '', anonymous: false });

  const row = (p) => {
    const counter = h('span', { class: 'hint' });
    const text = h('textarea', {
      rows: 2, maxlength: 500, 'aria-label': `Message to ${label(p.country)}`, value: form.messages[p.country]?.text ?? '',
      onInput: (e) => { message(p.country).text = e.target.value; counter.textContent = `${e.target.value.length}/500`; onChange(); },
    });
    const anon = h('input', { type: 'checkbox', checked: Boolean(form.messages[p.country]?.anonymous), onChange: (e) => { message(p.country).anonymous = e.target.checked; onChange(); } });
    counter.textContent = `${text.value.length}/500`;
    boxes[p.country] = { text, anon, counter };
    return h('div', { class: 'card' }, h('strong', {}, `To ${label(p.country)}`), text,
      h('div', { class: 'row spread' }, h('label', { class: 'checkline' }, anon, 'Send anonymously'), counter));
  };

  const allText = h('textarea', { rows: 2, maxlength: 500, 'aria-label': 'Message to send to everyone' });
  const allAnon = h('input', { type: 'checkbox' });
  const fill = h('button', {
    type: 'button',
    onClick: () => {
      fillMessages(form, others.map((p) => p.country), allText.value, allAnon.checked);
      for (const [country, b] of Object.entries(boxes)) { b.text.value = form.messages[country].text; b.anon.checked = form.messages[country].anonymous; b.counter.textContent = `${b.text.value.length}/500`; }
      onChange();
    },
  }, 'Copy into every message below');

  const newsCounter = h('span', { class: 'hint' });
  const news = h('input', { type: 'text', maxlength: 60, value: form.news.text, 'aria-label': 'World news', onInput: (e) => { form.news.text = e.target.value; newsCounter.textContent = `${e.target.value.length}/60`; onChange(); } });
  newsCounter.textContent = `${form.news.text.length}/60`;
  const newsAnon = h('input', { type: 'checkbox', checked: form.news.anonymous, onChange: (e) => { form.news.anonymous = e.target.checked; onChange(); } });

  const hasContent = Object.values(form.messages).some((m) => m.text) || form.news.text;
  return h('fieldset', { class: 'card' }, h('legend', {}, 'Diplomacy and news'),
    h('details', { open: Boolean(hasContent) }, h('summary', {}, 'Messages and world news'),
      others.length ? [
        h('p', { class: 'hint' }, 'Each message goes to one player and is delivered next turn. You may send each player one message per turn.'),
        h('div', { class: 'card' }, h('strong', {}, 'Same text to everyone'), allText, h('div', { class: 'row' }, h('label', { class: 'checkline' }, allAnon, 'Anonymous'), fill)),
        others.map(row)] : h('p', { class: 'muted' }, 'There is nobody else to message.'),
      h('h3', {}, 'World news'),
      h('p', { class: 'hint' }, 'One public line per turn that every player sees (60 characters).'),
      news, h('div', { class: 'row spread' }, h('label', { class: 'checkline' }, newsAnon, 'Anonymous'), newsCounter)));
}

// ───────────────────────── Normal turn ─────────────────────────

export function createNormalEditor({ state, sheetView, myCountry, onChange, onSaveDraft, onSubmit }) {
  const form = sheetToForm(sheetView.sheet, emptyForm());
  const limits = sheetView.limits;
  const assets = state.assets;
  const others = state.public.players.filter((p) => p.alive && p.country !== myCountry);
  const minors = state.public.minors.filter((m) => !m.destroyed);
  const F = limits.wholeFactories;
  const problems = problemsBox();
  const bar = actionBar({ onSaveDraft, onSubmit });
  const budget = h('div', { class: 'budget sticky', 'aria-live': 'polite' });

  function updateBudget() {
    const c = committed(form, { survivingMinors: minors.length });
    const pool = assets.missiles + Math.max(0, F - num(form.build.abms) - num(form.build.factories));
    const items = [
      [`Factories assigned: ${c.buildAssigned} of ${F}`, c.buildAssigned > F],
      [`ABM factories: ${num(form.build.abms)} (at most ${limits.abmFactoryCap})`, num(form.build.abms) > limits.abmFactoryCap],
      [`Cash given: $${c.cash}M of $${assets.cash}M`, c.cash > assets.cash],
      [`Missiles given: ${c.missiles} of ${pool}`, c.missiles > pool],
      [`Factories given or offered: ${c.factoriesGiven} of ${F}`, c.factoriesGiven > F],
    ];
    mount(budget, items.map(([text, over]) => h('div', { class: over ? 'over' : '' }, text)));
  }
  const changed = () => { updateBudget(); bar.setStatus('Unsaved changes.'); onChange(); };

  const buildField = (key, text, hint) => labelled(text, numberInput(form.build[key], (v) => { form.build[key] = v; changed(); }), hint);

  function spyRow(i) {
    const holder = h('div', { class: 'row' });
    const repeatHint = () => {
      const t = sheetView.spyDefaults[i];
      return t ? `Will repeat: ${label(t.id)}.` : 'No earlier target, so this spy does nothing.';
    };
    const draw = () => {
      const spy = form.spies[i];
      const options = spy.kind === 'MINOR' ? minors.map((m) => [m.id, label(m.id)]) : spy.kind === 'PLAYER' ? others.map((p) => [p.country, label(p.country)]) : [];
      mount(holder, h('strong', {}, `Spy ${i + 1}`),
        h('select', {
          'aria-label': `Spy ${i + 1} target type`, value: spy.kind,
          onChange: (e) => { spy.kind = e.target.value; spy.id = ''; draw(); changed(); },
        }, h('option', { value: '' }, 'Repeat last target'), h('option', { value: 'MINOR' }, 'Spy on a minor'), h('option', { value: 'PLAYER' }, 'Spy on a player')),
        spy.kind
          ? h('select', { 'aria-label': `Spy ${i + 1} target`, value: spy.id, onChange: (e) => { spy.id = e.target.value; changed(); } },
            h('option', { value: '' }, 'Choose…'), options.map(([v, t]) => h('option', { value: v }, t)))
          : h('span', { class: 'hint' }, repeatHint()));
    };
    draw();
    return holder;
  }

  const minorsTable = h('div', { class: 'scroll' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Minor'), h('th', { class: 'num' }, 'Pop. (M)'), h('th', {}, 'Cash ($M)'), h('th', {}, 'Missiles'))),
    h('tbody', {}, minors.map((m) => h('tr', {},
      h('td', {}, label(m.id)), h('td', { class: 'num' }, m.population),
      h('td', {}, numberInput(form.minorCash[m.id], (v) => { form.minorCash[m.id] = v; changed(); }, { 'aria-label': `Cash to ${label(m.id)}` })),
      h('td', {}, numberInput(form.minorMissiles[m.id], (v) => { form.minorMissiles[m.id] = v; changed(); }, { 'aria-label': `Missiles to ${label(m.id)}` })))))));

  const playerGift = (country) => (form.players[country] ??= { cash: '', missiles: '', factories: '' });
  const playersTable = others.length ? h('div', { class: 'scroll' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Player'), h('th', {}, 'Cash ($M)'), h('th', {}, 'Missiles'), h('th', {}, 'Factories (max 2)'))),
    h('tbody', {}, others.map((p) => h('tr', {}, h('td', {}, label(p.country)),
      ...['cash', 'missiles', 'factories'].map((k) => h('td', {}, numberInput(form.players[p.country]?.[k], (v) => { playerGift(p.country)[k] = v; changed(); },
        { 'aria-label': `${k[0].toUpperCase()}${k.slice(1)} to ${label(p.country)}`, ...(k === 'factories' ? { max: 2 } : {}) }))))))))
    : h('p', { class: 'muted' }, 'There are no other players left to give to.');

  const war = h('input', { type: 'checkbox', checked: form.declareWar, disabled: state.turn.number === 1, onChange: (e) => { form.declareWar = e.target.checked; changed(); } });
  const sale = h('input', { type: 'checkbox', checked: form.offerFactory, onChange: (e) => { form.offerFactory = e.target.checked; changed(); } });

  const el = h('div', {},
    h('h2', {}, 'Your orders for this turn'),
    h('p', { class: 'hint' }, 'If you submit nothing, all your factories build missiles and your spies repeat their last targets.'),
    budget, problems.el,
    section('Build',
      h('p', { class: 'hint' }, `You have ${F} whole ${F === 1 ? 'factory' : 'factories'}. Each builds one missile, one ABM, or a third of a new factory. Anything you leave unassigned builds missiles.`),
      h('div', { class: 'row' }, buildField('abms', 'ABM factories', `at most ${limits.abmFactoryCap}`), buildField('factories', 'New-factory builds', 'three make one factory'), buildField('missiles', 'Missile factories', 'optional'))),
    section('Spies', h('p', { class: 'hint' }, 'You have three spies. At most one may go to a player. They report at the end of the turn.'), spyRow(0), spyRow(1), spyRow(2)),
    section('Gifts to minors', h('p', { class: 'hint' }, 'Each $1M you give raises your popularity there by 1; each missile raises it by 10. The player with the most popularity controls the minor in war.'),
      labelled('Same cash to every minor ($M)', numberInput(form.cashEvery, (v) => { form.cashEvery = v; changed(); }), `costs ${minors.length} times this amount`), minorsTable),
    section('Gifts to other players', playersTable),
    section('Sell a factory',
      h('label', { class: 'checkline' }, sale, 'Offer one factory for sale to the minors'),
      h('p', { class: 'hint' }, 'All factories offered this turn sell at one price, or none sell. You still build with it this turn.')),
    diplomacy({ form, others, onChange: changed }),
    section('War',
      h('label', { class: 'checkline' }, war, 'Declare nuclear war'),
      h('p', { class: 'hint' }, state.turn.number === 1 ? 'War cannot be declared on the first turn.' : 'Starts the battle phase: the next turn is a battle turn, and war cannot be undone. You will have to fire at least one missile from home.')),
    bar.el);
  updateBudget();

  return {
    el,
    getSheet: () => formToSheet(form),
    setProblems(list) { problems.setLocal(list); bar.setBlocked(list.length > 0); if (list.length) bar.setStatus('Fix the problems listed at the top of the sheet first.'); },
    setValidation({ valid, errors }) { problems.setServer(errors ?? []); bar.setBlocked(!valid || problems.hasLocal()); if (!valid) bar.setStatus('Fix the problems listed at the top of the sheet first.'); },
    setSaved({ saved, isFinal }) { bar.setStatus(SAVED_TEXT(saved, isFinal)); },
    setBusy: (b) => bar.setBusy(b),
  };
}

// ───────────────────────── Battle turn ─────────────────────────

export function createBattleEditor({ state, sheetView, myCountry, onChange, onSaveDraft, onSubmit }) {
  const form = sheetToForm(sheetView.sheet, emptyForm());
  const limits = sheetView.limits;
  const others = state.public.players.filter((p) => p.alive && p.country !== myCountry);
  const problems = problemsBox();
  const bar = actionBar({ onSaveDraft, onSubmit });
  const changed = () => { bar.setStatus('Unsaved changes.'); onChange(); };

  const sources = [{ id: 'HOME', title: 'Your home country', stock: limits.homeStock },
    ...limits.controlled.map((c) => ({ id: c.id, title: `${label(c.id)} (you control it)`, stock: c.missiles }))];
  const targets = [
    ...state.public.players.filter((p) => p.alive).map((p) => [p.country, p.country === myCountry ? `${label(p.country)} (your own country)` : label(p.country)]),
    ...state.public.minors.filter((m) => !m.destroyed).map((m) => [m.id, `${label(m.id)} (minor)`]),
  ];
  for (const s of sources) if (!form.fire[s.id]?.length) form.fire[s.id] = [{ target: '', count: '' }];

  function sourceCard(src) {
    const rows = form.fire[src.id];
    const rowsEl = h('div');
    const used = h('span', { class: 'hint' });
    const drawUsed = () => {
      const n = firedBySource(form)[src.id] ?? 0;
      used.textContent = `${n} of ${src.stock} missiles assigned`;
      used.className = n > src.stock ? 'hint over' : 'hint';
    };
    const drawRows = () => {
      mount(rowsEl, rows.map((row, i) => h('div', { class: 'rowform' },
        h('select', { 'aria-label': `${src.title}: target ${i + 1}`, value: row.target, onChange: (e) => { row.target = e.target.value; changed(); } },
          h('option', { value: '' }, 'Choose a target…'), targets.map(([v, t]) => h('option', { value: v }, t))),
        numberInput(row.count, (v) => { row.count = v; drawUsed(); changed(); }, { 'aria-label': `${src.title}: missiles at target ${i + 1}` }),
        h('button', { type: 'button', 'aria-label': `Remove target ${i + 1}`, onClick: () => { rows.splice(i, 1); if (!rows.length) rows.push({ target: '', count: '' }); drawRows(); changed(); } }, 'Remove'))));
      drawUsed();
    };
    drawRows();
    return h('section', { class: 'card' }, h('div', { class: 'row spread' }, h('h3', {}, src.title), used), rowsEl,
      h('button', { type: 'button', onClick: () => { rows.push({ target: '', count: '' }); drawRows(); } }, 'Add another target'));
  }

  const el = h('div', {},
    h('h2', {}, 'Your orders for this battle'),
    h('p', { class: 'hint' }, 'If you submit nothing, you fire nothing. Every missile you fire is used up, whether or not it is shot down. Each ABM stops one incoming missile. The country that declared war must fire at least one missile from its own territory on the first battle turn, or one is fired at it.'),
    problems.el,
    sources.map(sourceCard),
    diplomacy({ form, others, onChange: changed }),
    bar.el);

  return {
    el,
    getSheet: () => formToSheet(form, { battle: true }),
    setProblems(list) { problems.setLocal(list); bar.setBlocked(list.length > 0); if (list.length) bar.setStatus('Fix the problems listed at the top of the sheet first.'); },
    setValidation({ valid, errors }) { problems.setServer(errors ?? []); bar.setBlocked(!valid || problems.hasLocal()); if (!valid) bar.setStatus('Fix the problems listed at the top of the sheet first.'); },
    setSaved({ saved, isFinal }) { bar.setStatus(SAVED_TEXT(saved, isFinal)); },
    setBusy: (b) => bar.setBusy(b),
  };
}

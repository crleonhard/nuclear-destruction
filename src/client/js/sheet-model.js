// The turn sheet as a form, and back. Pure functions: no DOM, no network.
//
// The form keeps everything as the strings people type; `formToSheet` turns it into the JSON the API wants,
// leaving out anything blank or zero, and reports anything that is not a whole number instead of guessing.

const WHOLE = /^\d+$/;

export function parseCount(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { empty: true };
  if (!WHOLE.test(s)) return { error: 'Use a whole number, 0 or more.' };
  return { value: Number(s) };
}

export function emptyForm() {
  return {
    build: { missiles: '', abms: '', factories: '' },
    spies: [{ kind: '', id: '' }, { kind: '', id: '' }, { kind: '', id: '' }], // kind '' = repeat last target
    cashEvery: '',
    minorCash: {},          // minor id -> text
    minorMissiles: {},      // minor id -> text
    players: {},            // country -> { cash, missiles, factories }
    offerFactory: false,
    declareWar: false,
    messages: {},           // country -> { text, anonymous }
    news: { text: '', anonymous: false },
    fire: {},               // source ("HOME" or minor id) -> [{ target, count }]
  };
}

/** Returns { sheet, problems }. `problems` lists inputs that are not whole numbers; the sheet leaves them out. */
export function formToSheet(form, { battle = false } = {}) {
  const problems = [];
  const count = (raw, field) => {
    const r = parseCount(raw);
    if (r.error) { problems.push({ field, message: r.error }); return undefined; }
    return r.empty ? undefined : r.value;
  };
  const sheet = {};

  if (!battle) {
    const build = {};
    for (const k of ['missiles', 'abms', 'factories']) {
      const v = count(form.build[k], `build.${k}`);
      if (v !== undefined) build[k] = v;
    }
    if (Object.keys(build).length) sheet.build = build;

    const spies = form.spies.map((s) => (s.kind && s.id ? { kind: s.kind, id: s.id } : null));
    if (spies.some(Boolean)) sheet.spies = spies;

    const every = count(form.cashEvery, 'giveCashToEveryMinor');
    if (every) sheet.giveCashToEveryMinor = every;

    const cash = {};
    for (const [id, raw] of Object.entries(form.minorCash)) { const v = count(raw, `giveCashToMinors.${id}`); if (v) cash[id] = v; }
    if (Object.keys(cash).length) sheet.giveCashToMinors = cash;
    const missiles = {};
    for (const [id, raw] of Object.entries(form.minorMissiles)) { const v = count(raw, `giveMissilesToMinors.${id}`); if (v) missiles[id] = v; }
    if (Object.keys(missiles).length) sheet.giveMissilesToMinors = missiles;

    const gifts = {};
    for (const [country, g] of Object.entries(form.players)) {
      const one = {};
      for (const k of ['cash', 'missiles', 'factories']) { const v = count(g[k], `giveToPlayers.${country}.${k}`); if (v) one[k] = v; }
      if (Object.keys(one).length) gifts[country] = one;
    }
    if (Object.keys(gifts).length) sheet.giveToPlayers = gifts;

    if (form.offerFactory) sheet.offerFactory = true;
    if (form.declareWar) sheet.declareWar = true;
  } else {
    const fire = {};
    for (const [source, rows] of Object.entries(form.fire)) {
      const perTarget = {};
      rows.forEach((row, i) => {
        const v = count(row.count, `fire.${source}`);
        if (v && row.target) perTarget[row.target] = (perTarget[row.target] ?? 0) + v;
        else if (v && !row.target) problems.push({ field: `fire.${source}`, message: `Row ${i + 1}: choose a target.` });
      });
      if (Object.keys(perTarget).length) fire[source] = perTarget;
    }
    if (Object.keys(fire).length) sheet.fire = fire;
  }

  const messages = {};
  for (const [country, m] of Object.entries(form.messages)) {
    const text = (m.text ?? '').trim();
    if (text) messages[country] = { text, anonymous: !!m.anonymous };
  }
  if (Object.keys(messages).length) sheet.messages = messages;
  const news = (form.news.text ?? '').trim();
  if (news) sheet.worldNews = { text: news, anonymous: !!form.news.anonymous };

  return { sheet, problems };
}

/** The inverse: a saved sheet back into form fields (all as strings). */
export function sheetToForm(sheet, form = emptyForm()) {
  if (!sheet) return form;
  const s = (n) => (n === undefined || n === null ? '' : String(n));
  for (const k of ['missiles', 'abms', 'factories']) form.build[k] = s(sheet.build?.[k]);
  (sheet.spies ?? []).forEach((t, i) => { if (t && i < 3) form.spies[i] = { kind: t.kind, id: t.id }; });
  form.cashEvery = s(sheet.giveCashToEveryMinor);
  for (const [id, v] of Object.entries(sheet.giveCashToMinors ?? {})) form.minorCash[id] = s(v);
  for (const [id, v] of Object.entries(sheet.giveMissilesToMinors ?? {})) form.minorMissiles[id] = s(v);
  for (const [c, g] of Object.entries(sheet.giveToPlayers ?? {})) form.players[c] = { cash: s(g.cash), missiles: s(g.missiles), factories: s(g.factories) };
  form.offerFactory = !!sheet.offerFactory;
  form.declareWar = !!sheet.declareWar;
  for (const [c, m] of Object.entries(sheet.messages ?? {})) form.messages[c] = { text: m.text, anonymous: !!m.anonymous };
  if (sheet.worldNews) form.news = { text: sheet.worldNews.text, anonymous: !!sheet.worldNews.anonymous };
  for (const [src, targets] of Object.entries(sheet.fire ?? {})) {
    form.fire[src] = Object.entries(targets).map(([target, n]) => ({ target, count: s(n) }));
  }
  return form;
}

/** "Send the same text to everyone": one message per country, each still its own message. */
export function fillMessages(form, countries, text, anonymous = false) {
  for (const c of countries) form.messages[c] = { text, anonymous };
  return form;
}

/** What the form commits right now, for instant feedback while the server's check is on its way. Ignores bad input. */
export function committed(form, { survivingMinors = 0 } = {}) {
  const n = (raw) => { const r = parseCount(raw); return r.value ?? 0; };
  const sum = (obj) => Object.values(obj).reduce((t, v) => t + n(v), 0);
  const players = Object.values(form.players);
  return {
    cash: n(form.cashEvery) * survivingMinors + sum(form.minorCash) + players.reduce((t, g) => t + n(g.cash), 0),
    missiles: sum(form.minorMissiles) + players.reduce((t, g) => t + n(g.missiles), 0),
    factoriesGiven: players.reduce((t, g) => t + n(g.factories), 0) + (form.offerFactory ? 1 : 0),
    buildAssigned: n(form.build.missiles) + n(form.build.abms) + n(form.build.factories),
  };
}

/** Missiles fired per source in a battle form, for stock checks. */
export function firedBySource(form) {
  const out = {};
  for (const [source, rows] of Object.entries(form.fire)) out[source] = rows.reduce((t, r) => t + (parseCount(r.count).value ?? 0), 0);
  return out;
}

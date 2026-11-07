// OpenAPI 3.1 description of the HTTP API. This module is the source of truth:
//   - app.js serves it at GET /openapi.json
//   - scripts/build-openapi.js exports openapi.json and openapi.yaml
//   - openapi.test.js checks it against the real routes, the real error codes, and real responses
// Keep it in step with app.js; the contract tests fail loudly if they drift apart.

import { COUNTRIES } from '../game/index.js';

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const resp = (name) => ({ $ref: `#/components/responses/${name}` });
const nullable = (schema) => ({ oneOf: [schema, { type: 'null' }] });
const int = (extra = {}) => ({ type: 'integer', ...extra });
const nat = (description) => ({ type: 'integer', minimum: 0, ...(description ? { description } : {}) });
const str = (extra = {}) => ({ type: 'string', ...extra });
const arr = (items, extra = {}) => ({ type: 'array', items, ...extra });
const obj = (properties, required = Object.keys(properties), extra = {}) => ({ type: 'object', properties, required, ...extra });
const jsonBody = (schema, example) => ({ 'application/json': { schema, ...(example ? { example } : {}) } });
const ok = (description, schema, status = '200') => ({ [status]: { description, content: jsonBody(schema) } });

const ERROR_RESPONSES = {
  400: 'BadRequest', 401: 'Unauthenticated', 403: 'Forbidden', 404: 'NotFound', 409: 'Conflict',
  413: 'PayloadTooLarge', 415: 'UnsupportedMediaType', 422: 'Unprocessable', 429: 'RateLimited', 500: 'InternalError', 503: 'Unavailable',
};
const errs = (...codes) => Object.fromEntries(codes.map((c) => [String(c), resp(ERROR_RESPONSES[c])]));

const gameIdParam = { $ref: '#/components/parameters/GameId' };
const sheetBody = { required: true, content: jsonBody(ref('Sheet')) };

/** Common error sets. Reads: auth + server errors. Writes add body parsing and rate limiting. */
const READ = [401, 500];
const WRITE = [400, 401, 413, 415, 429, 500];

const operation = ({ id, tag, summary, description, security, parameters, requestBody, responses }) => ({
  operationId: id,
  tags: [tag],
  summary,
  ...(description ? { description } : {}),
  ...(security ? { security } : {}),
  ...(parameters ? { parameters } : {}),
  ...(requestBody ? { requestBody } : {}),
  responses,
});

export const ERROR_CODES = [
  // sheet validation
  'BUILD_OVER_CAPACITY', 'ABM_CAP_EXCEEDED', 'CASH_OVER_START', 'MISSILE_POOL_EXCEEDED', 'FACTORY_GIFT_LIMIT',
  'SPY_PLAYER_LIMIT', 'TARGET_INVALID', 'MESSAGE_INVALID', 'WAR_NOT_ALLOWED', 'FIRE_OVER_STOCK',
  'NOT_YOUR_TURN_TYPE', 'NOT_INTEGER',
  // turn and game state
  'TURN_CLOSED', 'ALREADY_STARTED', 'ALREADY_JOINED', 'GAME_FULL', 'COUNTRY_TAKEN', 'CREATOR_CANNOT_LEAVE',
  'PLAYER_COUNT', 'GAME_NOT_FINISHED',
  // access and protocol
  'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'BAD_JSON', 'UNSUPPORTED_MEDIA_TYPE',
  'PAYLOAD_TOO_LARGE', 'RATE_LIMITED', 'INTERNAL',
  // email sign-in
  'EMAIL_INVALID', 'LINK_INVALID', 'NAME_REQUIRED', 'MAIL_UNAVAILABLE',
];

const schemas = {
  // ── Shared vocabulary ──
  Country: { type: 'string', enum: COUNTRIES, description: 'A player country. Also the identifier players use for each other in sheets and messages.' },
  MinorId: { type: 'string', pattern: '^[A-Z]+#[0-9]+$', examples: ['CUBA#1', 'CUBA#2'], description: 'A minor country: BASE#generation. Generation 1 is the original; replacements are #2, #3 and so on (shown as "CUBA (II)").' },
  ErrorCode: { type: 'string', enum: ERROR_CODES },
  ValidationError: obj({
    code: ref('ErrorCode'),
    field: str({ description: 'The offending field path, or "request" for request-level problems.', examples: ['build.abms', 'spies', 'fire.HOME'] }),
    message: str(),
  }),
  ErrorResponse: obj({ errors: arr(ref('ValidationError'), { minItems: 1 }) }),
  Empty: { type: 'object', maxProperties: 0, description: 'An empty JSON object.' },

  // ── Users ──
  User: obj({ id: int({ minimum: 1 }), displayName: nullable(str()) }),

  // ── Sheets ──
  SpyTarget: obj({ kind: str({ enum: ['PLAYER', 'MINOR'] }), id: { oneOf: [ref('Country'), ref('MinorId')] } }),
  Sheet: {
    type: 'object',
    description: 'A turn sheet. On a NORMAL turn use every field except `fire`. On a BATTLE turn only `fire`, `messages` and `worldNews` are allowed (anything else gives NOT_YOUR_TURN_TYPE). Unknown properties are ignored. All amounts are whole numbers; cash is in $ millions.',
    properties: {
      build: obj({
        missiles: nat('Factories building missiles. Unassigned factories also build missiles.'),
        abms: nat('Factories building ABMs. At most ceil(whole factories / 2).'),
        factories: nat('Factories building new factories; each adds one third of a factory.'),
      }, []),
      spies: arr(nullable(ref('SpyTarget')), { maxItems: 3, description: 'Up to 3 slots. A null or missing slot repeats its last target. At most one effective target may be a player.' }),
      giveCashToMinors: { type: 'object', additionalProperties: nat(), description: 'MinorId -> $M. Each $1M raises your index by 1.' },
      giveCashToEveryMinor: nat('Same amount to every surviving minor (cost = amount x survivors).'),
      giveMissilesToMinors: { type: 'object', additionalProperties: nat(), description: 'MinorId -> missiles. Each missile raises your index by 10. May include missiles built this turn.' },
      giveToPlayers: {
        type: 'object',
        description: 'Country -> gift. At most 2 factories to one player.',
        additionalProperties: obj({ cash: nat(), missiles: nat(), factories: nat() }, []),
      },
      offerFactory: { type: 'boolean', description: 'Offer one factory for sale to the minors. All offers sell at one price, or none sell.' },
      messages: {
        type: 'object',
        description: 'Country -> message. At most one message per other living player. Delivered next turn.',
        additionalProperties: obj({ text: str({ maxLength: 500 }), anonymous: { type: 'boolean' } }, ['text']),
      },
      declareWar: { type: 'boolean', description: 'Not allowed on turn 1 or once war has begun.' },
      fire: {
        type: 'object',
        description: 'BATTLE turns only. Source -> target -> missiles. A source is "HOME" or a minor you control (see `controlled`).',
        additionalProperties: { type: 'object', additionalProperties: nat() },
      },
      worldNews: obj({ text: str({ maxLength: 60 }), anonymous: { type: 'boolean' } }, ['text']),
    },
    examples: [{
      build: { missiles: 4, abms: 3, factories: 2 },
      spies: [{ kind: 'MINOR', id: 'CUBA#1' }, null, null],
      giveCashToMinors: { 'CUBA#1': 6 },
      messages: { INDIA: { text: 'Let us talk.', anonymous: false } },
      offerFactory: false,
    }],
  },
  NormalLimits: obj({
    type: { const: 'NORMAL' },
    wholeFactories: nat(),
    abmFactoryCap: nat(),
    builtMissiles: nat('Missiles built this turn given the build spaces.'),
    missilePool: nat('Missiles you may give away this turn: stockpile plus built.'),
    cashAvailable: nat('Cash you may give away: start-of-turn cash only.'),
    survivingMinors: nat(),
    maxFactoriesPerPlayer: nat(),
  }),
  BattleLimits: obj({
    type: { const: 'BATTLE' },
    homeStock: nat('Missiles your home country can fire (includes the war bonus).'),
    controlled: arr(ref('ControlledMinor')),
  }),
  ControlledMinor: obj({ id: ref('MinorId'), name: str(), missiles: nat() }),
  SheetView: obj({
    turn: obj({ number: int({ minimum: 1 }), type: str({ enum: ['NORMAL', 'BATTLE'] }), deadlineAt: str({ format: 'date-time' }), status: str({ enum: ['OPEN', 'RESOLVING', 'CLOSED'] }) }),
    sheet: nullable(ref('Sheet')),
    isFinal: { type: 'boolean' },
    spyDefaults: arr(nullable(ref('SpyTarget')), { minItems: 3, maxItems: 3, description: 'What a blank spy slot will repeat.' }),
    limits: { oneOf: [ref('NormalLimits'), ref('BattleLimits')] },
  }),
  DryRun: obj({
    valid: { type: 'boolean' },
    errors: arr(ref('ValidationError')),
    derived: { oneOf: [ref('NormalLimits'), ref('BattleLimits')] },
  }),
  SubmitResult: obj({
    turnNumber: int({ minimum: 1 }),
    final: { type: 'boolean' },
    submitted: nat('Players whose sheet is final (a count; names are never shown).'),
    active: nat('Living players.'),
    resolved: { type: 'boolean', description: 'True when this submission completed the turn and it resolved immediately.' },
  }),

  // ── Reports and results ──
  SpyPlayerPayload: {
    oneOf: [
      obj({ country: ref('Country'), missiles: nat(), abms: nat() }),
      obj({ country: ref('Country'), eliminated: { const: true } }),
    ],
  },
  SpyMinorPayload: {
    oneOf: [
      obj({ minor: ref('MinorId'), indices: { type: 'object', additionalProperties: nat(), description: 'Country -> popularity index, as of the end of the turn.' } }),
      obj({ minor: ref('MinorId'), destroyed: { const: true } }),
    ],
  },
  FirstSecondPayload: obj({ minors: arr(ref('MinorId'), { description: 'Minors where you rank first or second with an index above 0 (competition ranking).' }) }),
  Report: {
    oneOf: [
      obj({ kind: { const: 'SPY_PLAYER' }, payload: ref('SpyPlayerPayload') }),
      obj({ kind: { const: 'SPY_MINOR' }, payload: ref('SpyMinorPayload') }),
      obj({ kind: { const: 'FIRST_SECOND' }, payload: ref('FirstSecondPayload') }),
    ],
  },
  Message: obj({ from: nullable(ref('Country')), text: str({ maxLength: 500 }) }),
  NewsItem: obj({ from: nullable(ref('Country')), text: str({ maxLength: 60 }) }),
  BattleResult: obj({
    fired: arr(obj({ from: str({ description: 'A country, or a minor id.' }), to: str(), n: nat() })),
    damaged: arr(obj({ target: str(), incoming: nat(), intercepted: nat(), through: nat(), population: nat() })),
    controllers: { type: 'object', additionalProperties: nullable(ref('Country')), description: 'Minor -> the player who controlled it this turn, or null.' },
  }),

  // ── The turn package ──
  Assets: obj({
    country: ref('Country'), population: nat(), cash: nat(), thirds: nat(),
    factories: nat('Whole factories (thirds / 3, rounded down).'),
    missiles: nat('Includes the +5 war bonus on the first battle turn.'),
    abms: nat(),
  }),
  PublicPlayer: obj({ country: nullable(ref('Country')), population: nat(), alive: { type: 'boolean' }, forfeited: { type: 'boolean' } }),
  PublicMinor: obj({ id: ref('MinorId'), name: str({ examples: ['CUBA', 'CUBA (II)'] }), population: nat(), destroyed: { type: 'boolean' } }),
  TurnInfo: obj({
    number: int({ minimum: 1 }),
    type: str({ enum: ['NORMAL', 'BATTLE'] }),
    status: str({ enum: ['OPEN', 'RESOLVING', 'CLOSED'] }),
    deadlineAt: str({ format: 'date-time' }),
    submitted: nat('Players with a final sheet. A count only.'),
    active: nat(),
  }),
  GameStatus: obj({ status: str({ enum: ['LOBBY', 'ACTIVE', 'FINISHED'] }), outcome: nullable(str({ enum: ['WIN', 'DRAW'] })) }, ['status']),
  TurnPackage: obj({
    game: ref('GameStatus'),
    turn: ref('TurnInfo'),
    assets: nullable(ref('Assets')),
    controlled: arr(ref('ControlledMinor'), { description: 'Battle turns: minors you control and their missiles.' }),
    reports: arr(ref('Report'), { description: 'Spy results and your first/second list, produced by the previous turn.' }),
    messages: arr(ref('Message')),
    news: arr(ref('NewsItem')),
    battleResult: nullable(ref('BattleResult')),
    mySheet: nullable(ref('Sheet')),
    public: obj({ players: arr(ref('PublicPlayer')), minors: arr(ref('PublicMinor')) }),
  }, ['game', 'public'], { description: 'Everything the caller may see at the start of the current turn. Other players\' cash, stockpiles, factories and indices are never included. Before the game starts only `game` and `public` are present.' }),
  TurnSummary: obj({ game: ref('GameStatus'), turn: nullable(ref('TurnInfo')) }, ['game']),

  // ── Lobby ──
  Seat: obj({ userId: int({ minimum: 1 }), displayName: nullable(str()), country: nullable(ref('Country')), startPopulation: nullable(int({ minimum: 25, maximum: 99 })) }),
  Lobby: obj({
    game: obj({
      id: int({ minimum: 1 }),
      status: str({ enum: ['LOBBY', 'ACTIVE', 'FINISHED'] }),
      creatorId: int({ minimum: 1 }),
      turnNumber: nullable(int({ minimum: 1 })),
      settings: obj({ turnDeadlineHours: int({ minimum: 1, maximum: 168 }), forfeitAfterN: int({ minimum: 0, maximum: 30, description: '0 = never forfeit.' }) }),
      limits: obj({ minPlayers: int(), maxPlayers: int() }),
    }),
    seats: arr(ref('Seat')),
    countries: arr(obj({ country: ref('Country'), takenBy: nullable(str()) })),
  }, ['game', 'seats', 'countries'], { description: 'The game seed is never part of the lobby.' }),
  GameSummary: obj({ id: int({ minimum: 1 }), status: str({ enum: ['LOBBY', 'ACTIVE', 'FINISHED'] }), turnNumber: nullable(int()), creatorId: int(), outcome: nullable(str({ enum: ['WIN', 'DRAW'] })) }),
  GameSettings: obj({
    turnDeadlineHours: int({ minimum: 1, maximum: 168, default: 24 }),
    forfeitAfterN: int({ minimum: 0, maximum: 30, default: 5, description: 'Consecutive missed turns before a player is forfeited. 0 = never.' }),
  }, []),

  // ── Results ──
  History: obj({
    turns: arr(obj({ number: int({ minimum: 1 }), type: str({ enum: ['NORMAL', 'BATTLE'] }), battleResult: nullable(ref('BattleResult')), news: arr(ref('NewsItem')) })),
  }),
  Replay: obj({
    seed: nat('The game seed. Released only now that the game has ended.'),
    outcome: nullable(str({ enum: ['WIN', 'DRAW'] })),
    winner: nullable(ref('Country')),
    turns: arr(obj({ number: int(), type: str({ enum: ['NORMAL', 'BATTLE'] }), rngSeed: nat() })),
    events: arr(obj({ seq: nat(), type: str(), payload: { type: 'object' }, turnId: { type: ['integer', 'null'] } }, ['seq', 'type', 'payload'])),
    sheets: arr(obj({ turn: int(), player: ref('Country'), source: str({ enum: ['PLAYER', 'SERVER_DEFAULT'] }), payload: { type: 'object' } })),
  }),
};

const responses = {
  BadRequest: { description: 'The body is not valid JSON, or is not a JSON object.', content: jsonBody(ref('ErrorResponse')) },
  Unauthenticated: { description: 'Missing, malformed, forged or expired token.', content: jsonBody(ref('ErrorResponse')) },
  Forbidden: { description: 'You are not a member of this game, or lack the right to do this (for example, only the creator can start it).', content: jsonBody(ref('ErrorResponse')) },
  NotFound: { description: 'No such game, user or route.', content: jsonBody(ref('ErrorResponse')) },
  Conflict: { description: 'The request is valid but the game is in the wrong state (turn closed, game started, game full, country taken, and so on).', content: jsonBody(ref('ErrorResponse')) },
  PayloadTooLarge: { description: 'Request bodies are limited to 256 KB.', content: jsonBody(ref('ErrorResponse')) },
  UnsupportedMediaType: { description: 'Send `Content-Type: application/json`.', content: jsonBody(ref('ErrorResponse')) },
  Unprocessable: { description: 'The request was understood but its contents break a rule. `errors` lists every problem found.', content: jsonBody(ref('ErrorResponse')) },
  RateLimited: { description: 'Too many writes. Limit is per user (default 60 per minute).', content: jsonBody(ref('ErrorResponse')) },
  Unavailable: { description: 'A service this request depends on (such as outgoing email) is temporarily unavailable. Try again later.', content: jsonBody(ref('ErrorResponse')) },
  InternalError: { description: 'Unexpected failure. The body never contains internal details.', content: jsonBody(ref('ErrorResponse')) },
};

const paths = {
  '/healthz': {
    get: operation({
      id: 'getHealth', tag: 'Meta', summary: 'Liveness check', security: [],
      responses: ok('The server is up.', obj({ status: { const: 'up' } })),
    }),
  },
  '/openapi.json': {
    get: operation({
      id: 'getOpenApi', tag: 'Meta', summary: 'This specification', security: [],
      responses: { 200: { description: 'The OpenAPI document.', content: { 'application/json': { schema: { type: 'object' } } } } },
    }),
  },
  '/api/v1/users': {
    post: operation({
      id: 'createUser', tag: 'Account', security: [],
      summary: 'Create an account (development sign-up)',
      description: 'Only available when the server runs with sign-up enabled; otherwise 404. Replace with your real sign-up flow in production.',
      requestBody: { required: true, content: jsonBody(obj({ displayName: str({ minLength: 1, maxLength: 60 }) })) },
      responses: { ...ok('Account created.', obj({ user: ref('User'), token: str({ description: 'Bearer token, valid for 30 days.' }) }), '201'), ...errs(400, 404, 413, 415, 422, 500) },
    }),
  },
  '/api/v1/auth/config': {
    get: operation({
      id: 'getAuthConfig', tag: 'Account', security: [], summary: 'Which sign-in methods this server offers',
      description: 'Lets a client show the right sign-in screen.',
      responses: { ...ok('Enabled methods.', obj({
        emailLogin: { type: 'boolean', description: 'Sign in with an emailed link.' },
        openSignup: { type: 'boolean', description: 'Development sign-up by display name (`POST /api/v1/users`).' },
      })), ...errs(500) },
    }),
  },
  '/api/v1/auth/email-link': {
    post: operation({
      id: 'requestEmailLink', tag: 'Account', security: [], summary: 'Email a one-time sign-in link',
      description: [
        'Always answers 202 for a well-formed address, whether or not it has an account and even when nothing was sent',
        '(for example because that address asked for too many links in the last hour), so the endpoint cannot be used to discover who plays.',
        'The email contains a link to the site that works once and expires (15 minutes by default). Limited per client address.',
        'Returns 404 when the server has no email sign-in configured; see `GET /api/v1/auth/config`.',
      ].join(' '),
      requestBody: { required: true, content: jsonBody(obj({ email: str({ format: 'email', maxLength: 254 }) })) },
      responses: { ...ok('Accepted.', obj({ accepted: { const: true } }), '202'), ...errs(400, 404, 413, 415, 422, 429, 500, 503) },
    }),
  },
  '/api/v1/auth/verify': {
    post: operation({
      id: 'verifyEmailLink', tag: 'Account', security: [], summary: 'Exchange a sign-in link for a login token',
      description: [
        'Send the secret from the link (the part after `#/verify/`). It is accepted once. A first-time address also needs `displayName`;',
        'without it the answer is 422 `NAME_REQUIRED` and the link stays valid so the call can be repeated with a name.',
        'Existing accounts keep their name and ignore `displayName`. Limited per client address.',
      ].join(' '),
      requestBody: { required: true, content: jsonBody(obj({ token: str({ minLength: 43, maxLength: 43 }), displayName: str({ minLength: 1, maxLength: 60 }) }, ['token'])) },
      responses: { ...ok('Signed in.', obj({ user: ref('User'), token: str({ description: 'Bearer token, valid for 30 days.' }) })), ...errs(400, 404, 413, 415, 422, 429, 500) },
    }),
  },
  '/api/v1/me': {
    get: operation({ id: 'getMe', tag: 'Account', summary: 'The signed-in user', responses: { ...ok('The caller.', obj({ user: ref('User') })), ...errs(...READ) } }),
  },
  '/api/v1/games': {
    get: operation({ id: 'listGames', tag: 'Lobby', summary: 'Games the caller has joined', responses: { ...ok('Newest first.', obj({ games: arr(ref('GameSummary')) })), ...errs(...READ) } }),
    post: operation({
      id: 'createGame', tag: 'Lobby', summary: 'Create a game',
      description: 'The creator joins automatically. The game seed is generated by the server and kept secret until the game ends.',
      requestBody: { required: false, content: jsonBody(ref('GameSettings')) },
      responses: { ...ok('Game created.', obj({ gameId: int({ minimum: 1 }) }), '201'), ...errs(...WRITE.filter((c) => c !== 500), 422, 500) },
    }),
  },
  '/api/v1/games/{id}/lobby': {
    get: operation({
      id: 'getLobby', tag: 'Lobby', summary: 'Seats, countries and settings', parameters: [gameIdParam],
      description: 'Any signed-in user may look, so invite links work before joining.',
      responses: { ...ok('The lobby.', ref('Lobby')), ...errs(...READ, 404) },
    }),
  },
  '/api/v1/games/{id}/join': {
    post: operation({
      id: 'joinGame', tag: 'Lobby', summary: 'Join a game in its lobby', parameters: [gameIdParam],
      responses: { ...ok('Joined.', ref('Empty')), ...errs(...WRITE, 404, 409) },
    }),
  },
  '/api/v1/games/{id}/country': {
    put: operation({
      id: 'pickCountry', tag: 'Lobby', summary: 'Pick or release a country', parameters: [gameIdParam],
      description: 'First come, first served. Send `{"country": null}` to release your pick. Anyone without a country when the game starts is assigned one at random.',
      requestBody: { required: true, content: jsonBody(obj({ country: nullable(ref('Country')) })) },
      responses: { ...ok('Picked.', obj({ country: nullable(ref('Country')) })), ...errs(...WRITE, 403, 404, 409, 422) },
    }),
  },
  '/api/v1/games/{id}/membership': {
    delete: operation({
      id: 'leaveGame', tag: 'Lobby', summary: 'Leave a game in its lobby', parameters: [gameIdParam],
      description: 'The creator cannot leave. Not possible once the game has started.',
      responses: { ...ok('Left.', ref('Empty')), ...errs(...WRITE, 403, 404, 409) },
    }),
  },
  '/api/v1/games/{id}/population': {
    put: operation({
      id: 'setPopulation', tag: 'Lobby', summary: 'Creator: set a player\'s starting population', parameters: [gameIdParam],
      requestBody: { required: true, content: jsonBody(obj({ userId: int({ minimum: 1 }), population: nullable(int({ minimum: 25, maximum: 99 })) }, ['userId'])) },
      responses: { ...ok('Set.', ref('Empty')), ...errs(...WRITE, 403, 404, 409, 422) },
    }),
  },
  '/api/v1/games/{id}/start': {
    post: operation({
      id: 'startGame', tag: 'Lobby', summary: 'Creator: start the game', parameters: [gameIdParam],
      description: 'Needs 3 to 9 players. Assigns leftover countries and populations, creates the 18 minors, and opens turn 1.',
      responses: { ...ok('Started.', obj({ turnNumber: { const: 1 } })), ...errs(...WRITE, 403, 404, 409, 422) },
    }),
  },
  '/api/v1/games/{id}/state': {
    get: operation({ id: 'getState', tag: 'Play', summary: 'The caller\'s turn package', parameters: [gameIdParam], responses: { ...ok('Start-of-turn view.', ref('TurnPackage')), ...errs(...READ, 403, 404) } }),
  },
  '/api/v1/games/{id}/turn': {
    get: operation({ id: 'getTurn', tag: 'Play', summary: 'Turn number, type, deadline and submitted count', parameters: [gameIdParam], responses: { ...ok('Turn summary.', ref('TurnSummary')), ...errs(...READ, 403, 404) } }),
  },
  '/api/v1/games/{id}/sheet': {
    get: operation({
      id: 'getSheet', tag: 'Play', summary: 'Your saved sheet, spy defaults and live limits', parameters: [gameIdParam],
      responses: { ...ok('Sheet view.', ref('SheetView')), ...errs(...READ, 403, 404, 409) },
    }),
    put: operation({
      id: 'saveDraft', tag: 'Play', summary: 'Save a draft sheet', parameters: [gameIdParam], requestBody: sheetBody,
      description: 'The sheet is validated first and only saved when valid. A saved draft counts as submitted if the deadline passes, but does not trigger early resolution.',
      responses: { ...ok('Saved.', ref('SubmitResult')), ...errs(...WRITE, 403, 404, 409, 422) },
    }),
  },
  '/api/v1/games/{id}/sheet/validate': {
    post: operation({
      id: 'validateSheet', tag: 'Play', summary: 'Validate a sheet without saving', parameters: [gameIdParam], requestBody: sheetBody,
      description: 'Always 200 for a well-formed request: read `valid` and `errors`. `derived` returns live numbers for the form (whole factories, ABM cap, missile pool, cash available).',
      responses: { ...ok('Validation result.', ref('DryRun')), ...errs(...WRITE, 403, 404, 409) },
    }),
  },
  '/api/v1/games/{id}/sheet/submit': {
    post: operation({
      id: 'submitSheet', tag: 'Play', summary: 'Submit a final sheet', parameters: [gameIdParam], requestBody: sheetBody,
      description: 'Saves and marks the sheet final. When every living player is final the turn resolves immediately (`resolved: true`).',
      responses: { ...ok('Submitted.', ref('SubmitResult')), ...errs(...WRITE, 403, 404, 409, 422) },
    }),
  },
  '/api/v1/games/{id}/history': {
    get: operation({ id: 'getHistory', tag: 'Results', summary: 'Public battle results and world news so far', parameters: [gameIdParam], responses: { ...ok('Past turns.', ref('History')), ...errs(...READ, 403, 404) } }),
  },
  '/api/v1/games/{id}/replay': {
    get: operation({
      id: 'getReplay', tag: 'Results', summary: 'Full replay: sheets, events and seed', parameters: [gameIdParam],
      description: 'Only after the game has finished (`GAME_NOT_FINISHED` before that), and only for its players.',
      responses: { ...ok('The replay.', ref('Replay')), ...errs(...READ, 403, 404) },
    }),
  },
  '/api/v1/games/{id}/stream': {
    get: operation({
      id: 'streamEvents', tag: 'Realtime', summary: 'Server-sent events for a game', parameters: [gameIdParam],
      security: [{ bearerAuth: [] }, { tokenQuery: [] }],
      description: [
        'A long-lived `text/event-stream`. Browsers cannot set headers on `EventSource`, so pass `?token=` instead of the Authorization header.',
        '',
        'Each message is `event: <type>` and `data: <json>`. Events carry no private data (only counts and turn numbers), so clients should refetch `/state` when one arrives.',
        '',
        '| event | data |',
        '|---|---|',
        '| `ready` | `{type}` sent once on connect |',
        '| `lobby_changed` | `{type}` |',
        '| `game_started` | `{type}` |',
        '| `player_submitted` | `{type, finalCount, activeCount}` |',
        '| `turn_resolved` | `{type, turnNumber}` |',
        '| `game_finished` | `{type, outcome}` (`WIN` or `DRAW`) |',
        '',
        'A `: keep-alive` comment is sent every 25 seconds.',
      ].join('\n'),
      responses: {
        200: { description: 'The event stream.', content: { 'text/event-stream': { schema: { type: 'string' }, example: 'event: ready\ndata: {"type":"ready"}\n\n' } } },
        ...errs(...READ, 403, 404),
      },
    }),
  },
};

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Nuclear Destruction API',
    version: '1.0.0',
    description: [
      'An asynchronous multiplayer turn-based strategy game for 3 to 9 players. Players submit a sheet each turn; the server resolves all sheets together.',
      '',
      '**Conventions**',
      '- Authenticate with `Authorization: Bearer <token>`. Tokens are signed and expire.',
      '- Every error body is `{"errors": [{"code", "field", "message"}]}`. Validation failures list every problem at once.',
      '- Game ids are integers. Players are identified by country name (`FRANCE`), minors by `CUBA#1`.',
      '- Writes are rate limited per user. Request bodies are limited to 256 KB.',
      '- Unknown routes return 404 and unsupported methods 405 (`METHOD_NOT_ALLOWED`), in the standard error shape.',
      '- Hidden information stays hidden: other players\' cash, stockpiles, factories and minor indices are never returned, anonymous senders are never named, and the game seed is released only by the replay once the game is over.',
    ].join('\n'),
  },
  servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
  tags: [
    { name: 'Meta' }, { name: 'Account' }, { name: 'Lobby', description: 'Before the game starts.' },
    { name: 'Play', description: 'Turn sheets and the per-turn view.' }, { name: 'Results' }, { name: 'Realtime' },
  ],
  security: [{ bearerAuth: [] }],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'Signed token from sign-in (`POST /api/v1/auth/verify`).' },
      tokenQuery: { type: 'apiKey', in: 'query', name: 'token', description: 'Same token, for EventSource, which cannot set headers.' },
    },
    parameters: {
      GameId: { name: 'id', in: 'path', required: true, description: 'Game id.', schema: int({ minimum: 1 }) },
    },
    schemas,
    responses,
  },
};

export default openapi;

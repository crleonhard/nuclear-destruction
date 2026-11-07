-- migrate:up
CREATE TABLE games (
  id                  bigserial PRIMARY KEY,
  creator_id          bigint       NOT NULL REFERENCES users(id),
  status              game_status  NOT NULL DEFAULT 'LOBBY',
  seed                bigint       NOT NULL CHECK (seed BETWEEN 0 AND 4294967295), -- uint32, fed to mulberry32
  turn_deadline_hours integer      NOT NULL DEFAULT 24 CHECK (turn_deadline_hours > 0),
  forfeit_after_n     integer      NOT NULL DEFAULT 5  CHECK (forfeit_after_n >= 0), -- 0 = never
  war_declared        boolean      NOT NULL DEFAULT false,
  first_battle_done   boolean      NOT NULL DEFAULT false,
  replenish_cursor    integer      NOT NULL DEFAULT 0 CHECK (replenish_cursor >= 0),
  turn_number         integer      CHECK (turn_number >= 1),  -- NULL while in lobby
  outcome             outcome_kind,
  winner_player_id    bigint,       -- FK added below (circular with players)
  created_at          timestamptz  NOT NULL DEFAULT now(),
  started_at          timestamptz,
  ended_at            timestamptz,
  CHECK ((status = 'FINISHED') = (outcome IS NOT NULL)),
  CHECK (COALESCE(outcome = 'WIN', false) = (winner_player_id IS NOT NULL)),  -- WIN <=> winner set
  CHECK (first_battle_done <= war_declared)   -- boolean implication: no battle before war
);

CREATE TABLE players (
  id               bigserial PRIMARY KEY,
  game_id          bigint   NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id          bigint   NOT NULL REFERENCES users(id),
  country          text     CHECK (country IN
                     ('BRAZIL','CHINA','ENGLAND','FRANCE','GERMANY','INDIA','JAPAN','RUSSIA','USA')),
  start_population smallint CHECK (start_population BETWEEN 25 AND 99),
  population       integer  NOT NULL DEFAULT 0 CHECK (population >= 0),
  cash             integer  NOT NULL DEFAULT 0 CHECK (cash >= 0),
  thirds           integer  NOT NULL DEFAULT 0 CHECK (thirds >= 0),   -- factories in thirds
  missiles         integer  NOT NULL DEFAULT 0 CHECK (missiles >= 0),
  abms             integer  NOT NULL DEFAULT 0 CHECK (abms >= 0),
  bonus_missiles   integer  NOT NULL DEFAULT 0 CHECK (bonus_missiles >= 0),
  alive            boolean  NOT NULL DEFAULT true,
  forfeited        boolean  NOT NULL DEFAULT false,
  is_declarer      boolean  NOT NULL DEFAULT false,
  missed_streak    integer  NOT NULL DEFAULT 0 CHECK (missed_streak >= 0),
  joined_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, user_id),
  UNIQUE (game_id, country),              -- NULLs are distinct, so unpicked seats don't clash
  UNIQUE (id, game_id),                   -- target for composite FKs elsewhere
  CHECK (NOT forfeited OR NOT alive),
  CHECK (alive OR (cash = 0 AND thirds = 0 AND missiles = 0 AND abms = 0 AND bonus_missiles = 0))
);
CREATE INDEX players_game_idx ON players (game_id);

ALTER TABLE games
  ADD CONSTRAINT games_winner_fk
  FOREIGN KEY (winner_player_id, id) REFERENCES players (id, game_id)
  DEFERRABLE INITIALLY DEFERRED;

-- At most 9 players per game; joining only while the game is in the lobby.
CREATE FUNCTION enforce_player_limits() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g games%ROWTYPE; n integer;
BEGIN
  SELECT * INTO g FROM games WHERE id = NEW.game_id FOR UPDATE;
  IF g.status <> 'LOBBY' THEN
    RAISE EXCEPTION 'game % is not accepting players', NEW.game_id USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO n FROM players WHERE game_id = NEW.game_id;
  IF n >= 9 THEN
    RAISE EXCEPTION 'game % is full (9 players)', NEW.game_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER players_limit BEFORE INSERT ON players
  FOR EACH ROW EXECUTE FUNCTION enforce_player_limits();

-- Spy slots: 3 per player, remembering the last explicit target.
CREATE TABLE spy_slots (
  player_id        bigint   NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  slot             smallint NOT NULL CHECK (slot BETWEEN 0 AND 2),
  last_target_kind spy_kind,
  last_target_id   bigint,           -- players.id or minors.id depending on kind
  PRIMARY KEY (player_id, slot),
  CHECK ((last_target_kind IS NULL) = (last_target_id IS NULL))
);

-- migrate:down
DROP TABLE spy_slots;
DROP TRIGGER players_limit ON players;
DROP FUNCTION enforce_player_limits();
ALTER TABLE games DROP CONSTRAINT games_winner_fk;
DROP TABLE players;
DROP TABLE games;

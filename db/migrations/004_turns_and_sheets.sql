-- migrate:up
CREATE TABLE turns (
  id           bigserial PRIMARY KEY,
  game_id      bigint      NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  number       integer     NOT NULL CHECK (number >= 1),
  type         turn_type   NOT NULL,
  status       turn_status NOT NULL DEFAULT 'OPEN',
  opens_at     timestamptz NOT NULL DEFAULT now(),
  deadline_at  timestamptz NOT NULL,
  resolved_at  timestamptz,
  rng_seed     bigint      NOT NULL CHECK (rng_seed BETWEEN 0 AND 4294967295), -- seedForTurn(game.seed, number)
  state_before jsonb,      -- resolver state snapshot at open (or a hash if you prefer to keep rows small)
  state_after  jsonb,
  UNIQUE (game_id, number),
  UNIQUE (id, game_id),
  CHECK ((status = 'CLOSED') = (resolved_at IS NOT NULL)),
  CHECK (deadline_at > opens_at)
);
-- Deadline worker: find open turns past their deadline.
CREATE INDEX turns_open_deadline_idx ON turns (deadline_at) WHERE status = 'OPEN';

-- Only one turn per game can be open or resolving at a time.
CREATE UNIQUE INDEX turns_one_active_per_game ON turns (game_id) WHERE status IN ('OPEN', 'RESOLVING');

CREATE TABLE sheets (
  id         bigserial PRIMARY KEY,
  turn_id    bigint       NOT NULL,
  game_id    bigint       NOT NULL,
  player_id  bigint       NOT NULL,
  payload    jsonb        NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  is_final   boolean      NOT NULL DEFAULT false,
  source     sheet_source NOT NULL DEFAULT 'PLAYER',
  version    integer      NOT NULL DEFAULT 1,
  updated_at timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (turn_id, player_id),
  FOREIGN KEY (turn_id,   game_id) REFERENCES turns   (id, game_id) ON DELETE CASCADE,
  FOREIGN KEY (player_id, game_id) REFERENCES players (id, game_id) ON DELETE CASCADE
);
CREATE INDEX sheets_final_idx ON sheets (turn_id) WHERE is_final;

-- Players may only write sheets while the turn is OPEN. The resolver (server-default sheets)
-- writes while RESOLVING. Closed turns are immutable.
CREATE FUNCTION guard_sheet_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s turn_status; v_turn bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN v_turn := OLD.turn_id; ELSE v_turn := NEW.turn_id; END IF;
  SELECT status INTO s FROM turns WHERE id = v_turn;
  IF TG_OP = 'DELETE' THEN
    IF s = 'CLOSED' THEN RAISE EXCEPTION 'turn is closed' USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
  END IF;
  IF s = 'CLOSED' OR (s = 'RESOLVING' AND NEW.source = 'PLAYER') THEN
    RAISE EXCEPTION 'turn is not accepting player sheets' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.version := OLD.version + 1;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER sheets_guard BEFORE INSERT OR UPDATE OR DELETE ON sheets
  FOR EACH ROW EXECUTE FUNCTION guard_sheet_write();

-- Forward references now that turns exist.
ALTER TABLE games
  ADD CONSTRAINT games_current_turn_fk
  FOREIGN KEY (id, turn_number) REFERENCES turns (game_id, number)
  DEFERRABLE INITIALLY DEFERRED;

-- migrate:down
ALTER TABLE games DROP CONSTRAINT games_current_turn_fk;
DROP TRIGGER sheets_guard ON sheets;
DROP FUNCTION guard_sheet_write();
DROP TABLE sheets;
DROP TABLE turns;

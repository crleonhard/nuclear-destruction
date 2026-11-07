-- migrate:up
CREATE TABLE minors (
  id          bigserial PRIMARY KEY,
  game_id     bigint   NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  base_name   text     NOT NULL CHECK (base_name IN (
                'AUSTRALIA','BELGIUM','CUBA','DENMARK','ESTONIA','FINLAND','GUATEMALA','HUNGARY',
                'ICELAND','JORDAN','LEBANON','MONGOLIA','NORWAY','PANAMA','RWANDA','SYRIA',
                'TOGO','URUGUAY')),
  generation  integer  NOT NULL DEFAULT 1 CHECK (generation >= 1),   -- 1 = original, 2 = "(II)"...
  population  integer  NOT NULL DEFAULT 20 CHECK (population BETWEEN 0 AND 20),
  thirds      integer  NOT NULL DEFAULT 3  CHECK (thirds >= 0),
  missiles    integer  NOT NULL DEFAULT 5  CHECK (missiles >= 0),
  cash        integer  NOT NULL DEFAULT 0  CHECK (cash >= 0),        -- SERVER-ONLY bidding cash
  destroyed   boolean  NOT NULL DEFAULT false,
  UNIQUE (game_id, base_name, generation),
  UNIQUE (id, game_id),
  -- A destroyed minor holds nothing; a living one has population.
  CHECK (destroyed = (population = 0)),
  CHECK (NOT destroyed OR (thirds = 0 AND missiles = 0 AND cash = 0))
);
CREATE INDEX minors_game_idx ON minors (game_id) WHERE NOT destroyed;

CREATE TABLE minor_index (
  game_id   bigint  NOT NULL,
  minor_id  bigint  NOT NULL,
  player_id bigint  NOT NULL,
  value     integer NOT NULL DEFAULT 0 CHECK (value >= 0),
  PRIMARY KEY (minor_id, player_id),
  FOREIGN KEY (minor_id,  game_id) REFERENCES minors  (id, game_id) ON DELETE CASCADE,
  FOREIGN KEY (player_id, game_id) REFERENCES players (id, game_id) ON DELETE CASCADE
);
CREATE INDEX minor_index_player_idx ON minor_index (player_id);

-- The popularity index never decreases.
CREATE FUNCTION forbid_index_decrease() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.value < OLD.value THEN
    RAISE EXCEPTION 'minor_index may never decrease (% -> %)', OLD.value, NEW.value
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER minor_index_monotonic BEFORE UPDATE ON minor_index
  FOR EACH ROW EXECUTE FUNCTION forbid_index_decrease();

-- Controller of a minor: the strictly highest index among LIVING players, else NULL
-- (ties and all-zero both give NULL). Mirrors controller() in resolver.js.
CREATE FUNCTION minor_controller(p_minor_id bigint) RETURNS bigint
LANGUAGE sql STABLE AS $$
  WITH ranked AS (
    SELECT mi.player_id, mi.value,
           max(mi.value) OVER () AS top,
           count(*) OVER (PARTITION BY mi.value) AS holders
    FROM minor_index mi
    JOIN players p ON p.id = mi.player_id AND p.alive
    JOIN minors  m ON m.id = mi.minor_id AND NOT m.destroyed
    WHERE mi.minor_id = p_minor_id
  )
  SELECT player_id FROM ranked WHERE value = top AND holders = 1
$$;

-- Rank-1-or-2 list with competition ranking and index > 0 (the "first or second" report).
CREATE FUNCTION listed_minors(p_player_id bigint) RETURNS SETOF bigint
LANGUAGE sql STABLE AS $$
  SELECT mi.minor_id
  FROM minor_index mi
  JOIN minors m ON m.id = mi.minor_id AND NOT m.destroyed
  WHERE mi.player_id = p_player_id
    AND mi.value > 0
    AND (SELECT count(*) FROM minor_index o
         JOIN players op ON op.id = o.player_id AND op.alive
         WHERE o.minor_id = mi.minor_id AND o.player_id <> p_player_id AND o.value > mi.value) < 2
$$;

-- migrate:down
DROP FUNCTION listed_minors(bigint);
DROP FUNCTION minor_controller(bigint);
DROP TRIGGER minor_index_monotonic ON minor_index;
DROP FUNCTION forbid_index_decrease();
DROP TABLE minor_index;
DROP TABLE minors;

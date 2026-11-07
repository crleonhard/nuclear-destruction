-- migrate:up

-- Diplomatic messages: sent on turn N, delivered at the start of turn N+1.
-- from_player_id is kept even when anonymous; the API hides it. At most one message per
-- (turn, sender, recipient).
CREATE TABLE messages (
  id             bigserial PRIMARY KEY,
  game_id        bigint  NOT NULL,
  turn_id        bigint  NOT NULL,
  from_player_id bigint  NOT NULL,
  to_player_id   bigint  NOT NULL,
  text           text    NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  anonymous      boolean NOT NULL DEFAULT false,
  UNIQUE (turn_id, from_player_id, to_player_id),
  CHECK (from_player_id <> to_player_id),
  FOREIGN KEY (turn_id,        game_id) REFERENCES turns   (id, game_id) ON DELETE CASCADE,
  FOREIGN KEY (from_player_id, game_id) REFERENCES players (id, game_id) ON DELETE CASCADE,
  FOREIGN KEY (to_player_id,   game_id) REFERENCES players (id, game_id) ON DELETE CASCADE
);
CREATE INDEX messages_inbox_idx ON messages (to_player_id, turn_id);

-- World news: public, one per player per turn, max 60 characters.
CREATE TABLE world_news (
  id             bigserial PRIMARY KEY,
  game_id        bigint  NOT NULL,
  turn_id        bigint  NOT NULL,
  from_player_id bigint  NOT NULL,
  text           text    NOT NULL CHECK (length(text) BETWEEN 1 AND 60),
  anonymous      boolean NOT NULL DEFAULT false,
  UNIQUE (turn_id, from_player_id),
  FOREIGN KEY (turn_id,        game_id) REFERENCES turns   (id, game_id) ON DELETE CASCADE,
  FOREIGN KEY (from_player_id, game_id) REFERENCES players (id, game_id) ON DELETE CASCADE
);

-- Private reports (assets, first/second list, spy results, war notice, fire control).
-- turn_id is the turn that PRODUCED the report; it is shown at the start of the next turn.
CREATE TABLE reports (
  id        bigserial PRIMARY KEY,
  game_id   bigint      NOT NULL,
  turn_id   bigint      NOT NULL,
  player_id bigint      NOT NULL,
  kind      report_kind NOT NULL,
  payload   jsonb       NOT NULL,
  FOREIGN KEY (turn_id,   game_id) REFERENCES turns   (id, game_id) ON DELETE CASCADE,
  FOREIGN KEY (player_id, game_id) REFERENCES players (id, game_id) ON DELETE CASCADE
);
CREATE INDEX reports_player_turn_idx ON reports (player_id, turn_id);

-- Public result of a battle turn: who fired at whom, damaged populations.
CREATE TABLE battle_results (
  turn_id bigint PRIMARY KEY,
  game_id bigint NOT NULL,
  payload jsonb  NOT NULL,
  FOREIGN KEY (turn_id, game_id) REFERENCES turns (id, game_id) ON DELETE CASCADE
);

-- Append-only replay log. seq is monotonic within a game.
CREATE TABLE events (
  id      bigserial PRIMARY KEY,
  game_id bigint  NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  turn_id bigint,
  seq     integer NOT NULL CHECK (seq >= 0),
  type    text    NOT NULL,
  payload jsonb   NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (game_id, seq),
  FOREIGN KEY (turn_id, game_id) REFERENCES turns (id, game_id) ON DELETE CASCADE
);
CREATE INDEX events_turn_idx ON events (turn_id);

CREATE FUNCTION forbid_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Cascading deletes from a deleted game are allowed; direct edits are not.
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'events are append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'events are append-only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION forbid_event_mutation();

-- migrate:down
DROP TRIGGER events_append_only ON events;
DROP FUNCTION forbid_event_mutation();
DROP TABLE events;
DROP TABLE battle_results;
DROP TABLE reports;
DROP TABLE world_news;
DROP TABLE messages;

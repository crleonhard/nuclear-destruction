-- migrate:up
CREATE TYPE game_status  AS ENUM ('LOBBY', 'ACTIVE', 'FINISHED');
CREATE TYPE turn_type    AS ENUM ('NORMAL', 'BATTLE');
CREATE TYPE turn_status  AS ENUM ('OPEN', 'RESOLVING', 'CLOSED');
CREATE TYPE sheet_source AS ENUM ('PLAYER', 'SERVER_DEFAULT');
CREATE TYPE outcome_kind AS ENUM ('WIN', 'DRAW');
CREATE TYPE report_kind  AS ENUM (
  'ASSETS', 'FIRST_SECOND', 'SPY_PLAYER', 'SPY_MINOR', 'WAR_NOTICE', 'FIRE_CONTROL'
);
CREATE TYPE spy_kind     AS ENUM ('PLAYER', 'MINOR');

CREATE TABLE users (
  id           bigserial PRIMARY KEY,
  display_name text        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Shared trigger function: keeps updated_at honest.
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- migrate:down
DROP FUNCTION touch_updated_at();
DROP TABLE users;
DROP TYPE spy_kind, report_kind, outcome_kind, sheet_source, turn_status, turn_type, game_status;

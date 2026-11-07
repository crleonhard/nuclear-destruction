-- migrate:up

-- Public projection of a player: nothing the rules keep hidden (no cash, stockpiles,
-- factories, indices). The API should read other players through this view only.
CREATE VIEW public_players AS
SELECT id, game_id, country, population, alive, forfeited
FROM players;

-- Public projection of a minor: name and population only. Cash, missiles, factories and
-- indices are hidden; spies are the only legal window into them.
CREATE VIEW public_minors AS
SELECT id, game_id, base_name, generation,
       CASE generation
         WHEN 1 THEN base_name
         ELSE base_name || ' (' ||
              CASE generation WHEN 2 THEN 'II' WHEN 3 THEN 'III' WHEN 4 THEN 'IV' WHEN 5 THEN 'V'
                              ELSE generation::text END || ')'
       END AS display_name,
       population, destroyed
FROM minors;

-- Messages as the recipient may see them: sender hidden when anonymous.
CREATE VIEW inbox_messages AS
SELECT id, game_id, turn_id, to_player_id,
       CASE WHEN anonymous THEN NULL ELSE from_player_id END AS from_player_id,
       text, anonymous
FROM messages;

-- World news as the public may see it.
CREATE VIEW public_news AS
SELECT id, game_id, turn_id,
       CASE WHEN anonymous THEN NULL ELSE from_player_id END AS from_player_id,
       text
FROM world_news;

-- Sheets and the replay log are visible only after a game finishes (enforced in the API;
-- this view gives the API one safe place to read them).
CREATE VIEW replay_sheets AS
SELECT s.*
FROM sheets s
JOIN games g ON g.id = s.game_id AND g.status = 'FINISHED';

CREATE VIEW replay_events AS
SELECT e.*
FROM events e
JOIN games g ON g.id = e.game_id AND g.status = 'FINISHED';

-- Suggested role split (adjust names to your deployment):
--   app_resolver  full read/write on every table (turn pipeline, deadline worker)
--   app_api       SELECT on the public_* / inbox_* / replay_* views and the player's own rows
--                 via application queries; INSERT/UPDATE on sheets, players (lobby), games (lobby)
-- Left as comments so the migration runs without assuming roles exist.

-- migrate:down
DROP VIEW replay_events;
DROP VIEW replay_sheets;
DROP VIEW public_news;
DROP VIEW inbox_messages;
DROP VIEW public_minors;
DROP VIEW public_players;

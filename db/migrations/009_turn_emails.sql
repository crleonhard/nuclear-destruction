-- migrate:up

-- Opt-in turn emails. NULL = off (the default for everybody). When a person turns them on, this holds the moment
-- they did: "your turn is open" mails are only sent for turns that opened after that moment, so switching the
-- setting on never triggers a burst of mail about turns that were already running.
-- Only accounts with an email address can opt in (AI players and old name-only accounts have none).
ALTER TABLE users
  ADD COLUMN turn_emails_since timestamptz,
  ADD CONSTRAINT users_turn_emails_need_email CHECK (turn_emails_since IS NULL OR email IS NOT NULL);

-- One row per notification already handed to the mail server. The primary key is what makes each mail go out at
-- most once per person, game, turn and kind, even if two workers run at the same moment. sent_at also feeds the
-- daily sending cap. Rows are removed with their game or user, and old ones are swept by the worker.
CREATE TABLE turn_notifications (
  user_id      bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id      bigint      NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  turn_number  integer     NOT NULL CHECK (turn_number >= 1),
  kind         text        NOT NULL CHECK (kind IN ('TURN_OPEN', 'DEADLINE_SOON')),
  sent_at      timestamptz NOT NULL,
  PRIMARY KEY (user_id, game_id, turn_number, kind)
);
CREATE INDEX turn_notifications_sent_idx ON turn_notifications (sent_at);

-- migrate:down
DROP TABLE turn_notifications;
ALTER TABLE users DROP CONSTRAINT users_turn_emails_need_email, DROP COLUMN turn_emails_since;

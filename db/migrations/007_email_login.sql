-- migrate:up

-- Accounts made with the old display-name sign-up have no email, so the column stays nullable.
-- Emails are stored lower-cased (the application normalizes; the CHECK makes the database agree).
ALTER TABLE users
  ADD COLUMN email text UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254);

-- One row per emailed sign-in link. Only a SHA-256 hash of the secret is stored, so a copy of this
-- table cannot be used to sign in. A link works once (consumed_at) and only until expires_at.
CREATE TABLE login_links (
  id           bigserial PRIMARY KEY,
  token_hash   text        NOT NULL UNIQUE,
  email        text        NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  CHECK (expires_at > created_at)
);
-- "How many links did this address ask for recently?" (rate limit) and clean-up by age.
CREATE INDEX login_links_email_created_idx ON login_links (email, created_at);
CREATE INDEX login_links_expires_idx ON login_links (expires_at);

-- migrate:down
DROP TABLE login_links;
ALTER TABLE users DROP COLUMN email;

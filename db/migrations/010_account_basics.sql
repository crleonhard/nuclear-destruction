-- migrate:up

-- "Sign out everywhere": a login token carries the session_version it was issued under, and is only accepted while that
-- still equals the number stored here. Bumping the number cancels every token issued before, on every device. Tokens made
-- before this migration carry no number and count as 0, so nobody is signed out by the upgrade itself.
-- Deleting an account also bumps it, which is why a deleted person's tokens stop working at once.
--
-- deleted_at marks an account that was deleted by its owner. The row itself stays, because finished games and their
-- history refer to it, but everything that identifies the person is gone: no email (so nobody can sign in to it, and the
-- address is free to be used again for a new account), no turn-email setting, and a neutral display name.
ALTER TABLE users
  ADD COLUMN session_version integer NOT NULL DEFAULT 0 CHECK (session_version >= 0),
  ADD COLUMN deleted_at timestamptz,
  ADD CONSTRAINT users_deleted_has_no_email CHECK (deleted_at IS NULL OR (email IS NULL AND turn_emails_since IS NULL));

-- migrate:down
ALTER TABLE users DROP CONSTRAINT users_deleted_has_no_email, DROP COLUMN deleted_at, DROP COLUMN session_version;

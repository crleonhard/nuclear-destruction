-- migrate:up

-- An AI player is an ordinary seat whose user account is a server-controlled "bot": it has a persona (play style)
-- and no email, so nobody can sign in as it. The server submits its sheets through the same rules as a person's.
ALTER TABLE users
  ADD COLUMN ai_persona text CHECK (ai_persona IN ('HAWK', 'DIPLOMAT', 'OPPORTUNIST')),
  ADD CONSTRAINT users_ai_has_no_email CHECK (ai_persona IS NULL OR email IS NULL);

-- migrate:down
ALTER TABLE users DROP CONSTRAINT users_ai_has_no_email, DROP COLUMN ai_persona;

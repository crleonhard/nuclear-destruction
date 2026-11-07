// Local development server: in-memory data (lost on exit), a fixed dev secret, port 3000.
//   npm run dev                      real email-link sign-in; the "email" is printed in this terminal
//   (set SMTP_URL, MAIL_FROM and APP_URL first and the same command sends real email instead)
//   npm run dev -- --name-signup     skip email: sign up by typing a display name (quick way to be several players)
// Override anything with environment variables, for example PORT=4000 npm run dev.
process.env.STORE ??= 'memory';
process.env.AUTH_SECRET ??= 'dev-secret-not-for-production';
process.env.HOST ??= '127.0.0.1';

if (process.argv.includes('--name-signup')) {
  process.env.ALLOW_SIGNUP ??= 'true';
} else {
  if (!process.env.SMTP_URL) process.env.MAIL_TRANSPORT ??= 'console';   // with SMTP_URL set, real email is sent instead
  process.env.APP_URL ??= `http://localhost:${process.env.PORT || 3000}`;
}

const { main } = await import('../src/server.js');
await main();

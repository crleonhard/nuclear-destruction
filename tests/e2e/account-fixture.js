// A server for the browser tests of email sign-in, turn emails, the AI lobby and the account page.
//
// It is an ordinary in-memory server with email sign-in switched on (no name sign-up), except that:
//   * the mailer is replaced by one that keeps every message, so the browser test can read the sign-in and turn emails
//     (nothing is sent anywhere);
//   * the worker's longest sleep is an hour, so only what the app asks for (it wakes the worker when a game starts or a turn
//     resolves) makes it run during the test. Turn emails therefore go out on their own a moment after a game starts, as in real use.
//
// A second, tiny control server on its own port lets the Python test reach both:
//   GET  /mails   every message sent so far: [{ to, subject, text }]
//   POST /tick    runs one worker pass right now (a pass that finds nothing new is harmless) and answers when it is done
import http from 'node:http';
import net from 'node:net';
import { startServer } from '../../src/server.js';

const quiet = { log() {}, warn() {}, error() {} };

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

export async function startAccountFixture() {
  const port = await freePort();
  const mails = [];
  const app = await startServer({
    env: {
      STORE: 'memory', AUTH_SECRET: 'e2e-account-secret-0123456789', PORT: String(port), HOST: '127.0.0.1',
      APP_URL: `http://127.0.0.1:${port}`, MAIL_TRANSPORT: 'console', WORKER_INTERVAL_MS: '3600000',
    },
    mailer: { async send(m) { mails.push({ to: m.to, subject: m.subject, text: m.text }); } },
    logger: quiet,
  });
  const control = http.createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/mails') return reply(200, mails);
    if (req.method === 'POST' && req.url === '/tick') {
      await app.worker.tick();
      return reply(200, { passes: 'done' });
    }
    return reply(404, { error: 'not found' });
  });
  await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve));
  return {
    port: app.port, controlPort: control.address().port, mails,
    stop: async () => { await new Promise((r) => control.close(r)); await app.stop(); },
  };
}

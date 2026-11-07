// A scripted SMTP server for tests: speaks enough of the protocol to check what the client sends.
// Options pick the behaviour: implicit TLS, STARTTLS, which AUTH methods, rejecting a recipient, going silent.
import net from 'node:net';
import tls from 'node:tls';
import { TEST_CERT, TEST_KEY } from './test-cert.js';

export async function startFakeSmtp({
  implicitTls = false, starttls = false, auth = [], user = 'mailuser', pass = 'p@ss:w/rd', failRcpt = false, silent = false,
} = {}) {
  const sessions = [];
  const handler = (rawSocket) => {
    const session = { commands: [], message: null, authedOverTls: null, authenticated: false, tls: implicitTls, wrongPassword: false };
    sessions.push(session);
    let socket = rawSocket;
    let buf = '';
    let mode = 'cmd';          // cmd | data | login-user | login-pass
    let data = '';
    let loginUser = null;
    const send = (line) => socket.write(`${line}\r\n`);
    const check = (u, p) => { const ok = u === user && p === pass; session.wrongPassword = !ok; session.authenticated = ok; session.authedOverTls = session.tls; send(ok ? '235 welcome' : '535 bad credentials'); };

    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (mode === 'data') {
          if (line === '.') { mode = 'cmd'; session.message = data; send('250 queued'); } else data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          continue;
        }
        if (mode === 'login-user') { loginUser = Buffer.from(line, 'base64').toString(); mode = 'login-pass'; send('334 UGFzc3dvcmQ6'); continue; }
        if (mode === 'login-pass') { mode = 'cmd'; check(loginUser, Buffer.from(line, 'base64').toString()); continue; }
        session.commands.push(/^AUTH /i.test(line) ? 'AUTH ***' : line);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') {
          const lines = ['fake.example'];
          if (starttls && !session.tls) lines.push('STARTTLS');
          if (auth.length) lines.push(`AUTH ${auth.join(' ')}`);
          lines.push('8BITMIME');
          lines.forEach((l, n) => send(`250${n === lines.length - 1 ? ' ' : '-'}${l}`));
        } else if (verb === 'STARTTLS') {
          send('220 go ahead');
          socket.removeListener('data', onData);
          const upgraded = new tls.TLSSocket(rawSocket, { isServer: true, key: TEST_KEY, cert: TEST_CERT });
          socket = upgraded; session.tls = true; buf = '';
          upgraded.on('data', onData); upgraded.on('error', () => {});
        } else if (verb === 'AUTH') {
          const [, method, initial] = line.split(' ');
          if (method.toUpperCase() === 'PLAIN' && initial) { const [, u, p] = Buffer.from(initial, 'base64').toString().split('\0'); check(u, p); }
          else if (method.toUpperCase() === 'LOGIN') { mode = 'login-user'; send('334 VXNlcm5hbWU6'); }
          else send('504 unsupported');
        } else if (verb === 'MAIL') send('250 ok');
        else if (verb === 'RCPT') send(failRcpt ? '550 no such mailbox' : '250 ok');
        else if (verb === 'DATA') { mode = 'data'; data = ''; send('354 go'); }
        else if (verb === 'QUIT') { send('221 bye'); socket.end(); }
        else send('500 what?');
      }
    };
    rawSocket.on('error', () => {});
    if (!silent) send('220 fake.example ESMTP');
    socket.on('data', onData);
  };
  const server = implicitTls ? tls.createServer({ key: TEST_KEY, cert: TEST_CERT }, handler) : net.createServer(handler);
  server.on('tlsClientError', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port, sessions,
    url: (creds = true) => `${implicitTls ? 'smtps' : 'smtp'}://${creds ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : ''}127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }),
  };
}

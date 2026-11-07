import test from 'node:test';
import assert from 'node:assert/strict';
import { sendViaSmtp, parseSmtpUrl, parseMailbox, buildMessage, MailError } from '../src/mail/smtp.js';
import { createSmtpMailer, createConsoleMailer, createMemoryMailer } from '../src/mail/mailer.js';
import { startFakeSmtp } from './support/fake-smtp.js';
import { TEST_CERT } from './support/test-cert.js';

const from = { name: 'Nuclear Destruction', address: 'game@example.com' };
const TLS = { ca: TEST_CERT };
const LINK = 'https://game.example.com/#/verify/abc_DEF-123';
const send = (url, extra = {}) => sendViaSmtp({ url, from, to: 'ada@example.org', subject: 'Your sign-in link', text: `Open: ${LINK}\nBye\n`, tlsOptions: TLS, timeoutMs: 2000, ...extra });
const decodeBody = (message) => Buffer.from(message.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');

test('smtp url: ports, credentials with special characters, and bad input that never echoes the password', () => {
  assert.deepEqual(parseSmtpUrl('smtps://me:p%40ss%3Aw%2Frd@mail.example.com'), { secure: true, host: 'mail.example.com', port: 465, user: 'me', pass: 'p@ss:w/rd' });
  assert.deepEqual(parseSmtpUrl('smtp://mail.example.com'), { secure: false, host: 'mail.example.com', port: 587, user: null, pass: null });
  assert.equal(parseSmtpUrl('smtp://[::1]:1025').host, '::1');
  assert.throws(() => parseSmtpUrl('https://u:hunter2@x.com'), (e) => e instanceof MailError && !e.message.includes('hunter2'));
  assert.throws(() => parseSmtpUrl('not a url hunter2'), (e) => !e.message.includes('hunter2'));
});

test('mailbox: plain or named; anything that could smuggle a header or a second address is refused', () => {
  assert.deepEqual(parseMailbox('game@example.com'), { name: null, address: 'game@example.com' });
  assert.deepEqual(parseMailbox('Nuclear Destruction <game@example.com>'), { name: 'Nuclear Destruction', address: 'game@example.com' });
  for (const bad of ['', 'nope', 'a@b', 'x <a@b.c>, y <d@e.f>', 'a@b.c\r\nBcc: z@z.zz', 'Evil\r\n <a@b.c>', '"<a@b.c>']) assert.throws(() => parseMailbox(bad), MailError, JSON.stringify(bad));
});

test('message: headers are fixed, the body is base64 UTF-8, and line breaks cannot be injected', () => {
  const m = buildMessage({ from, to: 'ada@example.org', subject: 'Hello', text: 'Ünïcode ✓ link', date: new Date('2026-11-05T12:00:00Z'), messageIdDomain: 'game.example.com' });
  assert.match(m, /^Date: Thu, 05 Nov 2026 12:00:00 GMT\r\nFrom: Nuclear Destruction <game@example\.com>\r\nTo: ada@example\.org\r\nSubject: Hello\r\n/);
  assert.match(m, /Message-ID: <[0-9a-f]{24}@game\.example\.com>/);
  assert.match(m, /Content-Transfer-Encoding: base64/);
  assert.equal(decodeBody(m), 'Ünïcode ✓ link');
  assert.throws(() => buildMessage({ from, to: 'a@b.cd', subject: 'x\r\nBcc: evil@x.xx', text: '' }), MailError);
  assert.throws(() => buildMessage({ from, to: 'a@b.cd', subject: 'Ünï', text: '' }), MailError);
  assert.throws(() => buildMessage({ from, to: 'a@b.cd\r\nRCPT TO:<evil@x.xx>', subject: 's', text: '' }), MailError);
  assert.throws(() => buildMessage({ from, to: 'a@b.cd,evil@x.xx', subject: 's', text: '' }), MailError);
});

test('smtp over implicit TLS with AUTH PLAIN: delivers the message, and the password goes only over TLS', async () => {
  const s = await startFakeSmtp({ implicitTls: true, auth: ['PLAIN'] });
  try {
    await send(s.url());
    const [session] = s.sessions;
    assert.equal(session.authenticated, true);
    assert.equal(session.authedOverTls, true);
    assert.deepEqual(session.commands.filter((c) => /^(MAIL|RCPT)/.test(c)), ['MAIL FROM:<game@example.com>', 'RCPT TO:<ada@example.org>']);
    assert.ok(decodeBody(session.message).includes(LINK));
    assert.match(session.message, /^Subject: Your sign-in link$/m);
  } finally { await s.close(); }
});

test('smtp with STARTTLS and AUTH LOGIN: upgrades before signing in, then delivers', async () => {
  const s = await startFakeSmtp({ starttls: true, auth: ['LOGIN'] });
  try {
    await send(s.url());
    const [session] = s.sessions;
    assert.equal(session.authenticated, true);
    assert.equal(session.authedOverTls, true, 'credentials must follow the TLS upgrade');
    const verbs = session.commands.map((c) => c.split(' ')[0]);
    assert.deepEqual(verbs.slice(0, 3), ['EHLO', 'STARTTLS', 'EHLO']);
    assert.ok(decodeBody(session.message).includes(LINK));
  } finally { await s.close(); }
});

test('smtp: never sends credentials to a server that cannot encrypt, even on loopback', async () => {
  const s = await startFakeSmtp({ auth: ['PLAIN'] });            // no STARTTLS offered
  try {
    await assert.rejects(send(s.url()), /does not offer STARTTLS/);
    assert.equal(s.sessions[0].authenticated, false);
    assert.ok(!s.sessions[0].commands.some((c) => c.startsWith('AUTH')), 'no AUTH command may be sent');
  } finally { await s.close(); }
});

test('smtp: a local mail catcher without TLS or a password still works (loopback only)', async () => {
  const s = await startFakeSmtp();
  try {
    await send(s.url(false));
    assert.ok(decodeBody(s.sessions[0].message).includes(LINK));
  } finally { await s.close(); }
});

test('smtp: a wrong password and a refused recipient are errors, without the password in the message', async () => {
  const s = await startFakeSmtp({ implicitTls: true, auth: ['PLAIN'] });
  try {
    await assert.rejects(send(s.url().replace(/:[^:@]+@/, ':wrong@')), (e) => e instanceof MailError && e.code === 535 && e.permanent && !e.message.includes('wrong'));
  } finally { await s.close(); }
  const r = await startFakeSmtp({ implicitTls: true, auth: ['PLAIN'], failRcpt: true });
  try {
    await assert.rejects(send(r.url()), (e) => e.code === 550 && e.permanent);
  } finally { await r.close(); }
});

test('smtp: certificates are verified, so an untrusted server is refused', async () => {
  const s = await startFakeSmtp({ implicitTls: true, auth: ['PLAIN'] });
  try {
    await assert.rejects(send(s.url(), { tlsOptions: {} }), MailError);   // the test CA is not trusted by default
    assert.equal(s.sessions.filter((x) => x.authenticated).length, 0);
  } finally { await s.close(); }
});

test('smtp: a silent server times out, and a closed port is a clean error', async () => {
  const quiet = await startFakeSmtp({ silent: true });
  try { await assert.rejects(send(quiet.url(false), { timeoutMs: 150 }), /timed out/); } finally { await quiet.close(); }
  const port = quiet.port;
  await assert.rejects(send(`smtp://127.0.0.1:${port}`), /cannot connect/);
});

test('mailers: the smtp mailer validates its settings at creation; console and memory mailers behave', async () => {
  assert.throws(() => createSmtpMailer({ smtpUrl: 'ftp://x', from: 'a@b.cd' }), MailError);
  assert.throws(() => createSmtpMailer({ smtpUrl: 'smtp://x.example', from: 'nope' }), MailError);
  const s = await startFakeSmtp({ implicitTls: true, auth: ['PLAIN'] });
  try {
    const mailer = createSmtpMailer({ smtpUrl: s.url(), from: 'Nuclear Destruction <game@example.com>', ehloName: 'game.example.com', tlsOptions: TLS });
    await mailer.send({ to: 'ada@example.org', subject: 'Hi', text: 'body' });
    assert.equal(s.sessions[0].commands[0], 'EHLO game.example.com');
  } finally { await s.close(); }
  const lines = [];
  await createConsoleMailer({ logger: { log: (l) => lines.push(l) } }).send({ to: 'a@b.cd', subject: 'S', text: 'one\ntwo' });
  assert.match(lines[0], /To: a@b\.cd[\s\S]*Subject: S[\s\S]*one/);
  const mem = createMemoryMailer();
  await mem.send({ to: 'a@b.cd', subject: 'S', text: 'T' });
  assert.equal(mem.sent.length, 1);
});

// A small, dependency-free SMTP client: just enough to hand one message to a mail provider.
//
//   smtps://user:pass@smtp.example.com:465   implicit TLS (default port 465)
//   smtp://user:pass@smtp.example.com:587    plain connection upgraded with STARTTLS (default port 587)
//
// Rules this client keeps:
//   - Credentials are never sent over an unencrypted connection. For smtp:// the upgrade to TLS is required
//     (a server that does not offer STARTTLS is an error), except for a loopback host such as a local
//     mail catcher (MailHog, Mailpit) that has no TLS at all and needs no password.
//   - Server certificates are verified against the host name.
//   - Every wait has a timeout, and an SMTP error never includes the password.
//   - Addresses and headers are checked for line breaks, so no input can inject a header or a command.

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

export class MailError extends Error {
  constructor(message, { code = null, permanent = false } = {}) {
    super(message);
    this.name = 'MailError';
    this.code = code;
    this.permanent = permanent;
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Parses an SMTP URL into its parts. Throws a MailError that never echoes the password. */
export function parseSmtpUrl(text) {
  let u;
  try { u = new URL(text); } catch { throw new MailError('SMTP_URL is not a valid URL (expected smtp://user:pass@host:587 or smtps://user:pass@host:465)'); }
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') throw new MailError('SMTP_URL must start with smtp:// or smtps://');
  if (!u.hostname) throw new MailError('SMTP_URL has no host');
  const secure = u.protocol === 'smtps:';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return {
    secure, host,
    port: u.port ? Number(u.port) : secure ? 465 : 587,
    user: u.username ? decodeURIComponent(u.username) : null,
    pass: u.password ? decodeURIComponent(u.password) : null,
  };
}

/** A bare address: no spaces, angle brackets, quotes or control characters, exactly one @. */
export const isPlainAddress = (a) => typeof a === 'string' && a.length <= 254
  && /^[^\s<>()[\]\\,;:"@]+@[^\s<>()[\]\\,;:"@]+\.[^\s<>()[\]\\,;:"@]+$/.test(a);

/** Accepts `me@x.com` or `Display Name <me@x.com>`; returns { name, address }. */
export function parseMailbox(text) {
  const m = /^[ \t]*(?:([A-Za-z0-9 ._'-]{1,60}?)[ \t]*<([^<>]+)>|([^<>\s]+))[ \t]*$/.exec(text ?? '');
  const address = m?.[2] ?? m?.[3];
  if (!m || !isPlainAddress(address)) throw new MailError('MAIL_FROM must look like "game@example.com" or "Nuclear Destruction <game@example.com>"');
  return { name: m[1]?.trim() || null, address };
}

const b64lines = (text) => Buffer.from(text, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');

/** Builds the full RFC 5322 message text (CRLF line ends). Body is UTF-8, base64 encoded. */
export function buildMessage({ from, to, subject, text, date = new Date(), messageIdDomain = 'localhost' }) {
  if (/[\r\n]/.test(subject) || !/^[\x20-\x7e]*$/.test(subject)) throw new MailError('subject must be a single line of plain ASCII');
  if (!isPlainAddress(to)) throw new MailError('recipient address is not valid');
  const fromHeader = from.name ? `${from.name} <${from.address}>` : from.address;
  const id = `${crypto.randomBytes(12).toString('hex')}@${messageIdDomain.replace(/[^A-Za-z0-9.-]/g, '') || 'localhost'}`;
  return [
    `Date: ${date.toUTCString()}`,
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${id}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    '',
    b64lines(text),
  ].join('\r\n');
}

/** Reads SMTP replies (one or several lines, ending in "NNN text") from a socket. */
function replyReader(socket, timeoutMs) {
  let buf = '';
  let pending = null;
  let failure = null;
  const fail = (e) => { failure ??= e; if (pending) { const p = pending; pending = null; p.reject(failure); } };
  const pump = () => {
    if (!pending) return;
    const lines = buf.split('\r\n');
    const collected = [];
    for (let i = 0; i < lines.length - 1; i++) {
      collected.push(lines[i]);
      if (/^\d{3}( |$)/.test(lines[i])) {
        buf = lines.slice(i + 1).join('\r\n');
        const p = pending; pending = null;
        return p.resolve({ code: Number(lines[i].slice(0, 3)), lines: collected });
      }
    }
    return undefined;
  };
  const onData = (d) => { buf += d; if (buf.length > 64 * 1024) fail(new MailError('SMTP server sent too much data')); else pump(); };
  const onError = (e) => fail(new MailError(`SMTP connection error: ${e.code || e.message}`));
  const onClose = () => fail(new MailError('SMTP connection closed unexpectedly'));
  const onTimeout = () => { fail(new MailError('SMTP server timed out')); socket.destroy(); };
  socket.setEncoding('utf8');
  socket.setTimeout(timeoutMs);
  socket.on('data', onData); socket.on('error', onError); socket.on('close', onClose); socket.on('timeout', onTimeout);
  return {
    read: () => new Promise((resolve, reject) => { if (failure) return reject(failure); pending = { resolve, reject }; return pump(); }),
    detach: () => { socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); socket.off('timeout', onTimeout); },
  };
}

/**
 * Sends one message. `tlsOptions` (e.g. { ca }) is for tests and private certificate authorities;
 * certificates are verified by default.
 */
export async function sendViaSmtp({ url, from, to, subject, text, ehloName = 'localhost', timeoutMs = 20_000, tlsOptions = {}, now = () => new Date() }) {
  const cfg = typeof url === 'string' ? parseSmtpUrl(url) : url;
  const message = buildMessage({ from, to, subject, text, date: now(), messageIdDomain: ehloName });
  const loopback = LOOPBACK.has(cfg.host);

  let socket = await new Promise((resolve, reject) => {
    const onErr = (e) => reject(new MailError(`cannot connect to the mail server: ${e.code || e.message}`));
    const s = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: net.isIP(cfg.host) ? undefined : cfg.host, ...tlsOptions }, () => { s.off('error', onErr); resolve(s); })
      : net.connect({ host: cfg.host, port: cfg.port }, () => { s.off('error', onErr); resolve(s); });
    s.once('error', onErr);
    s.setTimeout(timeoutMs, () => { s.destroy(); reject(new MailError('cannot connect to the mail server: timed out')); });
  });
  let reader = replyReader(socket, timeoutMs);

  const expect = async (r, ...codes) => {
    if (!codes.includes(r.code)) {
      throw new MailError(`mail server replied ${r.code}: ${r.lines[r.lines.length - 1].slice(4)}`, { code: r.code, permanent: r.code >= 500 });
    }
    return r;
  };
  const cmd = async (line, ...codes) => { socket.write(`${line}\r\n`); return expect(await reader.read(), ...codes); };
  const mentions = (r, word) => r.lines.some((l) => new RegExp(`^\\d{3}[ -]${word}\\b`, 'i').test(l));

  try {
    await expect(await reader.read(), 220);
    let ehlo = await cmd(`EHLO ${ehloName}`, 250);

    if (!cfg.secure) {
      if (mentions(ehlo, 'STARTTLS')) {
        await cmd('STARTTLS', 220);
        reader.detach();
        socket = tls.connect({ socket, servername: net.isIP(cfg.host) ? undefined : cfg.host, ...tlsOptions });
        await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', (e) => reject(new MailError(`TLS to the mail server failed: ${e.code || e.message}`))); });
        reader = replyReader(socket, timeoutMs);
        ehlo = await cmd(`EHLO ${ehloName}`, 250);
      } else if (!loopback || cfg.user) {
        throw new MailError('the mail server does not offer STARTTLS; refusing to continue without encryption');
      }
    }

    if (cfg.user) {
      if (/[\r\n\0]/.test(cfg.user + (cfg.pass ?? ''))) throw new MailError('SMTP credentials contain control characters');
      if (mentions(ehlo, 'AUTH') && /AUTH[ =].*\bPLAIN\b/i.test(ehlo.lines.join('\n'))) {
        await cmd(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass ?? ''}`).toString('base64')}`, 235);
      } else if (/AUTH[ =].*\bLOGIN\b/i.test(ehlo.lines.join('\n'))) {
        await cmd('AUTH LOGIN', 334);
        await cmd(Buffer.from(cfg.user).toString('base64'), 334);
        await cmd(Buffer.from(cfg.pass ?? '').toString('base64'), 235);
      } else {
        throw new MailError('the mail server offers no supported sign-in method (PLAIN or LOGIN)');
      }
    }

    await cmd(`MAIL FROM:<${from.address}>`, 250);
    await cmd(`RCPT TO:<${to}>`, 250, 251);
    await cmd('DATA', 354);
    const stuffed = message.replace(/^\./gm, '..');
    socket.write(`${stuffed}${stuffed.endsWith('\r\n') ? '' : '\r\n'}.\r\n`);
    await expect(await reader.read(), 250);
    try { await cmd('QUIT', 221); } catch { /* the message is already accepted */ }
  } finally {
    reader.detach();
    socket.destroy();
  }
}

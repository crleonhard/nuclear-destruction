// A mailer is { send({ to, subject, text }) } and nothing more. Three are provided:
//   smtp     real delivery through any SMTP provider (src/mail/smtp.js)
//   console  prints the message to the server log: local development only (anyone who can read the log
//            could sign in as anybody, so the server refuses it in production unless forced)
//   memory   keeps messages in an array: tests
// Any object with the same `send` can be passed to the server instead (an HTTP email API, for example).

import { parseMailbox, parseSmtpUrl, sendViaSmtp, MailError } from './smtp.js';

export { MailError };

export function createMemoryMailer() {
  const sent = [];
  return { sent, async send(msg) { sent.push({ ...msg }); } };
}

export function createConsoleMailer({ logger = console } = {}) {
  return {
    async send({ to, subject, text }) {
      logger.log(`[mail:console] To: ${to}\n[mail:console] Subject: ${subject}\n${text.split('\n').map((l) => `[mail:console] ${l}`).join('\n')}`);
    },
  };
}

export function createSmtpMailer({ smtpUrl, from, ehloName = 'localhost', tlsOptions, timeoutMs }) {
  const cfg = parseSmtpUrl(smtpUrl);     // fail at startup, not at the first sign-in
  const sender = parseMailbox(from);
  return {
    send: ({ to, subject, text }) => sendViaSmtp({ url: cfg, from: sender, to, subject, text, ehloName, tlsOptions, timeoutMs }),
  };
}

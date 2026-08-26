import { connect as tlsConnect } from 'node:tls';
import { randomBytes } from 'node:crypto';

/**
 * Minimal SMTP client (implicit TLS, AUTH LOGIN) — enough to send alert mail
 * through Gmail's free SMTP (smtp.gmail.com:465 with an app password) or any
 * similar provider, with zero dependencies.
 */

export interface MailSocket {
  write(data: string): void;
  end(): void;
  destroy(): void;
  on(event: 'data', cb: (chunk: Buffer) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: () => void): void;
}

export interface SendMailOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  to: string[];
  subject: string;
  text: string;
  fromName?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to a TLS connection. */
  connect?: (host: string, port: number) => Promise<MailSocket>;
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

class SmtpConnection {
  private buffer = '';
  private waiter: { resolve: (reply: string) => void; reject: (err: Error) => void } | null = null;
  private closed = false;

  private socket: MailSocket;

  constructor(socket: MailSocket) {
    this.socket = socket;
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString();
      this.drain();
    });
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => this.fail(new Error('SMTP connection closed unexpectedly')));
  }

  /** A reply is complete at its final "NNN text" line (hyphen lines continue it). */
  private drain(): void {
    if (!this.waiter) return;
    const lines = this.buffer.split('\r\n');
    let consumed = 0;
    for (let i = 0; i < lines.length - 1; i++) {
      consumed += lines[i].length + 2;
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        const reply = this.buffer.slice(0, consumed);
        this.buffer = this.buffer.slice(consumed);
        const { resolve } = this.waiter;
        this.waiter = null;
        resolve(reply);
        return;
      }
    }
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.waiter?.reject(err);
    this.waiter = null;
  }

  read(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.drain();
    });
  }

  async expect(code: number, send?: string): Promise<string> {
    if (send !== undefined) this.socket.write(send + '\r\n');
    const reply = await this.read();
    if (!reply.startsWith(String(code))) {
      throw new Error(`SMTP: expected ${code}, got: ${reply.trim().split('\r\n').at(-1)}`);
    }
    return reply;
  }

  finish(): void {
    this.closed = true;
    this.socket.end();
  }
}

function buildMessage(opts: SendMailOptions): string {
  const fromName = opts.fromName ?? 'Grail Knife Finder';
  const messageId = `<${randomBytes(12).toString('hex')}@grail-knife-finder>`;
  // Base64 body + encoded-word subject: unicode-safe, and no dot-stuffing
  // needed since "." is not in the base64 alphabet.
  const body = b64(opts.text).replace(/(.{76})/g, '$1\r\n');
  return [
    `From: ${fromName} <${opts.user}>`,
    `To: ${opts.to.join(', ')}`,
    `Subject: =?UTF-8?B?${b64(opts.subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

const defaultConnect = (host: string, port: number): Promise<MailSocket> =>
  new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, servername: host }, () => resolve(socket));
    socket.once('error', reject);
  });

export async function sendMail(opts: SendMailOptions): Promise<void> {
  const socket = await (opts.connect ?? defaultConnect)(opts.host, opts.port);
  const timer = setTimeout(() => socket.destroy(), opts.timeoutMs ?? 30_000);
  const conn = new SmtpConnection(socket);
  try {
    await conn.expect(220);
    await conn.expect(250, 'EHLO grail-knife-finder.local');
    await conn.expect(334, 'AUTH LOGIN');
    await conn.expect(334, b64(opts.user));
    await conn.expect(235, b64(opts.pass));
    await conn.expect(250, `MAIL FROM:<${opts.user}>`);
    for (const rcpt of opts.to) {
      await conn.expect(250, `RCPT TO:<${rcpt}>`);
    }
    await conn.expect(354, 'DATA');
    await conn.expect(250, buildMessage(opts) + '\r\n.');
    socket.write('QUIT\r\n');
  } finally {
    clearTimeout(timer);
    conn.finish();
  }
}

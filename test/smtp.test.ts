import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { sendMail } from '../src/smtp.ts';

interface MockMailbox {
  commands: string[];
  message: string;
}

/** A plain-TCP mock SMTP server speaking just enough of the protocol. */
async function startMockSmtp(): Promise<{ port: number; mailbox: MockMailbox; close: () => void }> {
  const mailbox: MockMailbox = { commands: [], message: '' };
  const server = createServer((sock) => {
    let buffer = '';
    let inData = false;
    sock.write('220 mock ESMTP ready\r\n');
    sock.on('data', (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          mailbox.message = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          sock.write('250 2.0.0 queued\r\n');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        mailbox.commands.push(line);
        if (line.startsWith('EHLO')) sock.write('250-mock\r\n250 AUTH LOGIN\r\n');
        else if (line === 'AUTH LOGIN') sock.write('334 VXNlcm5hbWU6\r\n');
        else if (mailbox.commands.at(-2) === 'AUTH LOGIN') sock.write('334 UGFzc3dvcmQ6\r\n');
        else if (mailbox.commands.at(-3) === 'AUTH LOGIN') sock.write('235 2.7.0 accepted\r\n');
        else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) sock.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('500 what\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return { port, mailbox, close: () => server.close() };
}

test('sendMail speaks SMTP: auth, envelope, and a unicode-safe message', async () => {
  const { port, mailbox, close } = await startMockSmtp();
  try {
    await sendMail({
      host: '127.0.0.1',
      port,
      user: 'hunter@gmail.com',
      pass: 'app-password',
      to: ['ricardo@example.com', 'backup@example.com'],
      subject: '🔪 GRAIL IN STOCK — 1 new listing',
      text: 'Takada no Hamono Suiboku Gyuto 240 @ Tosho\nhttps://toshoknifearts.com/products/takada',
      connect: (host, p) =>
        new Promise<Socket>((resolve, reject) => {
          const s = connect(p, host, () => resolve(s));
          s.once('error', reject);
        }),
    });

    assert.ok(mailbox.commands.includes('MAIL FROM:<hunter@gmail.com>'));
    assert.ok(mailbox.commands.includes('RCPT TO:<ricardo@example.com>'));
    assert.ok(mailbox.commands.includes('RCPT TO:<backup@example.com>'));
    assert.equal(
      mailbox.commands[mailbox.commands.indexOf('AUTH LOGIN') + 1],
      Buffer.from('hunter@gmail.com').toString('base64'),
    );

    assert.match(mailbox.message, /^From: Grail Knife Finder <hunter@gmail\.com>/m);
    assert.match(mailbox.message, /^To: ricardo@example\.com, backup@example\.com/m);
    assert.match(mailbox.message, /^Subject: =\?UTF-8\?B\?/m);

    const bodyB64 = mailbox.message.split('\r\n\r\n')[1].replace(/\r\n/g, '');
    const body = Buffer.from(bodyB64, 'base64').toString('utf8');
    assert.ok(body.includes('https://toshoknifearts.com/products/takada'));
  } finally {
    close();
  }
});

test('sendMail surfaces SMTP rejections', async () => {
  const server = createServer((sock) => {
    sock.write('220 mock\r\n');
    sock.on('data', () => sock.write('535 5.7.8 bad credentials\r\n'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(
      sendMail({
        host: '127.0.0.1',
        port,
        user: 'u',
        pass: 'wrong',
        to: ['x@example.com'],
        subject: 's',
        text: 't',
        connect: (host, p) =>
          new Promise<Socket>((resolve, reject) => {
            const s = connect(p, host, () => resolve(s));
            s.once('error', reject);
          }),
      }),
      /expected 250/,
    );
  } finally {
    server.close();
  }
});

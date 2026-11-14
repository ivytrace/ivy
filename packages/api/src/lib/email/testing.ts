import net from 'node:net';

/** A received message: envelope plus the raw RFC 5322 text. */
export interface CaughtMail {
  from: string;
  to: string[];
  raw: string;
}

/**
 * A minimal SMTP catcher for tests (no TLS, no auth): accepts every message and keeps it, so tests
 * exercise the real nodemailer transport without sending anything anywhere.
 */
export async function startSmtpCatcher() {
  const messages: CaughtMail[] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let data = false;
    let current: CaughtMail = { from: '', to: [], raw: '' };
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 catcher ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (true) {
        if (data) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          current.raw = buffer.slice(0, end).replace(/^\.\./gm, '.');
          buffer = buffer.slice(end + 5);
          messages.push(current);
          current = { from: '', to: [], raw: '' };
          data = false;
          reply('250 OK queued');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') reply('250 catcher');
        else if (verb === 'MAIL') {
          current.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          reply('250 OK');
        } else if (verb === 'RCPT') {
          current.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          reply('250 OK');
        } else if (verb === 'DATA') {
          data = true;
          reply('354 End data with <CR><LF>.<CR><LF>');
        } else if (verb === 'QUIT') {
          reply('221 Bye');
          socket.end();
        } else reply('250 OK');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `smtp://127.0.0.1:${port}`,
    messages,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A header of a caught message (unfolded). */
export function mailHeader(raw: string, name: string): string | null {
  const head = raw.split('\r\n\r\n')[0].replace(/\r\n[ \t]+/g, ' ');
  const line = head.split('\r\n').find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(name.length + 1).trim() : null;
}

/** The message text with quoted-printable soft breaks and escapes undone (good enough for assertions). */
export const decodedMail = (raw: string) =>
  Buffer.from(
    raw.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
    'latin1',
  ).toString('utf8');

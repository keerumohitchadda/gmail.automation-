/** Builds RFC 2822 messages and encodes them the way Gmail's `messages.send` wants. */

export function buildRaw({ to, subject, body, inReplyTo, references }) {
  const headers = [
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);

  const encodedBody = chunk(Buffer.from(body, 'utf8').toString('base64'), 76).join('\r\n');
  const message = `${headers.join('\r\n')}\r\n\r\n${encodedBody}`;

  return Buffer.from(message, 'utf8').toString('base64url');
}

/** RFC 2047, so non-ASCII subjects survive the trip. */
function encodeHeader(value) {
  const text = value ?? '';
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function chunk(str, size) {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}

export function replySubject(subject) {
  const s = subject || '';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

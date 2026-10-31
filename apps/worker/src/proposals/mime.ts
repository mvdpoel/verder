import { randomUUID } from "node:crypto";

/**
 * THE RFC 5322 MESSAGE VERDER SENDS FOR MARTIN (Plan 2 Task 16).
 *
 * Hand-built, with no MIME dependency, because the shape is small and fixed:
 * one text/plain body, optionally followed by attachments in a multipart/mixed.
 * Everything is CRLF, every header value is refused if it carries a CR or LF
 * (a header injection would let an approved subject smuggle a Bcc in), and
 * there is deliberately no X-Unsent and no Bcc header: what Martin approved is
 * exactly who receives it.
 */

/** The whole message, attachments included. Gmail's own cap is 25 MB; this
 *  leaves headroom for base64 growth being counted against it differently. */
export const SEND_MAX_BYTES = 20 * 1024 * 1024;

/** The domain verder's generated Message-IDs live under. */
export const MESSAGE_ID_DOMAIN = "verder.vanderpoel.pro";

/** A fresh RFC 5322 Message-ID, angle brackets included. Generated and STORED
 *  on the proposal before the Gmail call, so recovery can look for it. */
export function newMessageId(): string {
  return `<${randomUUID()}@${MESSAGE_ID_DOMAIN}>`;
}

export interface MimeAttachment { fileName: string; mime: string; bytes: Buffer }

export interface MimeInput {
  from: string; to: string[]; cc: string[]; subject: string; body: string;
  messageId: string; inReplyTo?: string; references?: string; date: Date;
  attachments: MimeAttachment[];
}

const CRLF = "\r\n";

/** Refuse a header value that could start a new header line. */
function headerSafe(name: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`header ${name} contains a line break`);
  return value;
}

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/**
 * RFC 2047 B-encoded words for `s`, split so each encoded word stays within the
 * 75-character limit and never cuts a UTF-8 sequence (chunks are taken by code
 * point, 45 bytes at most, which base64-encodes to 60 characters).
 */
export function encodeWords(s: string): string[] {
  const words: string[] = [];
  let chunk = "";
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk || words.length === 0) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`);
}

/** A header value: kept as-is when it is short printable ASCII, B-encoded and
 *  folded otherwise. */
function textHeader(name: string, value: string): string {
  headerSafe(name, value);
  if (isAscii(value) && name.length + 2 + value.length <= 998) return `${name}: ${value}`;
  return `${name}: ${encodeWords(value).join(`${CRLF} `)}`;
}

function addressHeader(name: string, list: string[]): string {
  for (const a of list) headerSafe(name, a);
  return `${name}: ${list.join(`,${CRLF} `)}`;
}

/** RFC 5322 date-time in UTC, with a numeric zone rather than the obsolete GMT. */
export function rfc5322Date(d: Date): string {
  return d.toUTCString().replace(/GMT$/, "+0000");
}

/** Base64 wrapped at 76 characters per line (RFC 2045 §6.8). */
function base64Lines(buf: Buffer): string {
  const b64 = buf.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join(CRLF);
}

/** A quoted MIME parameter value; non-ASCII names become RFC 2047 words. */
function paramValue(name: string, value: string): string {
  headerSafe(name, value);
  if (isAscii(value)) return `"${value.replace(/["\\]/g, "\\$&")}"`;
  return `"${encodeWords(value).join(" ")}"`;
}

function textPart(body: string): string[] {
  // The canonical form of text/plain is CRLF line breaks (RFC 2046 §4.1.1).
  const canonical = body.replace(/\r?\n/g, CRLF);
  return [
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(canonical, "utf8")),
  ];
}

export function buildMime(m: MimeInput): Buffer {
  if (m.to.length === 0) throw new Error("a message needs at least one recipient");
  const head: string[] = [
    `From: ${headerSafe("From", m.from)}`,
    addressHeader("To", m.to),
    ...(m.cc.length ? [addressHeader("Cc", m.cc)] : []),
    textHeader("Subject", m.subject),
    `Date: ${rfc5322Date(m.date)}`,
    `Message-ID: ${headerSafe("Message-ID", m.messageId)}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${headerSafe("In-Reply-To", m.inReplyTo)}`] : []),
    ...(m.references ? [`References: ${headerSafe("References", m.references)}`] : []),
    "MIME-Version: 1.0",
  ];

  let lines: string[];
  if (m.attachments.length === 0) {
    lines = [...head, ...textPart(m.body)];
  } else {
    const boundary = `verder-${randomUUID()}`;
    lines = [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
      `--${boundary}`, ...textPart(m.body)];
    for (const a of m.attachments) {
      headerSafe("Content-Type", a.mime);
      lines.push(
        `--${boundary}`,
        `Content-Type: ${a.mime}; name=${paramValue("name", a.fileName)}`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename=${paramValue("filename", a.fileName)}`,
        "",
        base64Lines(a.bytes),
      );
    }
    lines.push(`--${boundary}--`);
  }
  return Buffer.from(lines.join(CRLF) + CRLF, "utf8");
}

/**
 * A zip writer, STORE only — no compression, no dependency.
 *
 * Everything in the vault is already compressed (PDF, JPEG, PNG, xlsx), so
 * deflate would buy 0–3% for real CPU in a request path. What is left is the
 * format itself: a local header per entry, the bytes, a central directory and
 * an end-of-central-directory record.
 *
 * NO ZIP64. The caps below are what keeps that honest. The byte cap is a
 * MEMORY bound, not a format bound: each entry is buffered so its CRC32 can be
 * written into its own header (the alternative is a data descriptor, which is
 * the upgrade path if the cap is ever reached).
 */

export const ZIP_MAX_ENTRIES = 500;
export const ZIP_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
  /** Timestamp written into the archive. Defaults to now; tests pass a fixed one. */
  at?: Date;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, which is what the format stores. Seconds have 2s resolution. */
function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
  "image/heic": "heic", "image/tiff": "tiff",
  "text/plain": "txt", "text/csv": "csv", "text/html": "html",
  "message/rfc822": "eml",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/zip": "zip",
};

export function extensionForMime(mime: string): string {
  return EXT[mime.split(";", 1)[0].trim().toLowerCase()] ?? "bin";
}

/**
 * A safe, unique entry name.
 *
 * The title is user text and reaches a filesystem when the archive is unpacked,
 * so path separators, control characters and traversal have to go. Duplicates
 * are real and ordinary: two documents titled "Beschikking" is a normal Tuesday.
 */
export function zipEntryName(title: string, mime: string, taken: Set<string>): string {
  const ext = extensionForMime(mime);
  const cleaned = title
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[/\\]+/g, " ")
    .replace(/\.{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/^\.+/, "")
    .trim() || "document";
  const stem = cleaned.toLowerCase().endsWith(`.${ext}`)
    ? cleaned.slice(0, -(ext.length + 1)) : cleaned;
  let name = `${stem}.${ext}`;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${stem} (${i}).${ext}`;
  taken.add(name.toLowerCase());
  return name;
}

export function buildZip(entries: ZipEntry[]): Buffer {
  if (entries.length === 0) {
    throw new Error("Een lege zip heeft geen zin: er is niets geselecteerd");
  }
  if (entries.length > ZIP_MAX_ENTRIES) {
    throw new Error(`Te veel bestanden in één zip (${entries.length}, maximum ${ZIP_MAX_ENTRIES})`);
  }
  const total = entries.reduce((n, e) => n + e.bytes.length, 0);
  if (total > ZIP_MAX_TOTAL_BYTES) {
    throw new Error(`Te groot voor één zip (${Math.round(total / 1024 / 1024)} MB, maximum 512 MB)`);
  }

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const { time, date } = dosDateTime(e.at ?? new Date());
    const crc = crc32(e.bytes);
    const size = e.bytes.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      // version needed
    local.writeUInt16LE(0x0800, 6);  // flag bit 11: the name is UTF-8
    local.writeUInt16LE(0, 8);       // method 0 = stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);   // compressed size == size, stored
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);      // no extra field
    locals.push(local, name, Buffer.from(e.bytes));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);    // version made by
    central.writeUInt16LE(20, 6);    // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);    // extra
    central.writeUInt16LE(0, 32);    // comment
    central.writeUInt16LE(0, 34);    // disk number
    central.writeUInt16LE(0, 36);    // internal attrs
    central.writeUInt32LE(0, 38);    // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + size;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                 // this disk
  eocd.writeUInt16LE(0, 6);                 // disk with the central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);                // no comment

  return Buffer.concat([...locals, cd, eocd]);
}

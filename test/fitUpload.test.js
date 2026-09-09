'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
  MAX_FIT_BYTES,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_TOTAL_BYTES,
  FitUploadError,
  readStreamWithLimit,
  normalizeEntryName,
  isRegularFile,
  resolveFitBuffer,
} = require('../src/fitUpload');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name);
    const data = Buffer.from(item.data || '');
    const flags = item.encrypted ? 1 : 0;
    const declared = item.declaredSize ?? data.length;
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(item.compressionMethod || 0, 8); local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declared, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30); data.copy(local, 30 + name.length);
    locals.push(local);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(item.compressionMethod || 0, 10); central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46); centrals.push(central);
    if (item.externalMode) central.writeUInt32LE((item.externalMode << 16) >>> 0, 38);
    offset += local.length;
  }
  const centralOffset = offset;
  const centralData = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...locals, centralData, end]);
}

test('resolveFitBuffer accepts direct FIT files case-insensitively', async () => {
  const fit = Buffer.from('FIT');
  assert.strictEqual(await resolveFitBuffer({ buffer: fit, filename: 'ACTIVITY.FIT' }), fit);
});

test('resolveFitBuffer extracts exactly one FIT from ZIP root, subdirectories, and ignores metadata', async () => {
  const fit = Buffer.from('binary-fit');
  const result = await resolveFitBuffer({
    buffer: zip([{ name: '__MACOSX/', data: '' }, { name: 'folder/activity.FIT', data: fit }]),
    filename: 'export.zip',
  });
  assert.deepEqual(result, fit);
});

test('resolveFitBuffer streams and discards non-FIT regular entries before extracting the candidate', async () => {
  const fit = Buffer.from('binary-fit');
  const result = await resolveFitBuffer({ buffer: zip([{ name: 'notes.txt', data: 'metadata' }, { name: 'activity.fit', data: fit }]), filename: 'export.zip' });
  assert.deepEqual(result, fit);
});

test('resolveFitBuffer rejects unsupported, empty, multiple, encrypted, unsafe, and corrupt ZIP inputs', async () => {
  const cases = [
    [{ filename: 'export.zip', buffer: zip([]) }, 'missing_fit'],
    [{ filename: 'export.zip', buffer: zip([{ name: 'a.fit', data: 'a' }, { name: 'b.fit', data: 'b' }]) }, 'multiple_fit'],
    [{ filename: 'export.zip', buffer: zip([{ name: 'a.fit', data: 'a', encrypted: true }]) }, 'encrypted_zip'],
    [{ filename: 'export.zip', buffer: zip([{ name: 'a.fit', data: 'a', compressionMethod: 99 }]) }, 'invalid_zip'],
    [{ filename: 'export.zip', buffer: zip([{ name: 'a.fit', data: 'a', externalMode: 0o120000 }]) }, 'unsafe_entry'],
    [{ filename: 'export.zip', buffer: zip([{ name: '../a.fit', data: 'a' }]) }, 'unsafe_entry'],
    [{ filename: 'export.zip', buffer: Buffer.from('not zip') }, 'invalid_zip'],
    [{ filename: 'notes.txt', buffer: Buffer.from('x') }, 'unsupported_type'],
    [{ filename: 'export.zip', buffer: zip([{ name: 'a.txt', data: 'a' }]) }, 'missing_fit'],
  ];
  for (const [input, code] of cases) await assert.rejects(resolveFitBuffer(input), (error) => error instanceof FitUploadError && error.code === code);
});

test('resolveFitBuffer enforces FIT, entry, entry-count, and total decompressed limits', async () => {
  await assert.rejects(resolveFitBuffer({ filename: 'a.fit', buffer: Buffer.alloc(MAX_FIT_BYTES + 1) }), /size limit/);
  await assert.rejects(resolveFitBuffer({ filename: 'a.zip', buffer: zip([{ name: 'a.fit', data: Buffer.alloc(MAX_FIT_BYTES + 1) }]) }), /decompressed size limit/);
  await assert.rejects(resolveFitBuffer({ filename: 'a.zip', buffer: zip([{ name: 'a.fit', data: Buffer.alloc(MAX_ZIP_TOTAL_BYTES + 1) }]) }), /decompressed size limit/);
  await assert.rejects(resolveFitBuffer({ filename: 'a.zip', buffer: zip([
    { name: 'a.fit', data: Buffer.alloc(9 * 1024 * 1024) },
    { name: 'b.bin', data: Buffer.alloc(9 * 1024 * 1024) },
    { name: 'c.bin', data: Buffer.alloc(9 * 1024 * 1024) },
  ]) }), /ZIP contents exceed/);
  await assert.rejects(resolveFitBuffer({ filename: 'a.zip', buffer: zip([{ name: 'a.fit', data: Buffer.alloc(MAX_FIT_BYTES + 1), declaredSize: 1 }]) }), /FIT file exceeds/);
  await assert.rejects(resolveFitBuffer({ filename: 'a.zip', buffer: zip([{ name: 'x.bin', data: Buffer.alloc(MAX_ZIP_TOTAL_BYTES + 1), declaredSize: 1 }, { name: 'a.fit', data: 'x', declaredSize: 1 }]) }), /ZIP contents exceed/);
  const entries = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `f${i}.txt`, data: '' }));
  await assert.rejects(resolveFitBuffer({ filename: 'a.zip', buffer: zip(entries) }), /too many entries/);
});

test('resolveFitBuffer rejects non-buffer values', async () => {
  await assert.rejects(resolveFitBuffer({ filename: 'a.fit', buffer: 'not-buffer' }), /uploaded file is invalid/);
});

test('stream reader enforces limits, destroys overflowing streams, and preserves controlled errors', async () => {
  const exact = await readStreamWithLimit(Readable.from([Buffer.from('ab'), 'cd']), 4, () => new FitUploadError('too_large', 'too large'));
  assert.deepEqual(exact, Buffer.from('abcd'));
  let consumed = 0;
  const overflowing = Readable.from(['abc', 'def', 'ghi']);
  overflowing.on('data', () => { consumed += 1; });
  await assert.rejects(readStreamWithLimit(overflowing, 5, () => new FitUploadError('too_large', 'too large')), /too large/);
  assert.ok(consumed <= 2);
  const broken = new Readable({ read() { this.destroy(new Error('boom')); } });
  await assert.rejects(readStreamWithLimit(broken, 5, () => new FitUploadError('stream_error', 'stream error')), /stream error/);
});

test('entry path normalization rejects POSIX, Windows, UNC, mixed traversal, null, and invalid names', () => {
  assert.equal(normalizeEntryName(null), '');
  for (const path of ['../activity.fit', 'folder/../activity.fit', '..\\activity.fit', 'folder\\..\\activity.fit', '/activity.fit', '\\activity.fit', 'C:\\activity.fit', 'C:/activity.fit', '\\\\server\\share\\activity.fit', '//server/share/activity.fit', 'bad\0.fit', '']) {
    assert.equal(require('../src/fitUpload').isUnsafePath(path), true, path);
  }
  assert.equal(normalizeEntryName('exports\\activities\\run.FIT'), 'exports/activities/run.FIT');
  assert.equal(isRegularFile({ type: 'File', externalFileAttributes: 0 }), true);
  assert.equal(isRegularFile({ type: 'File', externalFileAttributes: 0o100000 << 16 }), true);
  assert.equal(isRegularFile({ type: 'File', externalFileAttributes: 0o120000 << 16 }), false);
});

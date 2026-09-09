'use strict';

const unzipper = require('unzipper');

const MAX_FIT_BYTES = 10 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 100;
const MAX_ZIP_TOTAL_BYTES = 25 * 1024 * 1024;

class FitUploadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FitUploadError';
    this.code = code;
  }
}

function normalizeEntryName(name) {
  return typeof name === 'string' ? name.replaceAll('\\', '/') : '';
}

function isUnsafePath(name) {
  const normalized = normalizeEntryName(name);
  return !normalized || normalized.includes('\0') || normalized.startsWith('/')
    || normalized.startsWith('//') || normalized.split('/').includes('..')
    || /^[A-Za-z]:\//.test(normalized);
}

function isRegularFile(entry) {
  const mode = Number(entry.externalFileAttributes) >>> 16;
  if (!mode) return entry.type !== 'Directory';
  const type = mode & 0o170000;
  return type === 0 || type === 0o100000;
}

async function readStreamWithLimit(stream, maxBytes, errorFactory, onChunk, streamErrorFactory = errorFactory) {
  const chunks = [];
  let total = 0;
  try {
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy?.();
        throw errorFactory();
      }
      if (onChunk) onChunk(chunk);
      else chunks.push(chunk);
    }
  } catch (error) {
    stream.destroy?.();
    if (error instanceof FitUploadError) throw error;
    throw streamErrorFactory(error);
  }
  return Buffer.concat(chunks);
}

async function readZipFit(buffer) {
  let directory;
  try {
    directory = await unzipper.Open.buffer(buffer);
  } catch {
    throw new FitUploadError('invalid_zip', 'The ZIP file is invalid or corrupted.');
  }
  if (directory.files.length > MAX_ZIP_ENTRIES) {
    throw new FitUploadError('too_many_entries', 'The ZIP file contains too many entries.');
  }
  const candidates = [];
  const validatedEntries = [];
  let totalDeclared = 0;
  for (const entry of directory.files) {
    const name = normalizeEntryName(entry.path);
    if (isUnsafePath(name)) throw new FitUploadError('unsafe_entry', 'The ZIP file contains an unsafe entry name.');
    if (entry.type === 'Directory') continue;
    if (!isRegularFile(entry)) throw new FitUploadError('unsafe_entry', 'The ZIP file contains an unsafe entry name.');
    if (entry.flags & 1) throw new FitUploadError('encrypted_zip', 'Encrypted ZIP entries are not supported.');
    // macOS metadata is validated structurally, then ignored without decompression.
    if (name.startsWith('__MACOSX/')) continue;
    const declared = Number(entry.uncompressedSize);
    if (Number.isFinite(declared) && declared >= 0) {
      totalDeclared += declared;
      if (/\.fit$/i.test(name) && declared > MAX_FIT_BYTES) throw new FitUploadError('fit_too_large', 'The FIT file exceeds the decompressed size limit.');
      if (totalDeclared > MAX_ZIP_TOTAL_BYTES) throw new FitUploadError('zip_too_large', 'The ZIP contents exceed the decompressed size limit.');
    }
    validatedEntries.push(entry);
    if (/\.fit$/i.test(name)) candidates.push(entry);
  }
  if (candidates.length === 0) throw new FitUploadError('missing_fit', 'The ZIP file does not contain a FIT file.');
  if (candidates.length > 1) throw new FitUploadError('multiple_fit', 'The ZIP file contains more than one FIT file.');
  const entry = candidates[0];
  let totalReal = 0;
  let fitBuffer = null;
  for (const current of validatedEntries) {
    const isCandidate = current === entry;
    const chunks = isCandidate ? [] : undefined;
    const stream = current.stream();
    const overflowError = () => new FitUploadError(
      isCandidate ? 'fit_too_large' : 'zip_too_large',
      isCandidate ? 'The FIT file exceeds the decompressed size limit.' : 'The ZIP contents exceed the decompressed size limit.'
    );
    await readStreamWithLimit(stream, isCandidate ? MAX_FIT_BYTES : MAX_ZIP_TOTAL_BYTES, overflowError, (chunk) => {
      totalReal += chunk.length;
      if (totalReal > MAX_ZIP_TOTAL_BYTES) throw new FitUploadError('zip_too_large', 'The ZIP contents exceed the decompressed size limit.');
      if (isCandidate) chunks.push(chunk);
    }, () => new FitUploadError('invalid_zip', 'The ZIP file is invalid or corrupted.'));
    if (isCandidate) fitBuffer = Buffer.concat(chunks);
  }
  return fitBuffer;
}

async function resolveFitBuffer({ buffer, filename = '' }) {
  if (!Buffer.isBuffer(buffer)) throw new FitUploadError('invalid_file', 'The uploaded file is invalid.');
  if (/\.fit$/i.test(filename)) {
    if (buffer.length > MAX_FIT_BYTES) throw new FitUploadError('fit_too_large', 'The FIT file exceeds the size limit.');
    return buffer;
  }
  if (/\.zip$/i.test(filename)) return readZipFit(buffer);
  throw new FitUploadError('unsupported_type', 'Please upload a .FIT or .ZIP file.');
}

module.exports = {
  MAX_FIT_BYTES,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_TOTAL_BYTES,
  FitUploadError,
  readStreamWithLimit,
  normalizeEntryName,
  isRegularFile,
  isUnsafePath,
  resolveFitBuffer,
};

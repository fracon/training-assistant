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

function isUnsafePath(name) {
  return name.startsWith('/') || name.split('/').includes('..') || /^[A-Za-z]:[\\/]/.test(name);
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
  let totalDeclared = 0;
  for (const entry of directory.files) {
    const name = entry.path;
    if (isUnsafePath(name)) throw new FitUploadError('unsafe_entry', 'The ZIP file contains an unsafe entry name.');
    if (entry.type === 'Directory' || name.startsWith('__MACOSX/')) continue;
    const declared = Number(entry.uncompressedSize);
    if (Number.isFinite(declared) && declared >= 0) {
      totalDeclared += declared;
      if (declared > MAX_FIT_BYTES) throw new FitUploadError('fit_too_large', 'The FIT file exceeds the decompressed size limit.');
      if (totalDeclared > MAX_ZIP_TOTAL_BYTES) throw new FitUploadError('zip_too_large', 'The ZIP contents exceed the decompressed size limit.');
    }
    if (/\.fit$/i.test(name)) candidates.push(entry);
  }
  if (candidates.length === 0) throw new FitUploadError('missing_fit', 'The ZIP file does not contain a FIT file.');
  if (candidates.length > 1) throw new FitUploadError('multiple_fit', 'The ZIP file contains more than one FIT file.');
  const entry = candidates[0];
  if (entry.flags & 1) throw new FitUploadError('encrypted_zip', 'Encrypted ZIP entries are not supported.');
  let extracted;
  try {
    extracted = await entry.buffer();
  } catch {
    throw new FitUploadError('invalid_zip', 'The ZIP file is invalid or corrupted.');
  }
  if (extracted.length > MAX_FIT_BYTES) throw new FitUploadError('fit_too_large', 'The FIT file exceeds the decompressed size limit.');
  return extracted;
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
  isUnsafePath,
  resolveFitBuffer,
};

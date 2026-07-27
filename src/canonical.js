'use strict';
const crypto = require('crypto');

/**
 * Recursively key-sorted, compact JSON serialization.
 * - Object keys are sorted lexicographically at every level.
 * - Array order is preserved exactly as given.
 * - Primitives use normal JSON spelling (JSON.stringify).
 * This must match the grader's canonicalization exactly, since it is used
 * both for inputDigest and for proposalDigest / receipt-signature bytes.
 */
function canonicalStringify(value) {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
  }
  throw new TypeError(`Cannot canonicalize value of type ${t}`);
}

function sha256Hex(utf8String) {
  return crypto.createHash('sha256').update(Buffer.from(utf8String, 'utf8')).digest('hex');
}

function digestOf(value) {
  return sha256Hex(canonicalStringify(value));
}

module.exports = { canonicalStringify, sha256Hex, digestOf };

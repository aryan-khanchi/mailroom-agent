'use strict';
const crypto = require('crypto');

function importEd25519PublicKey(jwk) {
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('invalid_ed25519_jwk');
  }
  return crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
    format: 'jwk',
  });
}

/**
 * Verify an Ed25519 signature over UTF-8 message bytes.
 * `keyOrJwk` may be a crypto.KeyObject (already imported) or a raw JWK.
 * Never throws — returns false on any malformed input, since a bad
 * signature must reject the commit rather than crash the request.
 */
function verifyEd25519(keyOrJwk, messageUtf8, signatureBase64) {
  let key = keyOrJwk;
  try {
    if (!(key instanceof crypto.KeyObject)) {
      key = importEd25519PublicKey(keyOrJwk);
    }
    const sig = Buffer.from(signatureBase64, 'base64');
    return crypto.verify(null, Buffer.from(messageUtf8, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

module.exports = { importEd25519PublicKey, verifyEd25519 };

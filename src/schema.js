'use strict';

const PROFILE = 'ga5-mailroom-action-gate/v2';
const ALLOWED_ACTIONS = [
  'create_draft',
  'update_internal_record',
  'send_approved_notice',
  'request_confirmation',
  'quarantine_item',
  'no_action',
];
const PARTITIONS = ['stable_core', 'fresh_audit'];

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isStr(v) {
  return typeof v === 'string' && v.length > 0;
}
function fail(status, message) {
  return { ok: false, status, message };
}

// Structural + semantic validation of the whole propose request, done
// BEFORE any AI/tool work, and atomically (every dossier is checked, not
// just the first) per the task's "validate atomically" requirement.
function validateProposeRequest(body) {
  if (!isObj(body)) return fail(400, 'body must be a JSON object');
  if (body.operation !== 'propose') return fail(400, 'operation must be "propose"');
  if (body.profile !== PROFILE) return fail(422, 'unsupported or missing profile');
  if (!isStr(body.evaluationId)) return fail(422, 'evaluationId required');

  const rv = body.receiptVerifier;
  if (!isObj(rv) || rv.algorithm !== 'Ed25519') {
    return fail(422, 'receiptVerifier.algorithm must be "Ed25519"');
  }
  const jwk = rv.publicKeyJwk;
  if (!isObj(jwk) || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !isStr(jwk.x)) {
    return fail(422, 'invalid receiptVerifier.publicKeyJwk');
  }

  const corpus = body.corpus;
  if (
    !isObj(corpus) ||
    !isStr(corpus.coreId) ||
    !isStr(corpus.auditId) ||
    typeof corpus.stableCount !== 'number' ||
    typeof corpus.freshCount !== 'number'
  ) {
    return fail(422, 'invalid corpus');
  }

  if (
    !Array.isArray(body.allowedActions) ||
    body.allowedActions.length === 0 ||
    !body.allowedActions.every((a) => ALLOWED_ACTIONS.includes(a))
  ) {
    return fail(422, 'invalid allowedActions');
  }

  if (!Array.isArray(body.dossiers) || body.dossiers.length === 0) {
    return fail(422, 'dossiers must be a non-empty array');
  }

  const seenDossierIds = new Set();
  for (const d of body.dossiers) {
    if (!isObj(d)) return fail(422, 'each dossier must be an object');
    if (!isStr(d.dossierId)) return fail(422, 'dossierId required');
    if (seenDossierIds.has(d.dossierId)) return fail(422, 'duplicate dossierId in request');
    seenDossierIds.add(d.dossierId);
    if (!PARTITIONS.includes(d.partition)) return fail(422, 'invalid partition');
    if (!isStr(d.receivedAt)) return fail(422, 'receivedAt required');
    if (!isStr(d.mailbox)) return fail(422, 'mailbox required');
    if (typeof d.objective !== 'string') return fail(422, 'objective required');
    if (!Array.isArray(d.sources) || d.sources.length === 0) return fail(422, 'sources required');

    const seenLineIds = new Set();
    for (const s of d.sources) {
      if (!isObj(s)) return fail(422, 'each source must be an object');
      if (!isStr(s.sourceId) || !isStr(s.kind) || typeof s.provenance !== 'string' || typeof s.title !== 'string') {
        return fail(422, 'source fields required (sourceId, kind, provenance, title)');
      }
      if (!Array.isArray(s.lines) || s.lines.length === 0) return fail(422, 'lines required');
      for (const l of s.lines) {
        if (!isObj(l) || !isStr(l.lineId) || typeof l.text !== 'string') {
          return fail(422, 'invalid line (lineId, text required)');
        }
        if (seenLineIds.has(l.lineId)) return fail(422, 'duplicate lineId within dossier');
        seenLineIds.add(l.lineId);
      }
    }
  }

  return { ok: true };
}

function validateCommitRequest(body) {
  if (!isObj(body)) return fail(400, 'body must be a JSON object');
  if (body.operation !== 'commit') return fail(400, 'operation must be "commit"');
  if (body.profile !== PROFILE) return fail(422, 'unsupported or missing profile');
  if (!isStr(body.evaluationId)) return fail(422, 'evaluationId required');
  if (!isStr(body.inputDigest) || !/^[0-9a-f]{64}$/.test(body.inputDigest)) {
    return fail(422, 'invalid inputDigest');
  }
  if (!Array.isArray(body.receipts) || body.receipts.length === 0) {
    return fail(422, 'receipts must be a non-empty array');
  }

  const seenCallIds = new Set();
  const seenReceiptIds = new Set();
  for (const r of body.receipts) {
    if (!isObj(r)) return fail(422, 'each receipt must be an object');
    if (!isStr(r.dossierId) || !isStr(r.callId) || !isStr(r.action)) {
      return fail(422, 'receipt fields required (dossierId, callId, action)');
    }
    if (typeof r.accepted !== 'boolean') return fail(422, 'receipt.accepted must be boolean');
    if (!isStr(r.proposalDigest) || !/^[0-9a-f]{64}$/.test(r.proposalDigest)) {
      return fail(422, 'invalid receipt.proposalDigest');
    }
    if (!isStr(r.receiptId)) return fail(422, 'receiptId required');
    if (!isStr(r.receiptSignature)) return fail(422, 'receiptSignature required');
    if (seenCallIds.has(r.callId)) return fail(422, 'duplicate callId in receipts');
    if (seenReceiptIds.has(r.receiptId)) return fail(422, 'duplicate receiptId in receipts');
    seenCallIds.add(r.callId);
    seenReceiptIds.add(r.receiptId);
  }

  return { ok: true };
}

module.exports = { validateProposeRequest, validateCommitRequest, PROFILE, ALLOWED_ACTIONS };

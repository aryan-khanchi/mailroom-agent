'use strict';
// Must set env BEFORE requiring src/db.js or src/model.js, since both read
// process.env at module-load time.
const path = require('path');
const fs = require('fs');

process.env.MODEL_PROVIDER = 'mock';
const TEST_DATA_DIR = path.join(__dirname, '.tmp-test-data');
process.env.TURSO_DATABASE_URL = `file:${path.join(TEST_DATA_DIR, 'test.db')}`;

if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

const assert = require('assert');
const crypto = require('crypto');
const db = require('../src/db');
const { handlePropose } = require('../src/propose');
const { handleCommit } = require('../src/commit');
const { canonicalStringify, digestOf } = require('../src/canonical');

function makeKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }); // { kty:'OKP', crv:'Ed25519', x:'...' }
  return { publicKey, privateKey, jwk };
}

function sign(privateKey, obj) {
  const msg = canonicalStringify(obj);
  return crypto.sign(null, Buffer.from(msg, 'utf8'), privateKey).toString('base64');
}

function sampleDossier(id, text, partition = 'stable_core') {
  return {
    dossierId: id,
    partition,
    receivedAt: '2026-01-01T00:00:00Z',
    mailbox: 'support@example.com',
    objective: 'test objective',
    sources: [
      {
        sourceId: 's1',
        kind: 'email',
        provenance: 'external-customer',
        title: 'Original message',
        lines: [{ lineId: 'l1', text }],
      },
    ],
  };
}

function proposalDigestFor(p) {
  return digestOf({
    dossierId: p.dossierId,
    callId: p.callId,
    action: p.action,
    target: p.target ?? null,
    payload: p.payload,
    evidence: [...p.evidence].sort(),
  });
}

async function main() {
  await db.init();

  const { jwk, privateKey } = makeKeypair();
  const baseReq = {
    profile: 'ga5-mailroom-action-gate/v2',
    operation: 'propose',
    evaluationId: 'eval-1',
    receiptVerifier: { algorithm: 'Ed25519', publicKeyJwk: jwk },
    corpus: { coreId: 'c1', auditId: 'a1', stableCount: 1, freshCount: 0 },
    allowedActions: [
      'create_draft',
      'update_internal_record',
      'send_approved_notice',
      'request_confirmation',
      'quarantine_item',
      'no_action',
    ],
    dossiers: [sampleDossier('d1', 'hello world')],
  };

  // 1. Basic propose
  const res = await handlePropose(baseReq);
  assert.strictEqual(res.httpStatus, 200, 'propose should succeed');
  assert.strictEqual(res.body.status, 'awaiting_receipts');
  assert.strictEqual(res.body.proposals.length, 1);
  console.log('PASS: basic propose');

  // 2. Exact replay -> byte-equivalent response, no new work
  const res2 = await handlePropose(baseReq);
  assert.deepStrictEqual(res2.body, res.body, 'replay must be byte-equivalent');
  assert.strictEqual(res2.httpStatus, 200);
  console.log('PASS: exact replay');

  // 3. Same evaluationId, changed content -> 409
  const changedReq = JSON.parse(JSON.stringify(baseReq));
  changedReq.dossiers[0].sources[0].lines[0].text = 'different text now';
  const res3 = await handlePropose(changedReq);
  assert.strictEqual(res3.httpStatus, 409, 'changed content under same evaluationId must 409');
  console.log('PASS: changed-content conflict (409)');

  // 4. Malformed input -> 400/422
  const res4 = await handlePropose({ operation: 'propose' });
  assert.ok(res4.httpStatus === 400 || res4.httpStatus === 422);
  console.log(`PASS: malformed propose input rejected (${res4.httpStatus})`);

  const res5 = await handlePropose({
    ...baseReq,
    evaluationId: 'eval-dup',
    dossiers: [sampleDossier('dX', 'a'), sampleDossier('dX', 'b')],
  });
  assert.ok(res5.httpStatus === 400 || res5.httpStatus === 422);
  console.log(`PASS: duplicate dossierId rejected (${res5.httpStatus})`);

  const res6 = await handleCommit({ operation: 'commit' });
  assert.ok(res6.httpStatus === 400 || res6.httpStatus === 422);
  console.log(`PASS: malformed commit input rejected (${res6.httpStatus})`);

  // 5. Commit happy path
  const proposal = res.body.proposals[0];
  const inputDigest = res.body.inputDigest;
  const proposalDigest = proposalDigestFor(proposal);
  const receiptId = 'nonce-1';
  const signedReceipt = {
    dossierId: proposal.dossierId,
    callId: proposal.callId,
    action: proposal.action,
    accepted: true,
    proposalDigest,
    receiptId,
  };
  const receiptSignature = sign(privateKey, {
    profile: 'ga5-mailroom-action-gate/v2',
    evaluationId: 'eval-1',
    inputDigest,
    receipt: signedReceipt,
  });

  const commitReq = {
    profile: 'ga5-mailroom-action-gate/v2',
    operation: 'commit',
    evaluationId: 'eval-1',
    inputDigest,
    receipts: [{ ...signedReceipt, receiptSignature }],
  };
  const cres = await handleCommit(commitReq);
  assert.strictEqual(cres.httpStatus, 200);
  assert.strictEqual(cres.body.outcomes[0].status, 'executed');
  console.log('PASS: commit executed happy path');

  // 6. Commit replay -> byte-equivalent, idempotent
  const cres2 = await handleCommit(commitReq);
  assert.deepStrictEqual(cres2.body, cres.body);
  console.log('PASS: commit replay');

  // 7. Tampered signature must be rejected for a fresh evaluation
  const req2 = { ...baseReq, evaluationId: 'eval-3', dossiers: [sampleDossier('d2', 'more text')] };
  const pres2 = await handlePropose(req2);
  const p2 = pres2.body.proposals[0];
  const pd2 = proposalDigestFor(p2);
  const receipt2 = {
    dossierId: p2.dossierId,
    callId: p2.callId,
    action: p2.action,
    accepted: true,
    proposalDigest: pd2,
    receiptId: 'nonce-2',
  };
  const goodSig = sign(privateKey, {
    profile: 'ga5-mailroom-action-gate/v2',
    evaluationId: 'eval-3',
    inputDigest: pres2.body.inputDigest,
    receipt: receipt2,
  });
  const tamperedSig = goodSig.slice(0, -4) + (goodSig.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  const badReq = {
    profile: 'ga5-mailroom-action-gate/v2',
    operation: 'commit',
    evaluationId: 'eval-3',
    inputDigest: pres2.body.inputDigest,
    receipts: [{ ...receipt2, receiptSignature: tamperedSig }],
  };
  const badRes = await handleCommit(badReq);
  assert.notStrictEqual(badRes.httpStatus, 200, 'tampered signature must not succeed');
  assert.strictEqual(badRes.body.status, 'error');
  console.log(`PASS: tampered signature rejected (${badRes.httpStatus})`);

  // 8. accepted:false must yield "rejected", not "executed"
  const req3 = { ...baseReq, evaluationId: 'eval-4', dossiers: [sampleDossier('d3', 'yet more text')] };
  const pres3 = await handlePropose(req3);
  const p3 = pres3.body.proposals[0];
  const pd3 = proposalDigestFor(p3);
  const receipt3 = {
    dossierId: p3.dossierId,
    callId: p3.callId,
    action: p3.action,
    accepted: false,
    proposalDigest: pd3,
    receiptId: 'nonce-3',
  };
  const sig3 = sign(privateKey, {
    profile: 'ga5-mailroom-action-gate/v2',
    evaluationId: 'eval-4',
    inputDigest: pres3.body.inputDigest,
    receipt: receipt3,
  });
  const commitReq3 = {
    profile: 'ga5-mailroom-action-gate/v2',
    operation: 'commit',
    evaluationId: 'eval-4',
    inputDigest: pres3.body.inputDigest,
    receipts: [{ ...receipt3, receiptSignature: sig3 }],
  };
  const cres3 = await handleCommit(commitReq3);
  assert.strictEqual(cres3.httpStatus, 200);
  assert.strictEqual(cres3.body.outcomes[0].status, 'rejected');
  console.log('PASS: accepted:false yields status "rejected"');

  console.log('\nAll local tests passed.');
}

main().catch((e) => {
  console.error('TEST FAILURE:', e);
  process.exit(1);
});

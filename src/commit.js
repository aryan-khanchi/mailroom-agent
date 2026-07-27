'use strict';
const db = require('./db');
const { canonicalStringify, digestOf } = require('./canonical');
const { verifyEd25519, importEd25519PublicKey } = require('./ed25519');
const { validateCommitRequest } = require('./schema');
const { errorBody, PROFILE } = require('./util');

function computeProposalDigest(proposal) {
  const obj = {
    dossierId: proposal.dossierId,
    callId: proposal.callId,
    action: proposal.action,
    target: proposal.target ?? null,
    payload: proposal.payload,
    evidence: [...proposal.evidence].sort(),
  };
  return digestOf(obj);
}

async function handleCommit(body) {
  const check = validateCommitRequest(body);
  if (!check.ok) {
    return { httpStatus: check.status, body: errorBody(body, check.message) };
  }

  const { evaluationId, inputDigest, receipts } = body;

  const evalRow = await db.getEvaluation(evaluationId);
  if (!evalRow) {
    return { httpStatus: 422, body: errorBody(body, 'unknown evaluationId') };
  }
  if (evalRow.input_digest !== inputDigest) {
    return { httpStatus: 409, body: errorBody(body, 'inputDigest does not match the evaluation on file') };
  }

  // Idempotent replay: a prior commit for this evaluation already ran.
  // Return the same terminal result rather than re-verifying/re-executing.
  const existingCommit = await db.getCommit(evaluationId);
  if (existingCommit) {
    return { httpStatus: 200, body: JSON.parse(existingCommit.response_json) };
  }

  const proposals = JSON.parse(evalRow.proposals_json);
  const proposalByCallId = new Map(proposals.map((p) => [p.callId, p]));

  if (receipts.length !== proposals.length) {
    return { httpStatus: 422, body: errorBody(body, 'receipt count does not match proposal count') };
  }

  // Every receipt must correspond to a known proposal from THIS evaluation,
  // scoped exactly by dossierId + callId + action + proposalDigest. A
  // receipt for another proposal (even a valid one elsewhere) is rejected.
  for (const r of receipts) {
    const proposal = proposalByCallId.get(r.callId);
    if (!proposal || proposal.dossierId !== r.dossierId || proposal.action !== r.action) {
      return { httpStatus: 422, body: errorBody(body, 'receipt does not match a known proposal for this evaluation') };
    }
    const expectedDigest = computeProposalDigest(proposal);
    if (expectedDigest !== r.proposalDigest) {
      return { httpStatus: 422, body: errorBody(body, 'proposalDigest does not match the stored proposal') };
    }
  }

  // Verify every signature BEFORE taking any action. One bad/missing/
  // duplicated/misattributed signature rejects the whole commit.
  const publicKey = importEd25519PublicKey(JSON.parse(evalRow.receipt_verifier_json).publicKeyJwk);
  for (const r of receipts) {
    const signedObj = {
      profile: PROFILE,
      evaluationId,
      inputDigest,
      receipt: {
        dossierId: r.dossierId,
        callId: r.callId,
        action: r.action,
        accepted: r.accepted,
        proposalDigest: r.proposalDigest,
        receiptId: r.receiptId,
      },
    };
    const message = canonicalStringify(signedObj);
    const ok = verifyEd25519(publicKey, message, r.receiptSignature);
    if (!ok) {
      return { httpStatus: 422, body: errorBody(body, 'invalid receipt signature') };
    }
  }

  // All receipts verified -> persist + (mock) execute, then reply.
  const outcomes = [];
  const executedRows = [];

  for (const r of receipts) {
    const proposal = proposalByCallId.get(r.callId);
    const status = r.accepted === true ? 'executed' : 'rejected';
    if (status === 'executed') {
      executedRows.push({
        evaluation_id: evaluationId,
        call_id: r.callId,
        dossier_id: r.dossierId,
        action: r.action,
        target_json: proposal.target ? JSON.stringify(proposal.target) : null,
        payload_json: JSON.stringify(proposal.payload),
        executed_at: new Date().toISOString(),
      });
    }
    outcomes.push({
      dossierId: r.dossierId,
      callId: r.callId,
      action: r.action,
      proposalDigest: r.proposalDigest,
      receiptId: r.receiptId,
      status,
    });
  }

  const responseBody = {
    profile: PROFILE,
    evaluationId,
    status: 'completed',
    inputDigest,
    outcomes,
  };

  await db.insertCommitAndExecutedActions(evaluationId, JSON.stringify(responseBody), executedRows);

  return { httpStatus: 200, body: responseBody };
}

module.exports = { handleCommit, computeProposalDigest };

'use strict';
const db = require('./db');
const { canonicalStringify, digestOf } = require('./canonical');
const { verifyEd25519, importEd25519PublicKey } = require('./ed25519');
const { validateCommitRequest } = require('./schema');
const { errorBody, PROFILE } = require('./util');
const { makeLogger } = require('./logger');

const log = makeLogger('commit');

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

async function handleCommit(body, reqId) {
  const check = validateCommitRequest(body);
  if (!check.ok) {
    log.warn(reqId, { evaluationId: body && body.evaluationId, httpStatus: check.status }, `validation failed: ${check.message}`);
    return { httpStatus: check.status, body: errorBody(body, check.message) };
  }

  const { evaluationId, inputDigest, receipts } = body;
  log.info(reqId, { evaluationId, receiptCount: receipts.length, inputDigest }, 'validated');

  const evalRow = await db.getEvaluation(evaluationId);
  if (!evalRow) {
    log.warn(reqId, { evaluationId }, 'unknown evaluationId -> 422');
    return { httpStatus: 422, body: errorBody(body, 'unknown evaluationId') };
  }
  if (evalRow.input_digest !== inputDigest) {
    log.warn(
      reqId,
      { evaluationId, storedDigest: evalRow.input_digest, incomingDigest: inputDigest },
      'inputDigest mismatch vs stored evaluation -> 409'
    );
    return { httpStatus: 409, body: errorBody(body, 'inputDigest does not match the evaluation on file') };
  }

  // Idempotent replay: a prior commit for this evaluation already ran.
  // Return the same terminal result rather than re-verifying/re-executing.
  const existingCommit = await db.getCommit(evaluationId);
  if (existingCommit) {
    log.info(reqId, { evaluationId }, 'EXACT_REPLAY of prior commit -> 200 (no re-verification)');
    return { httpStatus: 200, body: JSON.parse(existingCommit.response_json) };
  }

  const proposals = JSON.parse(evalRow.proposals_json);
  const proposalByCallId = new Map(proposals.map((p) => [p.callId, p]));

  if (receipts.length !== proposals.length) {
    log.warn(
      reqId,
      { evaluationId, receiptCount: receipts.length, proposalCount: proposals.length },
      'receipt count does not match proposal count -> 422'
    );
    return { httpStatus: 422, body: errorBody(body, 'receipt count does not match proposal count') };
  }

  // Every receipt must correspond to a known proposal from THIS evaluation,
  // scoped exactly by dossierId + callId + action + proposalDigest. A
  // receipt for another proposal (even a valid one elsewhere) is rejected.
  for (const r of receipts) {
    const proposal = proposalByCallId.get(r.callId);
    if (!proposal || proposal.dossierId !== r.dossierId || proposal.action !== r.action) {
      log.warn(reqId, { evaluationId, callId: r.callId, dossierId: r.dossierId }, 'receipt does not match a known proposal -> 422');
      return { httpStatus: 422, body: errorBody(body, 'receipt does not match a known proposal for this evaluation') };
    }
    const expectedDigest = computeProposalDigest(proposal);
    if (expectedDigest !== r.proposalDigest) {
      log.warn(
        reqId,
        { evaluationId, callId: r.callId, expectedDigest, gotDigest: r.proposalDigest },
        'proposalDigest mismatch -> 422'
      );
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
      log.warn(reqId, { evaluationId, callId: r.callId, receiptId: r.receiptId }, 'invalid receipt signature -> 422 (whole commit rejected)');
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

  const executedCount = outcomes.filter((o) => o.status === 'executed').length;
  log.info(
    reqId,
    { evaluationId, executed: executedCount, rejected: outcomes.length - executedCount },
    'NEW_COMMIT stored -> 200'
  );

  return { httpStatus: 200, body: responseBody };
}

module.exports = { handleCommit, computeProposalDigest };

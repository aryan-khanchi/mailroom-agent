'use strict';
const { createClient } = require('@libsql/client');

// Same client works two ways, controlled entirely by TURSO_DATABASE_URL:
//   - "file:./data/mailroom.db"                    -> local file (offline tests, local dev)
//   - "libsql://your-db-name.turso.io" + auth token -> real Turso cloud database (production)
// This means the persistence layer no longer depends on the host's local
// disk surviving restarts - state lives in Turso, which is unaffected by
// the compute host scaling to zero, restarting, or redeploying.
const rawUrl = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN; // not needed for file: URLs

// Deliberately allow file: mode ONLY when explicitly requested (tests set
// TURSO_DATABASE_URL=file:... themselves) or when MODEL_PROVIDER=mock (the
// offline test suite's own model stub). Any other case with no
// TURSO_DATABASE_URL set is almost certainly a deployment misconfiguration -
// falling back silently would "work" long enough to crash-loop on a missing
// directory, or worse, run against local disk that a host like Koyeb/
// Railway/Render never guarantees will survive the next restart. Failing
// loudly here beats a cryptic native-module stack trace three layers down.
if (!rawUrl && process.env.MODEL_PROVIDER !== 'mock') {
  console.error(
    '[db] FATAL: TURSO_DATABASE_URL is not set. Set it (and TURSO_AUTH_TOKEN) ' +
      'in your deployment platform\'s environment variables - see README section ' +
      '"Get a Turso database". Refusing to silently fall back to local disk, ' +
      'since that would not survive a restart/redeploy on most hosts anyway.'
  );
  process.exit(1);
}

const url = rawUrl || 'file:./data/mailroom.db';
if (url.startsWith('file:')) {
  const fs = require('fs');
  const path = require('path');
  const filePath = url.slice('file:'.length);
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  console.warn(`[db] using local file storage at ${filePath} - fine for tests, NOT for production.`);
} else {
  console.log(`[db] using Turso: ${url}`);
}

const client = createClient(authToken ? { url, authToken } : { url });

async function init() {
  await client.batch(
    [
      `CREATE TABLE IF NOT EXISTS dossier_decisions (
        fingerprint   TEXT PRIMARY KEY,
        dossier_id    TEXT NOT NULL,
        call_id       TEXT NOT NULL,
        action        TEXT NOT NULL,
        target_json   TEXT,
        payload_json  TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at    TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS evaluations (
        evaluation_id         TEXT PRIMARY KEY,
        input_digest          TEXT NOT NULL,
        receipt_verifier_json TEXT NOT NULL,
        proposals_json        TEXT NOT NULL,
        response_json         TEXT NOT NULL,
        created_at            TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS commits (
        evaluation_id TEXT PRIMARY KEY,
        response_json TEXT NOT NULL,
        created_at    TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS executed_actions (
        evaluation_id TEXT NOT NULL,
        call_id       TEXT NOT NULL,
        dossier_id    TEXT NOT NULL,
        action        TEXT NOT NULL,
        target_json   TEXT,
        payload_json  TEXT NOT NULL,
        executed_at   TEXT NOT NULL,
        PRIMARY KEY (evaluation_id, call_id)
      )`,
    ],
    'write'
  );
}

async function getEvaluation(evaluationId) {
  const res = await client.execute({ sql: 'SELECT * FROM evaluations WHERE evaluation_id = ?', args: [evaluationId] });
  return res.rows[0] || null;
}

// Insert a new evaluation row. If a concurrent request already inserted the
// same evaluationId first (race), this catches the unique-constraint error
// and returns the row that won instead of throwing.
async function insertEvaluation(row) {
  try {
    await client.execute({
      sql: `INSERT INTO evaluations
              (evaluation_id, input_digest, receipt_verifier_json, proposals_json, response_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [row.evaluation_id, row.input_digest, row.receipt_verifier_json, row.proposals_json, row.response_json, row.created_at],
    });
    return { inserted: true, row: null };
  } catch (err) {
    if (String(err.message || '').toLowerCase().includes('unique')) {
      const existing = await getEvaluation(row.evaluation_id);
      return { inserted: false, row: existing };
    }
    throw err;
  }
}

async function getDossierDecisionsByFingerprints(fingerprints) {
  const map = new Map();
  if (fingerprints.length === 0) return map;
  const placeholders = fingerprints.map(() => '?').join(',');
  const res = await client.execute({
    sql: `SELECT * FROM dossier_decisions WHERE fingerprint IN (${placeholders})`,
    args: fingerprints,
  });
  for (const row of res.rows) map.set(row.fingerprint, row);
  return map;
}

async function insertDossierDecisions(rows) {
  if (rows.length === 0) return;
  const statements = rows.map((r) => ({
    sql: `INSERT INTO dossier_decisions
            (fingerprint, dossier_id, call_id, action, target_json, payload_json, evidence_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(fingerprint) DO NOTHING`,
    args: [r.fingerprint, r.dossier_id, r.call_id, r.action, r.target_json, r.payload_json, r.evidence_json, r.created_at],
  }));
  await client.batch(statements, 'write');
}

async function getCommit(evaluationId) {
  const res = await client.execute({ sql: 'SELECT * FROM commits WHERE evaluation_id = ?', args: [evaluationId] });
  return res.rows[0] || null;
}

// Atomically persist the terminal commit response and the executed-action
// log rows in a single transaction (all-or-nothing).
async function insertCommitAndExecutedActions(evaluationId, responseJson, executedRows) {
  const statements = executedRows.map((r) => ({
    sql: `INSERT OR IGNORE INTO executed_actions
            (evaluation_id, call_id, dossier_id, action, target_json, payload_json, executed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [r.evaluation_id, r.call_id, r.dossier_id, r.action, r.target_json, r.payload_json, r.executed_at],
  }));
  statements.push({
    sql: 'INSERT INTO commits (evaluation_id, response_json, created_at) VALUES (?, ?, ?)',
    args: [evaluationId, responseJson, new Date().toISOString()],
  });
  await client.batch(statements, 'write');
}

module.exports = {
  init,
  getEvaluation,
  insertEvaluation,
  getDossierDecisionsByFingerprints,
  insertDossierDecisions,
  getCommit,
  insertCommitAndExecutedActions,
};

'use strict';
const crypto = require('crypto');

function newRequestId() {
  return crypto.randomBytes(4).toString('hex');
}

// Structured, greppable log lines: [module] req=<id> key=val key=val ... message
// Using plain console.log/error (not a logging library) since Railway/most
// PaaS log viewers just capture stdout/stderr - simplicity here means one
// less dependency and nothing that can itself misbehave under load.
function makeLogger(moduleName) {
  function fmt(reqId, fields, message) {
    const parts = [`[${moduleName}]`];
    if (reqId) parts.push(`req=${reqId}`);
    for (const [k, v] of Object.entries(fields || {})) {
      if (v === undefined || v === null) continue;
      parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
    if (message) parts.push(message);
    return parts.join(' ');
  }
  return {
    info(reqId, fields, message) {
      console.log(fmt(reqId, fields, message));
    },
    warn(reqId, fields, message) {
      console.warn(fmt(reqId, fields, message));
    },
    error(reqId, fields, message) {
      console.error(fmt(reqId, fields, message));
    },
  };
}

module.exports = { newRequestId, makeLogger };

'use strict';
const { PROFILE } = require('./schema');

// The spec doesn't define an error-body schema, only status codes, so this
// is our own minimal, consistent shape for the 400/409/422 cases. It never
// echoes back dossier content, so it can't leak a canary even by accident.
function errorBody(reqBody, message) {
  return {
    profile: PROFILE,
    evaluationId: reqBody && typeof reqBody === 'object' ? reqBody.evaluationId : undefined,
    status: 'error',
    error: message,
  };
}

module.exports = { errorBody, PROFILE };

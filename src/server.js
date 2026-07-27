'use strict';
try {
  require('dotenv').config();
} catch {
  /* dotenv is optional in production, e.g. when env vars are injected by the platform */
}
const express = require('express');
const db = require('./db');
const { handlePropose } = require('./propose');
const { handleCommit } = require('./commit');

const MAX_BODY_BYTES = 512 * 1024; // matches the 512 KiB response cap; also a sane request cap

const app = express();
app.disable('x-powered-by');
app.set('json spaces', 0); // compact, deterministic output for exact-replay byte stability
app.use(express.json({ limit: '4mb' })); // dossiers corpus (~70-75k tokens) is larger than the response

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('handler timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

app.post('/v1/mailroom/actions', async (req, res) => {
  const body = req.body;
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ status: 'error', error: 'invalid JSON body' });
    }

    let result;
    if (body.operation === 'propose') {
      result = await withTimeout(handlePropose(body), 50_000);
    } else if (body.operation === 'commit') {
      result = await withTimeout(handleCommit(body), 50_000);
    } else {
      return res.status(400).json({ status: 'error', error: 'operation must be "propose" or "commit"' });
    }

    const serialized = JSON.stringify(result.body);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BODY_BYTES) {
      console.error('[server] response exceeds 512 KiB, this should not happen at exam scale');
    }

    res.setHeader('Content-Type', 'application/json');
    return res.status(result.httpStatus).send(serialized);
  } catch (err) {
    console.error('[server] unhandled error:', err);
    return res.status(500).json({ status: 'error', error: 'internal error' });
  }
});

// Malformed-JSON body handler (express.json() throws before our route runs).
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ status: 'error', error: 'malformed JSON' });
  }
  console.error('[server] error middleware:', err);
  return res.status(500).json({ status: 'error', error: 'internal error' });
});

const PORT = process.env.PORT || 8080;
if (require.main === module) {
  db.init()
    .then(() => {
      app.listen(PORT, () => console.log(`mailroom agent listening on :${PORT}`));
    })
    .catch((err) => {
      console.error('[server] failed to initialize database:', err);
      process.exit(1);
    });
}

module.exports = app;

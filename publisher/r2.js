/**
 * Minimal S3 client for Cloudflare R2 - just the one PUT this project needs.
 *
 * Written against node:crypto rather than pulling in an SDK, so the project
 * keeps its zero-dependency shape. R2 speaks the S3 API with region "auto".
 */

const crypto = require('node:crypto');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const REGION = 'auto';
const SERVICE = 's3';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

// AWS wants 20240908T071500Z, which is the ISO string minus punctuation
function amzTimestamp(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function signingKey(secretAccessKey, dateStamp) {
  let key = hmac(`AWS4${secretAccessKey}`, dateStamp);
  key = hmac(key, REGION);
  key = hmac(key, SERVICE);
  return hmac(key, 'aws4_request');
}

/**
 * Upload one object. `body` must be a Buffer.
 * Returns nothing; throws with the response body when R2 rejects the request.
 */
async function putObject(config, key, body, { contentType, cacheControl } = {}) {
  const { accountId, accessKeyId, secretAccessKey, bucket } = config;

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = '/' + [bucket, ...key.split('/')].map(encodeURIComponent).join('/');

  const now = new Date();
  const amzDate = amzTimestamp(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);

  // `host` has to be signed, but undici refuses to let us set it by hand - the
  // URL already produces the same value, so sign it and leave it off the fetch.
  const signedHeaderValues = {
    'cache-control': cacheControl,
    'content-type': contentType,
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  };

  const names = Object.keys(signedHeaderValues).filter(n => signedHeaderValues[n] !== undefined).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map(n => `${n}:${String(signedHeaderValues[n]).trim()}\n`).join('');

  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '',                 // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(secretAccessKey, dateStamp))
    .update(stringToSign)
    .digest('hex');

  const headers = { ...signedHeaderValues };
  delete headers.host;
  headers.Authorization =
    `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${host}${canonicalUri}`, {
    method: 'PUT',
    headers,
    body,
    signal: AbortSignal.timeout(30000)
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`R2 PUT ${key} -> ${res.status} ${detail}`);
  }
}

module.exports = { putObject };

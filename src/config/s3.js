const { S3Client } = require('@aws-sdk/client-s3');
const env = require('./env');

let cached = null;

const isS3Configured = () =>
  Boolean(env.S3_REGION && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);

const getS3Client = () => {
  if (!isS3Configured()) return null;
  if (cached) return cached;
  cached = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT || undefined,
    forcePathStyle: env.S3_FORCE_PATH_STYLE || false,
    // SDK v3 defaults to adding a CRC32 checksum as a signed header. Browsers
    // can't replay that header on a presigned PUT, so the signature mismatches
    // and S3 returns 403. Disable both calculation and validation for this
    // workflow — TLS already protects integrity in transit.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
  return cached;
};

/**
 * Build the public URL the customer / partner / admin app should fetch the
 * uploaded asset from. Honours S3_PUBLIC_BASE_URL when a CDN sits in front.
 */
const buildPublicUrl = (key) => {
  if (env.S3_PUBLIC_BASE_URL) {
    return `${env.S3_PUBLIC_BASE_URL.replace(/\/+$/, '')}/${key}`;
  }
  if (env.S3_ENDPOINT) {
    // MinIO / R2 / Spaces — use the configured endpoint with bucket in the path.
    const base = env.S3_ENDPOINT.replace(/\/+$/, '');
    return env.S3_FORCE_PATH_STYLE
      ? `${base}/${env.S3_BUCKET}/${key}`
      : `${base}/${key}`;
  }
  return `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com/${key}`;
};

module.exports = { getS3Client, isS3Configured, buildPublicUrl };

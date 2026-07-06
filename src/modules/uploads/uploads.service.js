const crypto = require('crypto');
const path = require('path');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const env = require('../../config/env');
const { getS3Client, isS3Configured, buildPublicUrl } = require('../../config/s3');
const ApiError = require('../../utils/ApiError');

const PRESIGN_EXPIRES_SECONDS = 60 * 5; // 5 min — plenty for the browser PUT to complete

/// Every upload gets a unique key (timestamp + random hex, below), so the
/// resulting URL is immutable — replacing an image always mints a new URL.
/// That makes "cache forever" safe and lets the apps' image caches skip
/// re-downloads entirely.
///
/// OPT-IN, not default: the header becomes part of the presigned PUT's
/// signature, so the uploading client MUST send a matching Cache-Control
/// header or S3 rejects the PUT with a 403. Old partner-app binaries in
/// the field don't send it — signing it unconditionally would break their
/// KYC uploads. Clients that pass `longCache: true` get the header signed
/// and echo it back (see admin-panel / partner-app uploads helpers).
const LONG_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const slugifySegment = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

const buildKey = (folder, filename) => {
  const ext = (path.extname(filename) || '').toLowerCase();
  const base = path.basename(filename, ext);
  const safeBase = slugifySegment(base) || 'file';
  const stamp = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  const safeFolder = folder ? slugifySegment(folder) : 'uploads';
  return `${safeFolder}/${stamp}-${rand}-${safeBase}${ext}`;
};

exports.presignUpload = async ({ filename, contentType, size, folder, longCache }) => {
  if (!isS3Configured()) {
    throw new ApiError(
      503,
      'Image uploads are not configured. Set S3_REGION / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY in the backend .env.',
    );
  }

  const client = getS3Client();
  const key = buildKey(folder, filename);

  const cacheControl = longCache ? LONG_CACHE_CONTROL : undefined;
  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ContentType: contentType,
    ContentLength: size,
    CacheControl: cacheControl,
  });

  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: PRESIGN_EXPIRES_SECONDS,
  });

  return {
    uploadUrl,
    publicUrl: buildPublicUrl(key),
    key,
    expiresIn: PRESIGN_EXPIRES_SECONDS,
    contentType,
    /// Echo the exact header value the client must send on the PUT —
    /// it's signed, so any mismatch (including omission) 403s.
    cacheControl: cacheControl ?? null,
  };
};

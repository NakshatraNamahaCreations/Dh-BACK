const crypto = require('crypto');
const path = require('path');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const env = require('../../config/env');
const { getS3Client, isS3Configured, buildPublicUrl } = require('../../config/s3');
const ApiError = require('../../utils/ApiError');

const PRESIGN_EXPIRES_SECONDS = 60 * 5; // 5 min — plenty for the browser PUT to complete

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

exports.presignUpload = async ({ filename, contentType, size, folder }) => {
  if (!isS3Configured()) {
    throw new ApiError(
      503,
      'Image uploads are not configured. Set S3_REGION / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY in the backend .env.',
    );
  }

  const client = getS3Client();
  const key = buildKey(folder, filename);

  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ContentType: contentType,
    ContentLength: size,
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
  };
};

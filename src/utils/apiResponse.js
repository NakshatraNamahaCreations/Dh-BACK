const success = (res, data, message = 'Success', statusCode = 200, meta) => {
  const payload = { success: true, message, data };
  if (meta) payload.meta = meta;
  return res.status(statusCode).json(payload);
};

const created = (res, data, message = 'Created') => success(res, data, message, 201);

module.exports = { success, created };

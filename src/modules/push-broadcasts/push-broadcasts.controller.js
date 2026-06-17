const service = require('./push-broadcasts.service');

exports.send = async (req, res) => {
  const { title, body, imageUrl, audience } = req.body;
  const result = await service.send(req.user.sub, { title, body, imageUrl, audience });
  res.status(201).json({ success: true, data: result });
};

exports.list = async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20));
  const result = await service.list({ page, pageSize });
  res.json({ success: true, ...result });
};

exports.remove = async (req, res) => {
  const id = Number(req.params.id);
  await service.remove(id);
  res.json({ success: true, data: { id } });
};

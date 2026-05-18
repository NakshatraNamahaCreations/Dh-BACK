const service = require('./notifications.service');

exports.list = async (req, res) => {
  const partnerId = Number(req.user.sub);
  const { limit, before } = req.query;
  const data = await service.listForPartner(partnerId, { limit, before });
  const unread = await service.unreadCount(partnerId);
  res.json({ success: true, data: { items: data, unread } });
};

exports.markRead = async (req, res) => {
  const partnerId = Number(req.user.sub);
  const data = await service.markRead(partnerId, req.params.id);
  res.json({ success: true, data });
};

exports.markAllRead = async (req, res) => {
  const partnerId = Number(req.user.sub);
  const data = await service.markAllRead(partnerId);
  res.json({ success: true, data });
};

exports.remove = async (req, res) => {
  const partnerId = Number(req.user.sub);
  const data = await service.remove(partnerId, req.params.id);
  res.json({ success: true, data });
};

exports.clearAll = async (req, res) => {
  const partnerId = Number(req.user.sub);
  const data = await service.clearAll(partnerId);
  res.json({ success: true, data });
};

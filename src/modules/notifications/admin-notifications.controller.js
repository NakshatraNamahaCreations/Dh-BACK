const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const service = require('./admin-notifications.service');

/// Every controller below reads the admin id from `req.user.sub` (the
/// JWT subject set by `authenticate`). The id is NEVER trusted from
/// path / query / body parameters, so one admin can't read or mark
/// another admin's notifications.

exports.list = asyncHandler(async (req, res) => {
  const data = await service.listForAdmin(req.user.sub, {
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    before: req.query.before,
  });
  const unread = await service.unreadCount(req.user.sub);
  success(res, { items: data, unread }, 'Notifications fetched');
});

exports.markAllRead = asyncHandler(async (req, res) => {
  const data = await service.markAllRead(req.user.sub);
  success(res, data, 'All notifications marked read');
});

exports.markRead = asyncHandler(async (req, res) => {
  const data = await service.markRead(req.user.sub, req.params.id);
  success(res, data, 'Notification marked read');
});

exports.remove = asyncHandler(async (req, res) => {
  const data = await service.remove(req.user.sub, req.params.id);
  success(res, data, 'Notification removed');
});

exports.clearAll = asyncHandler(async (req, res) => {
  const data = await service.clearAll(req.user.sub);
  success(res, data, 'All notifications cleared');
});

const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType, requirePermission } = require('../../middlewares/auth');
const controller = require('./admins.controller');
const notificationsController = require('../notifications/admin-notifications.controller');
const {
  listQuerySchema,
  idParam,
  createSchema,
  updateSchema,
  setCitiesSchema,
  resetPasswordSchema,
  changeOwnPasswordSchema,
} = require('./admins.validator');

const router = express.Router();

/// All routes in this module require an authenticated ADMIN. The
/// SUPER-only gate kicks in below, AFTER the self-service routes —
/// every admin (SUPER and CITY_MANAGER alike) must be able to
/// rotate their own password.
router.use(authenticate, requireType('ADMIN'));

/// Self-service password rotation. The id is read from `req.user.sub`
/// (the JWT subject) inside the controller; the body carries the
/// current password (verified server-side) and the new password.
router.post(
  '/me/change-password',
  validate(changeOwnPasswordSchema),
  controller.changeOwnPassword,
);

/// Admin notifications — bell-icon feed in the admin panel Topbar.
/// All routes are self-service (caller's adminId comes from the JWT,
/// never the URL/body), so SUPER and CITY_MANAGER both reach them.
router.get('/me/notifications', notificationsController.list);
router.patch('/me/notifications/read-all', notificationsController.markAllRead);
router.delete('/me/notifications', notificationsController.clearAll);
router.patch('/me/notifications/:id/read', notificationsController.markRead);
router.delete('/me/notifications/:id', notificationsController.remove);

/// Every endpoint below manages admin accounts — gated by the `admins.*`
/// RBAC permissions. The built-in Super Admin role carries the bypass
/// flag, and a legacy CITY_MANAGER token is denied access-control perms,
/// so this preserves the previous SUPER-only behaviour while letting a
/// custom role be granted these capabilities explicitly.
router.get('/', requirePermission('admins.view'), validate(listQuerySchema), controller.list);
router.post('/', requirePermission('admins.create'), validate(createSchema), controller.create);
router.get('/:id', requirePermission('admins.view'), validate(idParam), controller.get);
router.patch('/:id', requirePermission('admins.edit'), validate(updateSchema), controller.update);
router.delete('/:id', requirePermission('admins.delete'), validate(idParam), controller.remove);
router.put('/:id/cities', requirePermission('admins.edit'), validate(setCitiesSchema), controller.setCities);
router.post('/:id/reset-password', requirePermission('admins.edit'), validate(resetPasswordSchema), controller.resetPassword);

module.exports = router;

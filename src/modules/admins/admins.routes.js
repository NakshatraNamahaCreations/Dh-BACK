const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
const { requireRole } = require('../../middlewares/adminScope');
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

/// Every endpoint below is SUPER-only — a CITY_MANAGER must not be
/// able to create more admins or alter someone else's city scope.
router.use(requireRole('SUPER'));

router.get('/', validate(listQuerySchema), controller.list);
router.post('/', validate(createSchema), controller.create);
router.get('/:id', validate(idParam), controller.get);
router.patch('/:id', validate(updateSchema), controller.update);
router.put('/:id/cities', validate(setCitiesSchema), controller.setCities);
router.post('/:id/reset-password', validate(resetPasswordSchema), controller.resetPassword);

module.exports = router;

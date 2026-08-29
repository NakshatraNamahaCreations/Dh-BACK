const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType, requirePermission } = require('../../middlewares/auth');
const {
  idParam,
  listCitiesQuerySchema,
  createStateSchema,
  updateStateSchema,
  createCitySchema,
  updateCitySchema,
  placesSearchQuerySchema,
  placeDetailsQuerySchema,
} = require('./geography.validator');
const controller = require('./geography.controller');

const router = express.Router();

const adminOnly = [authenticate, requireType('ADMIN')];

// ── Public ─────────────────────────────────────────────────────────────────
// Customer-app + partner-app dropdown source. Returns active cities
// inside active states only — no auth required.
router.get('/cities/active', controller.listActiveCities);

// ── Admin ──────────────────────────────────────────────────────────────────
// Google Places proxy for the Create-job address search — the browser
// can't hit Google's REST endpoints directly (CORS), so the key lives
// server-side and these two endpoints relay.
router.get('/places/search', adminOnly, validate(placesSearchQuerySchema), controller.searchPlaces);
router.get('/places/details', adminOnly, validate(placeDetailsQuerySchema), controller.placeDetails);

router.get('/states', adminOnly, requirePermission('geography.view'), controller.listStates);
router.post('/states', adminOnly, requirePermission('geography.create'), validate(createStateSchema), controller.createState);
router.patch('/states/:id', adminOnly, requirePermission('geography.edit'), validate(updateStateSchema), controller.updateState);
router.delete('/states/:id', adminOnly, requirePermission('geography.delete'), validate(idParam), controller.deleteState);

router.get('/cities', adminOnly, requirePermission('geography.view'), validate(listCitiesQuerySchema), controller.listCities);
router.post('/cities', adminOnly, requirePermission('geography.create'), validate(createCitySchema), controller.createCity);
router.patch('/cities/:id', adminOnly, requirePermission('geography.edit'), validate(updateCitySchema), controller.updateCity);
router.delete('/cities/:id', adminOnly, requirePermission('geography.delete'), validate(idParam), controller.deleteCity);

module.exports = router;

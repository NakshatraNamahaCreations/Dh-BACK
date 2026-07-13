const asyncHandler = require('../../utils/asyncHandler');
const { success, created } = require('../../utils/apiResponse');
const service = require('./geography.service');

// ── States ────────────────────────────────────────────────────────────────

exports.listStates = asyncHandler(async (_req, res) => {
  const data = await service.listAllStates();
  success(res, data, 'States fetched');
});

exports.createState = asyncHandler(async (req, res) => {
  const item = await service.createState(req.body);
  created(res, item, 'State created');
});

exports.updateState = asyncHandler(async (req, res) => {
  const item = await service.updateState(req.params.id, req.body);
  success(res, item, 'State updated');
});

exports.deleteState = asyncHandler(async (req, res) => {
  const result = await service.deleteState(req.params.id);
  success(res, result, 'State deleted');
});

// ── Cities ────────────────────────────────────────────────────────────────

exports.listCities = asyncHandler(async (req, res) => {
  const data = await service.listAllCities(req.query);
  success(res, data, 'Cities fetched');
});

exports.listActiveCities = asyncHandler(async (_req, res) => {
  const data = await service.listActiveCities();
  success(res, data, 'Cities fetched');
});

exports.createCity = asyncHandler(async (req, res) => {
  const item = await service.createCity(req.body);
  created(res, item, 'City created');
});

exports.updateCity = asyncHandler(async (req, res) => {
  const item = await service.updateCity(req.params.id, req.body);
  success(res, item, 'City updated');
});

exports.deleteCity = asyncHandler(async (req, res) => {
  const result = await service.deleteCity(req.params.id);
  success(res, result, 'City deleted');
});

// ── Google Places proxy (admin Create-job address search) ──────────────────

exports.searchPlaces = asyncHandler(async (req, res) => {
  const data = await service.searchPlaces(req.query.q);
  success(res, data, 'Places fetched');
});

exports.placeDetails = asyncHandler(async (req, res) => {
  const data = await service.placeDetails(req.query.placeId);
  success(res, data, 'Place details fetched');
});

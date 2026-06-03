const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const service = require('./tracking.service');

exports.postLocation = asyncHandler(async (req, res) => {
  const data = await service.postLocation({
    partnerId: req.user.sub,
    lat: req.body.lat,
    lng: req.body.lng,
    accuracy: req.body.accuracy,
  });
  success(res, data, 'Location updated');
});

exports.setDuty = asyncHandler(async (req, res) => {
  const data = await service.setDuty({
    partnerId: req.user.sub,
    onDuty: req.body.onDuty,
    lat: req.body.lat,
    lng: req.body.lng,
  });
  success(res, data, data.onDuty ? 'You are now on duty' : 'You are now off duty');
});

exports.getForBooking = asyncHandler(async (req, res) => {
  const data = await service.getForBooking({
    customerId: req.user.sub,
    bookingId: req.params.id,
  });
  success(res, data, 'Tracking fetched');
});

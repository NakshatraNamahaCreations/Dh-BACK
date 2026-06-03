const { z } = require('zod');

const bookingIdParam = z.object({
  params: z.object({
    id: z.coerce.number().int().positive('Invalid booking id'),
  }),
});

const locationBody = z.object({
  body: z.object({
    /// Indian latitude/longitude can be checked tighter (8.0–37.0,
    /// 68.0–98.0) but we keep the full range so partners using a VPN
    /// or in border districts aren't rejected. The dispatch radius
    /// check on the booking side already enforces "must be near
    /// the customer."
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    /// Optional client-side accuracy in metres — useful for diagnostics
    /// and for the customer-app to drop a confidence circle around the
    /// marker, but not load-bearing for routing.
    accuracy: z.number().min(0).max(100000).optional(),
  }),
});

/// Explicit duty toggle from the partner app — `onDuty:true` to start
/// receiving offers, `false` to stop. Optional lat/lng so the server can
/// register the partner into the dispatch geo set at their current
/// position the instant they go on duty (so they're matchable even
/// before/without a live presence ping — important on OEMs that freeze
/// the JS thread when the app is backgrounded).
const dutyBody = z.object({
  body: z.object({
    onDuty: z.boolean(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  }),
});

module.exports = { bookingIdParam, locationBody, dutyBody };

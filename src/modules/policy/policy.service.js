// In-memory policy storage. Move to a Settings table when ready.

let cancellationPolicy = {
  freeWindowMins: 5,
  customerTiers: [
    { fromMins: 5, feePercent: 25 },
    { fromMins: 15, feePercent: 50 },
    { fromMins: 30, feePercent: 100 },
  ],
  partnerPenalty: 200,
  partnerStrikeLimit: 3,
};

let refundPolicy = {
  autoApproveBelow: 500,
  manualReviewAbove: 2000,
  processingDaysBank: 5,
  processingDaysWallet: 1,
  partialRefundEnabled: true,
  reasonRequired: true,
};

exports.getCancellation = async () => cancellationPolicy;
exports.saveCancellation = async (policy) => {
  cancellationPolicy = { ...policy };
  return cancellationPolicy;
};

exports.getRefund = async () => refundPolicy;
exports.saveRefund = async (policy) => {
  refundPolicy = { ...policy };
  return refundPolicy;
};

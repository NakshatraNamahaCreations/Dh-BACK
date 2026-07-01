const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');

/**
 * Payouts — settlements grouped from N pending earnings.
 *
 * Lifecycle:
 *   admin generates a payout for a partner (covering all their
 *   `pending` earnings up to a cutoff)
 *   → status: pending
 *   → admin approves (audit timestamp + admin id)
 *   → status: approved
 *   → admin records a bank reference and marks paid
 *   → status: paid; included earnings flip to `status: paid` with
 *     a `paidAt` timestamp and a `payoutId` back-pointer
 *
 * `reject` resets the bundled earnings back to `pending` so the next
 * payout cycle picks them up again. We don't lose any state — the
 * rejected payout row stays in history with an admin-supplied note.
 */

const payoutShape = (p) => ({
  id: p.id,
  partnerId: p.partnerId,
  partner: p.partner
    ? p.partner.name ?? p.partner.businessName ?? `Partner ${p.partnerId}`
    : undefined,
  partnerPhone: p.partner?.phone,
  /// Location for the admin's State→City filter UI. Resolves from the
  /// partner's home city (the Geography row); falls back to null when
  /// the partner row pre-dates the cityId backfill.
  city: p.partner?.cityRef?.name ?? p.partner?.city ?? null,
  state: p.partner?.cityRef?.state?.name ?? null,
  stateCode: p.partner?.cityRef?.state?.code ?? null,
  amount: p.amount,
  earningsCount: p.earningsCount,
  status: p.status,
  periodStart: p.periodStart,
  periodEnd: p.periodEnd,
  approvedBy: p.approvedBy,
  approvedAt: p.approvedAt,
  paidAt: p.paidAt,
  reference: p.reference,
  notes: p.notes,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

/// Generate a payout from every `pending` earning belonging to the
/// partner. Atomic in a transaction so a half-applied state can't
/// leave earnings re-rolled into two payouts. No-op (returns null)
/// when the partner has nothing to settle.
exports.generateForPartner = async ({ partnerId, notes = null }) => {
  return prisma.$transaction(async (tx) => {
    const earnings = await tx.partnerEarning.findMany({
      where: { partnerId: Number(partnerId), status: 'pending', payoutId: null },
      orderBy: { createdAt: 'asc' },
    });
    if (earnings.length === 0) {
      throw ApiError.badRequest('No pending earnings to settle for this partner');
    }

    /// Pending debits (cancellation penalties, etc.) net against the
    /// earnings sum so the payout reflects what the partner is actually
    /// owed. They're attached to this payout and flipped to `applied`;
    /// rejecting the payout releases them back to `pending` for the next
    /// cycle. `amount` can go negative when penalties exceed earnings —
    /// that's intentional (the partner carries a debit), and the admin
    /// sees it on the payout row rather than the penalty silently
    /// vanishing.
    const adjustments = await tx.partnerAdjustment.findMany({
      where: { partnerId: Number(partnerId), status: 'pending', payoutId: null },
      orderBy: { createdAt: 'asc' },
    });

    // Use netAmount (partner's actual credited amount after 5% GST) when the
    // row has been computed with the new breakdown; fall back to earnedAmount
    // for legacy rows created before the breakdown columns were added.
    const earningsTotal = earnings.reduce(
      (s, e) => s + (e.netAmount > 0 ? e.netAmount : e.earnedAmount),
      0,
    );
    const adjustmentsTotal = adjustments.reduce((s, a) => s + a.amount, 0);
    const amount = earningsTotal - adjustmentsTotal;
    const periodStart = earnings[0].createdAt;
    const periodEnd = earnings[earnings.length - 1].createdAt;
    const payoutNotes =
      adjustmentsTotal > 0
        ? [notes, `Includes −₹${adjustmentsTotal} in cancellation penalties (${adjustments.length}).`]
            .filter(Boolean)
            .join(' ')
        : notes;

    const payout = await tx.payout.create({
      data: {
        partnerId: Number(partnerId),
        amount,
        earningsCount: earnings.length,
        periodStart,
        periodEnd,
        notes: payoutNotes,
      },
    });

    await tx.partnerEarning.updateMany({
      where: { id: { in: earnings.map((e) => e.id) } },
      data: { payoutId: payout.id },
    });
    if (adjustments.length > 0) {
      await tx.partnerAdjustment.updateMany({
        where: { id: { in: adjustments.map((a) => a.id) } },
        data: { payoutId: payout.id, status: 'applied' },
      });
    }

    return tx.payout.findUnique({
      where: { id: payout.id },
      include: { partner: { select: { name: true, businessName: true, phone: true, city: true, cityRef: { select: { name: true, state: { select: { name: true, code: true } } } } } } },
    });
  }).then(payoutShape);
};

exports.approve = async ({ payoutId, adminId, notes = null }) => {
  const id = Number(payoutId);
  return prisma.$transaction(async (tx) => {
    const p = await tx.payout.findUnique({ where: { id } });
    if (!p) throw ApiError.notFound('Payout not found');
    if (p.status !== 'pending') {
      throw ApiError.conflict(`Cannot approve a payout in status "${p.status}"`);
    }
    return tx.payout.update({
      where: { id },
      data: {
        status: 'approved',
        approvedBy: adminId ?? null,
        approvedAt: new Date(),
        notes: notes ?? p.notes,
      },
      include: { partner: { select: { name: true, businessName: true, phone: true, city: true, cityRef: { select: { name: true, state: { select: { name: true, code: true } } } } } } },
    });
  }).then(payoutShape);
};

/// Mark paid — moves payout to `paid` and propagates `paid` status
/// onto every bundled earning, copying the same paidAt timestamp.
/// Reference is required (UPI txn id, bank ref, etc.) so a paid
/// payout always has a verifiable disbursement record.
exports.markPaid = async ({ payoutId, reference, notes = null }) => {
  if (!reference || String(reference).trim().length === 0) {
    throw ApiError.badRequest('Bank/UPI reference is required to mark a payout paid');
  }
  const id = Number(payoutId);
  const paidAt = new Date();
  return prisma.$transaction(async (tx) => {
    const p = await tx.payout.findUnique({ where: { id } });
    if (!p) throw ApiError.notFound('Payout not found');
    if (p.status === 'paid') throw ApiError.conflict('Payout already marked paid');
    if (p.status === 'rejected') {
      throw ApiError.conflict('Cannot mark paid — payout was rejected');
    }

    const updated = await tx.payout.update({
      where: { id },
      data: {
        status: 'paid',
        paidAt,
        reference: String(reference).trim(),
        notes: notes ?? p.notes,
      },
      include: { partner: { select: { name: true, businessName: true, phone: true, city: true, cityRef: { select: { name: true, state: { select: { name: true, code: true } } } } } } },
    });

    /// Cascade `paid` onto bundled earnings so the partner's pending
    /// total drops the moment the payout settles.
    await tx.partnerEarning.updateMany({
      where: { payoutId: id },
      data: { status: 'paid', paidAt },
    });

    return updated;
  }).then(payoutShape);
};

exports.reject = async ({ payoutId, notes }) => {
  if (!notes || String(notes).trim().length === 0) {
    throw ApiError.badRequest('A note explaining the rejection is required');
  }
  const id = Number(payoutId);
  return prisma.$transaction(async (tx) => {
    const p = await tx.payout.findUnique({ where: { id } });
    if (!p) throw ApiError.notFound('Payout not found');
    if (p.status === 'paid') {
      throw ApiError.conflict('Cannot reject a payout that was already paid');
    }
    /// Release the earnings back to the pending pool — they'll be
    /// available for the next payout cycle. We DON'T delete the
    /// payout row; admins keep it as an audit record.
    await tx.partnerEarning.updateMany({
      where: { payoutId: id },
      data: { payoutId: null },
    });
    /// Same for any netted adjustments — back to `pending` so the next
    /// payout re-deducts them.
    await tx.partnerAdjustment.updateMany({
      where: { payoutId: id },
      data: { payoutId: null, status: 'pending' },
    });
    return tx.payout.update({
      where: { id },
      data: { status: 'rejected', notes: String(notes).trim() },
      include: { partner: { select: { name: true, businessName: true, phone: true, city: true, cityRef: { select: { name: true, state: { select: { name: true, code: true } } } } } } },
    });
  }).then(payoutShape);
};

/// Read APIs ---------------------------------------------------------

exports.list = async ({ status, search, partnerId, scope, page = 1, pageSize = 25 } = {}) => {
  const where = {};
  if (status && status !== 'all') where.status = status;
  if (partnerId) where.partnerId = Number(partnerId);
  if (search) {
    const s = String(search).trim();
    where.partner = {
      ...(where.partner ?? {}),
      OR: [
        { name: { contains: s, mode: 'insensitive' } },
        { phone: { contains: s, mode: 'insensitive' } },
        { businessName: { contains: s, mode: 'insensitive' } },
      ],
    };
  }
  /// Geography filter — payouts are scoped to the partner's home city
  /// (not the cities they work in). Merges into any existing
  /// `where.partner` so the search filter above still applies.
  if (scope && scope.cityIds != null) {
    const cityFilter =
      scope.cityIds.length === 0
        ? -1
        : scope.cityIds.length === 1
          ? scope.cityIds[0]
          : { in: scope.cityIds };
    where.partner = { ...(where.partner ?? {}), cityId: cityFilter };
  }

  const [items, total] = await Promise.all([
    prisma.payout.findMany({
      where,
      include: { partner: { select: { name: true, businessName: true, phone: true, city: true, cityRef: { select: { name: true, state: { select: { name: true, code: true } } } } } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.payout.count({ where }),
  ]);

  return {
    data: items.map(payoutShape),
    meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
};

exports.get = async (id) => {
  const p = await prisma.payout.findUnique({
    where: { id: Number(id) },
    include: {
      partner: { select: { name: true, businessName: true, phone: true } },
      earnings: {
        include: {
          booking: {
            select: { id: true, total: true, scheduledAt: true, slotLabel: true, jobCompletedAt: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!p) throw ApiError.notFound('Payout not found');
  return {
    ...payoutShape(p),
    earnings: p.earnings.map((e) => ({
      id: e.id,
      bookingId: e.bookingId,
      bookingAmount: e.bookingAmount,
      commissionPct: e.commissionPct,
      earnedAmount: e.earnedAmount,
      breakdown: {
        dhoondCommission: e.dhoondCommission ?? 0,
        dhoondGst:        e.dhoondGst        ?? 0,
        dhoondNet:        e.dhoondNet        ?? 0,
        partnerGst:       e.partnerGst       ?? 0,
        netAmount:        e.netAmount        ?? 0,
      },
      status: e.status,
      booking: e.booking,
    })),
  };
};

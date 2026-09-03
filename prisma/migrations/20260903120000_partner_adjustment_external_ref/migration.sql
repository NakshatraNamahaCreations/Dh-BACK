-- Adds an external payment reference to partner_adjustments.
--
-- Needed for the partner-app "clear your outstanding balance" flow: a
-- partner who owes more in cancellation penalties than they have earned
-- is blocked from going on duty, and settles it by paying through
-- Razorpay. That payment is recorded as a NEGATIVE `balance_settlement`
-- adjustment which offsets the penalties.
--
-- The unique index is the point of this migration. Razorpay's verify
-- callback can be retried by the client, replayed by an attacker, or
-- arrive twice alongside the webhook. Without a uniqueness guarantee on
-- the payment id, each replay would insert another credit and silently
-- wipe penalties the partner never actually paid for. With it, the
-- second insert fails and the handler treats it as already-settled.
--
-- Nullable because admin/system rows (ordinary cancellation penalties)
-- have no external payment. Postgres permits unlimited NULLs in a
-- unique index, so those rows are unaffected.
ALTER TABLE "partner_adjustments" ADD COLUMN "externalRef" TEXT;

CREATE UNIQUE INDEX "partner_adjustments_externalRef_key"
  ON "partner_adjustments"("externalRef");

-- Nkwa Pay (MoMo/Orange Money) + XAF currency migration

-- Instructor payout number (MoMo/Orange) for Nkwa disbursements
ALTER TABLE "instructor_profiles" ADD COLUMN "payoutPhone" TEXT;

-- Nkwa collection id + payer phone on payments
ALTER TABLE "payments" ADD COLUMN "nkwaPaymentId" TEXT;
ALTER TABLE "payments" ADD COLUMN "phoneNumber" TEXT;
CREATE UNIQUE INDEX "payments_nkwaPaymentId_key" ON "payments"("nkwaPaymentId");

-- Platform currency defaults: USD -> XAF (zero-decimal)
ALTER TABLE "courses"          ALTER COLUMN "currency" SET DEFAULT 'XAF';
ALTER TABLE "enrollments"      ALTER COLUMN "currency" SET DEFAULT 'XAF';
ALTER TABLE "session_requests" ALTER COLUMN "currency" SET DEFAULT 'XAF';
ALTER TABLE "live_sessions"    ALTER COLUMN "currency" SET DEFAULT 'XAF';
ALTER TABLE "payments"         ALTER COLUMN "currency" SET DEFAULT 'XAF';
ALTER TABLE "payouts"          ALTER COLUMN "currency" SET DEFAULT 'XAF';

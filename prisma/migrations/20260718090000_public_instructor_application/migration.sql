-- Apply-first instructor onboarding: the user account is created only when an
-- admin approves the application, so unapproved applicants never occupy a user
-- row in the database.

-- userId becomes optional (null until approval creates the account)
ALTER TABLE "instructor_applications" ALTER COLUMN "userId" DROP NOT NULL;

-- Applicant details captured up front for public (pre-account) applications
ALTER TABLE "instructor_applications" ADD COLUMN "email" TEXT;
ALTER TABLE "instructor_applications" ADD COLUMN "firstName" TEXT;
ALTER TABLE "instructor_applications" ADD COLUMN "lastName" TEXT;
ALTER TABLE "instructor_applications" ADD COLUMN "passwordHash" TEXT;

-- Lookups by applicant email
CREATE INDEX "instructor_applications_email_idx" ON "instructor_applications"("email");

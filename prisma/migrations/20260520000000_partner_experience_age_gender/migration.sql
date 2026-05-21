-- AlterTable: capture self-reported experience, age and gender from the
-- partner-onboarding "Complete your info" form. Previously the form
-- collected these three fields client-side but only sent name + category
-- + city in the PATCH, so the values were dropped on submit. All three
-- are nullable so existing partners (who never saw these prompts) keep
-- their rows valid.
ALTER TABLE "partners"
  ADD COLUMN IF NOT EXISTS "experience" TEXT,
  ADD COLUMN IF NOT EXISTS "age"        INTEGER,
  ADD COLUMN IF NOT EXISTS "gender"     TEXT;

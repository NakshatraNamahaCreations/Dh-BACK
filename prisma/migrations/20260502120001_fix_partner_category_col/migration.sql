-- Fix column name: drop wrong snake_case column, add correct camelCase column
ALTER TABLE "partners" DROP COLUMN IF EXISTS "category_id";
ALTER TABLE "partners" ADD COLUMN "categoryId" INTEGER;

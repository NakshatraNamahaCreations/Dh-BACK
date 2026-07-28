-- Admin-managed display order for services within a category / sub-category.
ALTER TABLE "services" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Fast ordered reads of a category / sub-category's services.
CREATE INDEX "services_categoryId_sortOrder_idx" ON "services"("categoryId", "sortOrder");
CREATE INDEX "services_subCategoryId_sortOrder_idx" ON "services"("subCategoryId", "sortOrder");

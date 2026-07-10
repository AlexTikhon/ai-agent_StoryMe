-- AlterTable
ALTER TABLE "books" ADD COLUMN     "character_profile" JSONB,
ADD COLUMN     "character_sheet_asset_key" TEXT,
ADD COLUMN     "child_photo_asset_key" TEXT,
ADD COLUMN     "child_photo_content_type" TEXT;

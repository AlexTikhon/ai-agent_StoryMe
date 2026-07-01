-- CreateEnum
CREATE TYPE "BookLanguage" AS ENUM ('en', 'ru', 'pl');

-- AlterTable
ALTER TABLE "books" ADD COLUMN     "child_age" INTEGER,
ADD COLUMN     "child_name" TEXT,
ADD COLUMN     "language" "BookLanguage",
ADD COLUMN     "theme" TEXT,
ALTER COLUMN "request" DROP NOT NULL;

/*
  Warnings:

  - You are about to drop the column `lease_attempt` on the `generation_runs` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "generation_runs" DROP COLUMN "lease_attempt",
ADD COLUMN     "delivery_token" TEXT;

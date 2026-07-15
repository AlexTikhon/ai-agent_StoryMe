-- AlterTable
ALTER TABLE "recovery_leases" ADD COLUMN     "lease_generation" INTEGER NOT NULL DEFAULT 0;

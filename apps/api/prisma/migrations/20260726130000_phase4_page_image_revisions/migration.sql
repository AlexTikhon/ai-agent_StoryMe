ALTER TYPE "CreditReason" ADD VALUE 'refund_page_regeneration_failure';

CREATE TYPE "PageImageRevisionStatus" AS ENUM (
  'quoted',
  'queued',
  'running',
  'completed',
  'failed'
);

ALTER TABLE "books"
ADD COLUMN "active_page_image_revision_id" UUID;

CREATE TABLE "page_image_revisions" (
  "id" UUID NOT NULL,
  "book_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "page_number" INTEGER NOT NULL,
  "expected_page_version" INTEGER NOT NULL,
  "status" "PageImageRevisionStatus" NOT NULL DEFAULT 'quoted',
  "cost_credits" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "estimated_cost_usd" DECIMAL(10, 6),
  "quote_expires_at" TIMESTAMP(3) NOT NULL,
  "source_book_updated_at" TIMESTAMP(3) NOT NULL,
  "source_published_run_id" UUID,
  "source_published_run_fencing_version" INTEGER,
  "source_published_pdf_run_id" UUID,
  "source_published_pdf_fencing_version" INTEGER,
  "fencing_version" INTEGER NOT NULL DEFAULT 0,
  "delivery_token" TEXT,
  "error_code" TEXT,
  "error_message" TEXT,
  "confirmed_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "page_image_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "page_image_revisions_cost_positive_chk" CHECK ("cost_credits" > 0),
  CONSTRAINT "page_image_revisions_page_positive_chk" CHECK ("page_number" > 0),
  CONSTRAINT "page_image_revisions_expected_version_positive_chk"
    CHECK ("expected_page_version" > 0),
  CONSTRAINT "page_image_revisions_fencing_nonnegative_chk" CHECK ("fencing_version" >= 0),
  CONSTRAINT "page_image_revisions_book_fkey"
    FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "page_image_revisions_user_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "page_image_revisions_book_id_created_at_idx"
ON "page_image_revisions"("book_id", "created_at" DESC);

CREATE INDEX "page_image_revisions_user_id_created_at_idx"
ON "page_image_revisions"("user_id", "created_at" DESC);

CREATE INDEX "page_image_revisions_status_created_at_idx"
ON "page_image_revisions"("status", "created_at");

CREATE UNIQUE INDEX "page_image_revisions_one_active_per_book"
ON "page_image_revisions"("book_id")
WHERE "status" IN ('queued', 'running');

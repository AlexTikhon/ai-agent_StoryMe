ALTER TABLE "books"
ADD COLUMN "published_pdf_run_id" UUID,
ADD COLUMN "published_pdf_fencing_version" INTEGER;

ALTER TABLE "book_pages"
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "books"
ADD CONSTRAINT "books_published_pdf_pointer_pair_chk"
CHECK (
  ("published_pdf_run_id" IS NULL AND "published_pdf_fencing_version" IS NULL)
  OR
  ("published_pdf_run_id" IS NOT NULL AND "published_pdf_fencing_version" IS NOT NULL)
);

ALTER TABLE "books"
ADD CONSTRAINT "books_published_pdf_fencing_version_positive_chk"
CHECK (
  "published_pdf_fencing_version" IS NULL
  OR "published_pdf_fencing_version" > 0
);

ALTER TABLE "book_pages"
ADD CONSTRAINT "book_pages_version_positive_chk"
CHECK ("version" > 0);

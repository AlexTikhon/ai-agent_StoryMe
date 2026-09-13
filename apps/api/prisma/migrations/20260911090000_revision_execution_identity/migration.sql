-- Existing paid quotes lack a confirmed execution identity and require a new quote.
-- No publication, charge, or historical operation is rewritten.
ALTER TABLE "page_image_revisions" ADD COLUMN "execution_fingerprint" TEXT;

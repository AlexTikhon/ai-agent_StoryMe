-- Home Edition page-image regeneration is explicitly confirmed but does not
-- debit credits. Preserve the non-negative invariant while allowing its
-- server-owned zero-credit quote.
ALTER TABLE "page_image_revisions"
DROP CONSTRAINT "page_image_revisions_cost_positive_chk";

ALTER TABLE "page_image_revisions"
ADD CONSTRAINT "page_image_revisions_cost_nonnegative_chk"
CHECK ("cost_credits" >= 0);

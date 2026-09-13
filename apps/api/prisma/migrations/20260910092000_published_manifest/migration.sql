-- Legacy publications stay readable and get a validated manifest on next publication.
ALTER TABLE "books" ADD COLUMN "published_artifact_manifest" JSONB;

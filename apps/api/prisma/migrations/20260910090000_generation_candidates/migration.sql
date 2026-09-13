-- Additive: published content and pointers are left intact.
ALTER TABLE "books" ADD COLUMN "generation_checkpoint" JSONB;
-- Legacy candidates retain their exact namespace; assets still require runtime validation.
UPDATE "books" SET "generation_checkpoint" = jsonb_build_object(
  'version', 1, 'legacy', true, 'inputHash', last_generation_input_hash,
  'compatibilityFingerprint', last_generation_compatibility_fingerprint,
  'runId', last_generation_run_id, 'fencingVersion', last_generation_fencing_version,
  'content', jsonb_build_object('characterCard', character_card, 'characterProfile', character_profile,
    'characterSheetAssetKey', character_sheet_asset_key, 'storyPlan', story_plan,
    'bookPreview', book_preview, 'imageGenerationResult', image_generation_result, 'bookLayout', book_layout))
WHERE last_generation_input_hash IS NOT NULL;

ALTER TABLE "generation_runs" ADD COLUMN "execution_authorization" JSONB, ADD COLUMN "provider_operations" JSONB;

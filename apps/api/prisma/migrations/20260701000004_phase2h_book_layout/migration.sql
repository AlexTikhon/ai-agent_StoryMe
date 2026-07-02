-- Phase 2H: add book_layout JSON column for deterministic layout engine output
ALTER TABLE "books" ADD COLUMN "book_layout" JSONB;

-- The 50 MB ceiling and the MIME allowlist move into version control.
--
-- `20260719092113` created the `documents` bucket with `file_size_limit` and
-- `allowed_mime_types` NULL, reasoning that the bucket should inherit the project-wide cap
-- config.toml sets to 50MiB. That reasoning only holds locally: config.toml configures the
-- LOCAL stack, and on the hosted project the global cap is a dashboard setting — mutable,
-- unversioned, and invisible to review. This update makes the bucket's own row the ceiling,
-- so the limit survives a dashboard change and is diffable like everything else.
--
-- The numbers restate the application's own boundary, not a new one:
--   - 50 MiB = MAX_DOCUMENT_BYTES (packages/core/src/documents/limits.ts, 50 * 1024 * 1024),
--     the limit `validateDocument` enforces in the browser and in the validate step.
--   - The MIME list is DOCUMENT_MIME_TYPES (packages/core/src/documents/validate.ts): the
--     pipeline reads PDF and PPTX, nothing else.
--
-- Storage enforces this at upload time, BEFORE the pipeline's own validate step — a
-- defence-in-depth layer for the one path the app's validator cannot see: a direct TUS/API
-- upload to the bucket that never went through the upload dialog. The app's validator stays
-- authoritative for messages; this is the backstop that keeps a bypassed dialog from parking
-- a 2 GB video in the bucket.
--
-- ⚠ Storage trusts the DECLARED Content-Type against allowed_mime_types — it does not sniff
-- bytes. The byte-level verdict stays with `validateDocument`, which reads the stored bytes.
--
-- Safe to apply as written: an UPDATE of one storage.buckets row; existing objects are not
-- revalidated, and every stored object already passed the same 50 MB check in the app.

update storage.buckets
set
  file_size_limit = 52428800, -- 50 MiB, byte-identical to MAX_DOCUMENT_BYTES
  allowed_mime_types = array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ]
where id = 'documents';

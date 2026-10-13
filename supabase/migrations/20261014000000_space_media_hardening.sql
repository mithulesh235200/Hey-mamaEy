-- Space media bucket hardening (layer 2 of the upload-security fix).
--
-- WHAT THIS DOES
-- Replaces the wide-open "any anon can upload anything" policy with a
-- restricted INSERT policy:
--   1. Single-level paths only:  <space-code>/<random-id>-<filename>
--      (space codes are alphanumeric + dash; no nested folders, no traversal)
--   2. Extension whitelist (images, video, audio, documents — NO html/svg/js/
--      executables, and double-extension tricks like photo.jpg.exe are rejected
--      because the FINAL extension must be whitelisted AND no segment may be
--      a known-dangerous type... see note below)
--   3. MIME whitelist on the stored object metadata (the app now uploads with
--      canonical MIME types — see src/lib/fileValidation.ts)
--
-- WHAT THIS DOES NOT DO
-- - Virus scanning: that needs a server-side scanner (Edge Function +
--   quarantine-bucket flow). Until then, treat uploads as untrusted.
-- - Double-extension segments (e.g. `x.html` inside `x.html.jpg`): Postgres
--   RLS string checks cover the final extension; the CLIENT validator
--   (fileValidation.ts) rejects dangerous middle segments. Keep both layers.
-- - Existing objects stay readable (SELECT policy unchanged) so current chats
--   keep working.
--
-- APPLY: run once in the Supabase SQL editor (or `supabase db push`).

-- 1) Replace the permissive INSERT policy -------------------------------
DROP POLICY IF EXISTS "Anon can upload space media" ON storage.objects;

CREATE POLICY "Restricted space media uploads"
  ON storage.objects FOR INSERT TO anon, authenticated
  WITH CHECK (
    bucket_id = 'space-media'
    -- single-level path: <space-code>/<file> (no nesting, no traversal)
    AND name ~ '^[0-9A-Za-z-]{1,64}/[^/]{1,100}$'
    -- final extension must be whitelisted
    AND lower(storage.extension(name)) IN (
      'jpg', 'jpeg', 'png', 'gif', 'webp',
      'mp4', 'webm',
      'mp3', 'wav', 'ogg', 'oga', 'm4a',
      'pdf', 'txt', 'md', 'csv',
      'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip'
    )
    -- stored MIME must be one the app actually uploads (canonical types)
    AND (metadata ->> 'mimetype') IN (
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/webm',
      'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave',
      'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/x-m4a', 'audio/aac',
      'application/mp4',
      'application/pdf',
      'text/plain', 'text/markdown', 'text/x-markdown', 'text/csv',
      'application/csv',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/zip', 'application/x-zip-compressed'
    )
  );

-- 2) Keep public reads (existing chats must keep loading) ----------------
-- NOTE: long-term, prefer a PRIVATE bucket + short-lived signed URLs so
-- uploads aren't directly hot-linkable. That requires app changes
-- (sign-on-read) and is intentionally NOT done here to avoid breaking
-- current clients.
DROP POLICY IF EXISTS "Anyone can read space media" ON storage.objects;
CREATE POLICY "Anyone can read space media"
  ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'space-media');

-- 3) No UPDATE / DELETE for anonymous clients ----------------------------
-- (No policies exist for those operations, so they stay denied by default.
-- Municipal cleanup/retention continues via service-role functions.)

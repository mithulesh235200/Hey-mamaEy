-- Space media attachments via Supabase Storage (replaces base64 data_url blobs).
-- Run this once in the Supabase SQL editor, then media uploads use public URLs.
-- Until applied, the app keeps working via its base64 fallback.

INSERT INTO storage.buckets (id, name, public)
VALUES ('space-media', 'space-media', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "Anon can upload space media" ON storage.objects;
CREATE POLICY "Anon can upload space media"
  ON storage.objects FOR INSERT TO anon, authenticated
  WITH CHECK (bucket_id = 'space-media');

DROP POLICY IF EXISTS "Anyone can read space media" ON storage.objects;
CREATE POLICY "Anyone can read space media"
  ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'space-media');

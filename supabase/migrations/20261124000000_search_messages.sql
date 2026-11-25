-- Global search: find messages across every Space the caller belongs to,
-- from the home-screen search box (WhatsApp-style).
--
-- Privacy guarantees:
--   * SECURITY DEFINER + explicit membership filter — a caller only ever sees
--     hits from spaces they belong to (space_members row, space owner, or
--     their own messages in legacy ownerless spaces). Same trust model as
--     get_space_messages.
--   * E2E-encrypted payloads (the __enc1__. prefix) are skipped server-side:
--     ciphertext is not matchable without the room password, and matching it
--     would leak nothing useful anyway. Encrypted rooms stay searchable
--     client-side through their decrypted in-memory copies.
--   * Input needs no LIKE escaping — matching uses strpos(lower()), so
--     user text containing % or _ can never alter the pattern.
--
-- Run once (SQL editor or query API). Client failures are non-fatal until
-- applied: the app falls back to in-memory results.

CREATE OR REPLACE FUNCTION public.search_messages(
  p_query text,
  p_user_id text,
  p_limit integer DEFAULT 50
)
RETURNS SETOF public.messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_q text := lower(coalesce(p_query, ''));
BEGIN
  IF length(trim(v_q)) < 2 OR p_user_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT m.*
    FROM public.messages m
    JOIN public.spaces s ON s.id = m.space_id
    WHERE m.text IS NOT NULL
      AND left(m.text, 9) <> '__enc1__.'
      AND strpos(lower(m.text), trim(v_q)) > 0
      AND (
        EXISTS (
          SELECT 1 FROM public.space_members sm
          WHERE sm.space_id = m.space_id AND sm.user_id = p_user_id
        )
        OR s.owner_id = p_user_id
        OR m.author_id = p_user_id
      )
    ORDER BY m.created_at DESC
    LIMIT LEAST(GREATEST(coalesce(p_limit, 50), 1), 100);
END;
$$;

REVOKE ALL ON FUNCTION public.search_messages(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_messages(text, text, integer) TO anon, authenticated;

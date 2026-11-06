-- Older-history pagination: fetch the page of messages created BEFORE a cursor.
-- The regular read RPCs only return the latest 100 rows, so this is the
-- "scroll up to load earlier messages" endpoint. Same access gate + grants as
-- get_space_messages / get_space_messages_since.

CREATE FUNCTION public.get_space_messages_before(
  p_code text,
  p_before timestamptz,
  p_password_hash text DEFAULT NULL,
  p_user_id text DEFAULT NULL
)
RETURNS SETOF public.messages
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT s.id INTO v_id
    FROM public.get_space_by_code(p_code, p_password_hash, p_user_id, false) s;
  IF v_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT older.*
  FROM (
    SELECT m.*
    FROM public.messages m
    WHERE m.space_id = v_id
      AND m.created_at < coalesce(p_before, NOW())
      AND m.created_at >= NOW() - INTERVAL '7 days'
    ORDER BY m.created_at DESC
    LIMIT 100
  ) AS older
  ORDER BY older.created_at ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_space_messages_before(text, timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_messages_before(text, timestamptz, text, text)
  TO anon, authenticated;

-- Reduce reads and provide explicit Space cleanup.
-- Deleting a Space cascades to messages through messages_space_id_fkey.

CREATE OR REPLACE FUNCTION public.get_space_messages(p_code text)
RETURNS SETOF public.messages
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT recent.*
  FROM (
    SELECT m.*
    FROM public.messages m
    JOIN public.spaces s ON s.id = m.space_id
    WHERE s.code = btrim(p_code)
    ORDER BY m.created_at DESC
    LIMIT 200
  ) recent
  ORDER BY recent.created_at ASC;
$$;

CREATE OR REPLACE FUNCTION public.delete_space(p_code text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted boolean;
BEGIN
  DELETE FROM public.spaces
  WHERE code = btrim(p_code)
  RETURNING true INTO v_deleted;

  IF NOT coalesce(v_deleted, false) THEN
    RAISE EXCEPTION 'Space not found';
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_space(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_space(text) TO anon, authenticated;

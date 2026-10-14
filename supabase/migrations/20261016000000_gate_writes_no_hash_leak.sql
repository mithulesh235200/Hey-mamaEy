-- Password-gate write RPCs + stop leaking password_hash via get_user_spaces.
-- All new params have DEFAULT NULL so old 2/3/4-arg calls keep working;
-- old overloads are dropped first so PostgREST never sees PGRST203.

-- ---------- edit / delete / read-receipt gate ----------
DROP FUNCTION IF EXISTS public.edit_space_message(text, uuid, text, text);
DROP FUNCTION IF EXISTS public.delete_space_message(text, uuid, text);
DROP FUNCTION IF EXISTS public.mark_space_messages_read(text, text);

CREATE FUNCTION public.edit_space_message(
  p_code text,
  p_message_id uuid,
  p_author_id text,
  p_text text,
  p_password_hash text DEFAULT NULL
)
RETURNS public.messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_message public.messages;
BEGIN
  IF btrim(coalesce(p_text, '')) = '' THEN
    RAISE EXCEPTION 'Message text cannot be empty';
  END IF;
  IF length(p_text) > 20000 THEN
    RAISE EXCEPTION 'Message text is too long';
  END IF;
  -- Password gate: raises SPACE_PASSWORD_REQUIRED / SPACE_PASSWORD_INVALID
  -- for protected rooms, returns 0 rows when the space is gone/expired.
  SELECT s.id INTO v_id FROM public.get_space_by_code(p_code, p_password_hash) s;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Space not found';
  END IF;

  UPDATE public.messages m
  SET text = p_text
  WHERE m.id = p_message_id
    AND m.space_id = v_id
    AND m.author_id = left(coalesce(nullif(btrim(p_author_id), ''), 'ANON'), 64)
    AND m.kind = 'text'
  RETURNING m.* INTO v_message;

  IF v_message.id IS NULL THEN
    RAISE EXCEPTION 'Message not found or not owned by this identity';
  END IF;
  RETURN v_message;
END;
$$;

CREATE FUNCTION public.delete_space_message(
  p_code text,
  p_message_id uuid,
  p_author_id text,
  p_password_hash text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_deleted boolean;
BEGIN
  SELECT s.id INTO v_id FROM public.get_space_by_code(p_code, p_password_hash) s;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Space not found';
  END IF;
  DELETE FROM public.messages m
  WHERE m.id = p_message_id
    AND m.space_id = v_id
    AND m.author_id = left(coalesce(nullif(btrim(p_author_id), ''), 'ANON'), 64)
  RETURNING true INTO v_deleted;

  IF NOT coalesce(v_deleted, false) THEN
    RAISE EXCEPTION 'Message not found or not owned by this identity';
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION public.mark_space_messages_read(
  p_code text,
  p_reader_id text,
  p_password_hash text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_updated integer;
  v_reader_id text := left(btrim(coalesce(p_reader_id, '')), 64);
BEGIN
  IF v_reader_id = '' THEN
    RETURN 0;
  END IF;
  SELECT s.id INTO v_id FROM public.get_space_by_code(p_code, p_password_hash) s;
  IF v_id IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.messages AS m
  SET read_at = NOW()
  WHERE m.space_id = v_id
    AND m.author_id <> v_reader_id
    AND m.read_at IS NULL
    AND m.created_at >= NOW() - INTERVAL '7 days';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.edit_space_message(text, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.edit_space_message(text, uuid, text, text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_space_message(text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_space_message(text, uuid, text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_space_messages_read(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_space_messages_read(text, text, text) TO anon, authenticated;

-- ---------- get_user_spaces: explicit columns, no password_hash, skip expired ----------
DROP FUNCTION IF EXISTS public.get_user_spaces(text);

CREATE FUNCTION public.get_user_spaces(p_user_id text)
RETURNS TABLE (
  id uuid,
  name text,
  code text,
  created_at timestamptz,
  owner_id text,
  has_password boolean,
  last_activity_at timestamptz,
  expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT s.id, s.name, s.code, s.created_at, s.owner_id,
    (s.password_hash IS NOT NULL), s.last_activity_at, s.expires_at
  FROM public.spaces s
  LEFT JOIN public.messages m ON m.space_id = s.id
  WHERE (s.expires_at IS NULL OR s.expires_at > now())
    AND ((s.owner_id IS NOT NULL AND s.owner_id = btrim(p_user_id))
      OR (m.author_id IS NOT NULL AND m.author_id = btrim(p_user_id)));
$$;

REVOKE ALL ON FUNCTION public.get_user_spaces(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_spaces(text) TO anon, authenticated;

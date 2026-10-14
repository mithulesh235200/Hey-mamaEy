-- Room access control: host lock, read-only mode, kick/ban by user ID.
-- Additive + backward compatible: every new param has a DEFAULT so old
-- 2/3-arg calls keep working. Old overloads are dropped first (PostgREST PGRST203).

ALTER TABLE public.spaces
  ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_readonly BOOLEAN NOT NULL DEFAULT false;

-- Users kicked by the host. Knowing the code never re-admits a banned ID.
CREATE TABLE IF NOT EXISTS public.space_bans (
  space_id UUID NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
  banned_user_id TEXT NOT NULL,
  banned_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, banned_user_id)
);

ALTER TABLE public.space_bans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.space_bans FROM anon, authenticated;
GRANT ALL ON public.space_bans TO service_role;

-- ---------- gate: code lookup now also enforces bans + join-time locks ----------
DROP FUNCTION IF EXISTS public.get_space_by_code(text, text);

CREATE FUNCTION public.get_space_by_code(
  p_code text,
  p_password_hash text DEFAULT NULL,
  p_user_id text DEFAULT NULL,
  p_check_join boolean DEFAULT false
)
RETURNS TABLE (
  id uuid,
  name text,
  code text,
  created_at timestamptz,
  owner_id text,
  has_password boolean,
  is_locked boolean,
  is_readonly boolean,
  last_activity_at timestamptz,
  expires_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.spaces%ROWTYPE;
  v_uid text := left(btrim(coalesce(p_user_id, '')), 64);
BEGIN
  SELECT * INTO v_row FROM public.spaces s WHERE s.code = btrim(p_code);
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_row.expires_at IS NOT NULL AND v_row.expires_at <= now() THEN
    RETURN;
  END IF;
  IF v_row.password_hash IS NOT NULL THEN
    IF nullif(btrim(coalesce(p_password_hash, '')), '') IS NULL THEN
      RAISE EXCEPTION 'SPACE_PASSWORD_REQUIRED';
    ELSIF v_row.password_hash <> btrim(p_password_hash) THEN
      RAISE EXCEPTION 'SPACE_PASSWORD_INVALID';
    END IF;
  END IF;
  -- Kicked users stay out even with the right code + password.
  IF v_uid <> '' AND EXISTS (
    SELECT 1 FROM public.space_bans b
    WHERE b.space_id = v_row.id AND b.banned_user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'SPACE_USER_BANNED';
  END IF;
  -- Locked rooms admit only the owner + existing members (checked at join time;
  -- normal reads/writes pass p_check_join=false so members are never locked out).
  IF coalesce(p_check_join, false) AND v_row.is_locked THEN
    IF v_uid = '' OR (v_uid <> v_row.owner_id AND NOT EXISTS (
      SELECT 1 FROM public.space_members m
      WHERE m.space_id = v_row.id AND m.user_id = v_uid
    )) THEN
      RAISE EXCEPTION 'SPACE_LOCKED';
    END IF;
  END IF;
  RETURN QUERY SELECT v_row.id, v_row.name, v_row.code, v_row.created_at,
    v_row.owner_id, (v_row.password_hash IS NOT NULL),
    v_row.is_locked, v_row.is_readonly,
    v_row.last_activity_at, v_row.expires_at;
END;
$$;

-- ---------- reads: thread the caller id through for ban enforcement ----------
DROP FUNCTION IF EXISTS public.get_space_messages(text, text);

CREATE FUNCTION public.get_space_messages(
  p_code text,
  p_password_hash text DEFAULT NULL,
  p_user_id text DEFAULT NULL
)
RETURNS SETOF public.messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public.prune_expired_chat_data();
  SELECT s.id INTO v_id FROM public.get_space_by_code(p_code, p_password_hash, p_user_id, false) s;
  IF v_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT recent.*
  FROM (
    SELECT m.*
    FROM public.messages m
    WHERE m.space_id = v_id
      AND m.created_at >= NOW() - INTERVAL '7 days'
    ORDER BY m.created_at DESC
    LIMIT 100
  ) AS recent
  ORDER BY recent.created_at ASC;
END;
$$;

DROP FUNCTION IF EXISTS public.get_space_messages_since(text, timestamptz, text);

CREATE FUNCTION public.get_space_messages_since(
  p_code text,
  p_after timestamptz,
  p_password_hash text DEFAULT NULL,
  p_user_id text DEFAULT NULL
)
RETURNS SETOF public.messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public.prune_expired_chat_data();
  SELECT s.id INTO v_id FROM public.get_space_by_code(p_code, p_password_hash, p_user_id, false) s;
  IF v_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT m.*
  FROM public.messages m
  WHERE m.space_id = v_id
    AND m.created_at >= coalesce(p_after, NOW() - INTERVAL '7 days')
    AND m.created_at >= NOW() - INTERVAL '7 days'
  ORDER BY m.created_at ASC
  LIMIT 100;
END;
$$;

-- ---------- sends: banned IDs rejected, read-only rooms are owner-write-only ----------
CREATE OR REPLACE FUNCTION public.send_space_message(
  p_code text,
  p_author_id text,
  p_author_name text,
  p_kind text,
  p_text text DEFAULT NULL,
  p_data_url text DEFAULT NULL,
  p_file_name text DEFAULT NULL,
  p_file_size bigint DEFAULT NULL,
  p_mime_type text DEFAULT NULL,
  p_forwarded boolean DEFAULT false,
  p_password_hash text DEFAULT NULL
)
RETURNS public.messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_row public.messages;
  v_author_id text := left(coalesce(nullif(btrim(coalesce(p_author_id, '')), ''), 'ANON'), 64);
  v_kind text := btrim(coalesce(p_kind, ''));
  v_owner text;
  v_readonly boolean;
BEGIN
  IF v_kind NOT IN ('text', 'image', 'video', 'audio', 'file') THEN
    RAISE EXCEPTION 'Invalid message kind';
  END IF;
  IF coalesce(char_length(coalesce(p_text, '')), 0) > 20000 THEN
    RAISE EXCEPTION 'Message text too long';
  END IF;
  IF p_data_url IS NOT NULL AND char_length(p_data_url) > 18000000 THEN
    RAISE EXCEPTION 'Attachment too large';
  END IF;
  IF p_file_size IS NOT NULL AND p_file_size > 20000000 THEN
    RAISE EXCEPTION 'File too large';
  END IF;
  -- Ban enforced inside the gate via p_author_id; raises SPACE_USER_BANNED.
  SELECT s.id INTO v_id FROM public.get_space_by_code(p_code, p_password_hash, p_author_id, false) s;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Space not found';
  END IF;
  SELECT s.owner_id, s.is_readonly INTO v_owner, v_readonly
  FROM public.spaces s WHERE s.id = v_id;
  IF coalesce(v_readonly, false) AND v_author_id <> v_owner THEN
    RAISE EXCEPTION 'SPACE_READ_ONLY';
  END IF;
  INSERT INTO public.messages (space_id, author_id, author_name, kind, text, data_url, file_name, file_size, mime_type, forwarded)
  VALUES (v_id, v_author_id, left(coalesce(nullif(btrim(p_author_name), ''), 'Anonymous'), 40),
    v_kind, p_text, p_data_url, p_file_name, p_file_size, p_mime_type, coalesce(p_forwarded, false))
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- ---------- joins: locked rooms + banned IDs rejected at membership time ----------
CREATE OR REPLACE FUNCTION public.register_space_member(p_code text, p_user_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_space public.spaces%ROWTYPE;
  v_uid text := left(btrim(coalesce(p_user_id, '')), 64);
BEGIN
  IF v_uid = '' THEN
    RAISE EXCEPTION 'A user id is required';
  END IF;
  SELECT * INTO v_space FROM public.spaces WHERE code = btrim(p_code);
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.space_bans b
    WHERE b.space_id = v_space.id AND b.banned_user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'SPACE_USER_BANNED';
  END IF;
  IF v_space.is_locked
    AND v_uid <> v_space.owner_id
    AND NOT EXISTS (
      SELECT 1 FROM public.space_members m
      WHERE m.space_id = v_space.id AND m.user_id = v_uid
    ) THEN
    RAISE EXCEPTION 'SPACE_LOCKED';
  END IF;
  INSERT INTO public.space_members (space_id, user_id)
  VALUES (v_space.id, v_uid)
  ON CONFLICT (space_id, user_id) DO NOTHING;
  RETURN true;
END;
$$;

-- ---------- host controls (owner-gated, same model as set_space_password) ----------
CREATE OR REPLACE FUNCTION public.set_space_lock(
  p_code text,
  p_owner_id text,
  p_locked boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.spaces
  SET is_locked = coalesce(p_locked, false)
  WHERE code = btrim(p_code)
    AND owner_id = left(btrim(coalesce(p_owner_id, '')), 64);
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_space_readonly(
  p_code text,
  p_owner_id text,
  p_readonly boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.spaces
  SET is_readonly = coalesce(p_readonly, false)
  WHERE code = btrim(p_code)
    AND owner_id = left(btrim(coalesce(p_owner_id, '')), 64);
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.kick_space_user(
  p_code text,
  p_owner_id text,
  p_target_user_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_space_id uuid;
  v_target text := left(btrim(coalesce(p_target_user_id, '')), 64);
BEGIN
  IF v_target = '' THEN
    RAISE EXCEPTION 'A user id is required';
  END IF;
  SELECT id INTO v_space_id FROM public.spaces
  WHERE code = btrim(p_code)
    AND owner_id = left(btrim(coalesce(p_owner_id, '')), 64);
  IF v_space_id IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO public.space_bans (space_id, banned_user_id, banned_by)
  VALUES (v_space_id, v_target, left(btrim(coalesce(p_owner_id, '')), 64))
  ON CONFLICT (space_id, banned_user_id) DO NOTHING;
  DELETE FROM public.space_members m
  WHERE m.space_id = v_space_id AND m.user_id = v_target;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.unban_space_user(
  p_code text,
  p_owner_id text,
  p_target_user_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_space_id uuid;
BEGIN
  SELECT id INTO v_space_id FROM public.spaces
  WHERE code = btrim(p_code)
    AND owner_id = left(btrim(coalesce(p_owner_id, '')), 64);
  IF v_space_id IS NULL THEN
    RETURN false;
  END IF;
  DELETE FROM public.space_bans b
  WHERE b.space_id = v_space_id
    AND b.banned_user_id = left(btrim(coalesce(p_target_user_id, '')), 64);
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_space_bans(p_code text, p_owner_id text)
RETURNS TABLE (banned_user_id text, banned_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_space_id uuid;
BEGIN
  SELECT id INTO v_space_id FROM public.spaces
  WHERE code = btrim(p_code)
    AND owner_id = left(btrim(coalesce(p_owner_id, '')), 64);
  IF v_space_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT b.banned_user_id, b.created_at
  FROM public.space_bans b
  WHERE b.space_id = v_space_id
  ORDER BY b.created_at DESC;
END;
$$;

-- ---------- get_user_spaces: same columns as the gate, still no password_hash ----------
DROP FUNCTION IF EXISTS public.get_user_spaces(text);

CREATE FUNCTION public.get_user_spaces(p_user_id text)
RETURNS TABLE (
  id uuid,
  name text,
  code text,
  created_at timestamptz,
  owner_id text,
  has_password boolean,
  is_locked boolean,
  is_readonly boolean,
  last_activity_at timestamptz,
  expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT s.id, s.name, s.code, s.created_at, s.owner_id,
    (s.password_hash IS NOT NULL), s.is_locked, s.is_readonly,
    s.last_activity_at, s.expires_at
  FROM public.spaces s
  LEFT JOIN public.messages m ON m.space_id = s.id
  WHERE (s.expires_at IS NULL OR s.expires_at > now())
    AND ((s.owner_id IS NOT NULL AND s.owner_id = btrim(p_user_id))
      OR (m.author_id IS NOT NULL AND m.author_id = btrim(p_user_id)));
$$;

REVOKE ALL ON FUNCTION public.get_space_by_code(text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_by_code(text, text, text, boolean) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_space_messages(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_messages(text, text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_space_messages_since(text, timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_messages_since(text, timestamptz, text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.send_space_message(text, text, text, text, text, text, text, bigint, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_space_message(text, text, text, text, text, text, text, bigint, text, boolean, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.register_space_member(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_space_member(text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.set_space_lock(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_space_lock(text, text, boolean) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.set_space_readonly(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_space_readonly(text, text, boolean) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.kick_space_user(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kick_space_user(text, text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.unban_space_user(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unban_space_user(text, text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_space_bans(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_bans(text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_user_spaces(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_spaces(text) TO anon, authenticated;

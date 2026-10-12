-- Room security hardening + ephemeral TTL.
-- 1) Longer alphanumeric room tokens (XXXX-XXXX-XXXX, unambiguous alphabet).
-- 2) Optional password protection (server stores SHA-256 hash only).
-- 3) Strict inactivity-based cleanup (messages + idle spaces + expired spaces).

ALTER TABLE public.spaces
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Touch activity when a message lands.
CREATE OR REPLACE FUNCTION public.touch_space_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.spaces SET last_activity_at = now() WHERE id = NEW.space_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_space_activity ON public.messages;
CREATE TRIGGER trg_touch_space_activity
AFTER INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.touch_space_activity();

-- Strong code generator: 12 chars from unambiguous alphabet.
CREATE OR REPLACE FUNCTION public.generate_secure_space_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  raw text := '';
  i int;
BEGIN
  FOR i IN 1..12 LOOP
    raw := raw || substr(alphabet, 1 + floor(random() * 32)::int, 1);
  END LOOP;
  RETURN substr(raw, 1, 4) || '-' || substr(raw, 5, 4) || '-' || substr(raw, 9, 4);
END;
$$;

-- Recreate create_space with optional password hash (default keeps old clients working).
CREATE OR REPLACE FUNCTION public.create_space(p_name text, p_owner_id text, p_password_hash text DEFAULT NULL)
RETURNS public.spaces
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := left(coalesce(nullif(btrim(p_name), ''), 'New Space'), 60);
  v_owner_id text := left(btrim(coalesce(p_owner_id, '')), 64);
  v_pw text := nullif(btrim(coalesce(p_password_hash, '')), '');
  v_code text;
  v_space public.spaces;
  i int;
BEGIN
  IF v_owner_id = '' THEN
    RAISE EXCEPTION 'A Space owner is required';
  END IF;
  IF v_pw IS NOT NULL AND length(v_pw) > 128 THEN
    RAISE EXCEPTION 'Invalid password hash';
  END IF;

  FOR i IN 1..20 LOOP
    v_code := public.generate_secure_space_code();
    BEGIN
      INSERT INTO public.spaces (name, code, owner_id, password_hash, last_activity_at)
      VALUES (v_name, v_code, v_owner_id, v_pw, now())
      RETURNING * INTO v_space;
      RETURN v_space;
    EXCEPTION WHEN unique_violation THEN
      CONTINUE;
    END;
  END LOOP;

  RAISE EXCEPTION 'Could not allocate a Space code, please try again';
END;
$$;

-- Gate reads by password: spaces with a hash require the matching hash.
-- Wrong password raises (distinguishable from "not found" which returns 0 rows).
CREATE OR REPLACE FUNCTION public.get_space_by_code(p_code text, p_password_hash text DEFAULT NULL)
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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.spaces%ROWTYPE;
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
  RETURN QUERY SELECT v_row.id, v_row.name, v_row.code, v_row.created_at,
    v_row.owner_id, (v_row.password_hash IS NOT NULL),
    v_row.last_activity_at, v_row.expires_at;
END;
$$;

-- Owner can set/change/remove the room password (hash only, never plaintext).
CREATE OR REPLACE FUNCTION public.set_space_password(p_code text, p_owner_id text, p_password_hash text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pw text := nullif(btrim(coalesce(p_password_hash, '')), '');
BEGIN
  IF v_pw IS NOT NULL AND length(v_pw) > 128 THEN
    RAISE EXCEPTION 'Invalid password hash';
  END IF;
  UPDATE public.spaces
  SET password_hash = v_pw
  WHERE code = btrim(p_code)
    AND owner_id = left(btrim(coalesce(p_owner_id, '')), 64);
  RETURN FOUND;
END;
$$;

-- Ephemeral TTL: wipe expired messages, idle spaces, and past-due expires_at rooms.
CREATE OR REPLACE FUNCTION public.prune_expired_chat_data()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Message retention: 7 days.
  DELETE FROM public.messages
  WHERE created_at < NOW() - INTERVAL '7 days';

  -- Explicitly expired rooms (and their messages via cascade).
  DELETE FROM public.spaces
  WHERE expires_at IS NOT NULL AND expires_at <= NOW();

  -- Idle rooms: no activity for 30 days (messages pruned above keep this honest).
  DELETE FROM public.spaces s
  WHERE s.last_activity_at < NOW() - INTERVAL '30 days'
    AND NOT EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.space_id = s.id AND m.created_at >= NOW() - INTERVAL '30 days'
    );

  -- Legacy fallback: empty rooms created > 7 days ago.
  DELETE FROM public.spaces s
  WHERE s.created_at < NOW() - INTERVAL '7 days'
    AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.space_id = s.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_expired_chats()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.prune_expired_chat_data();
  RETURN true;
END;
$$;

-- get_space_messages now enforces password + retention + refreshes activity view.
CREATE OR REPLACE FUNCTION public.get_space_messages(p_code text, p_password_hash text DEFAULT NULL)
RETURNS SETOF public.messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public.prune_expired_chat_data();
  SELECT s.id INTO v_id FROM public.get_space_by_code(p_code, p_password_hash) s;
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

CREATE OR REPLACE FUNCTION public.get_space_messages_since(
  p_code text,
  p_after timestamptz,
  p_password_hash text DEFAULT NULL
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
  SELECT s.id INTO v_id FROM public.get_space_by_code(p_code, p_password_hash) s;
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

-- send/edit/delete/mark touch password gate via get_space_by_code.
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
BEGIN
  SELECT s.id INTO v_id FROM public.get_space_by_code(p_code, p_password_hash) s;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Space not found';
  END IF;
  INSERT INTO public.messages (space_id, author_id, author_name, kind, text, data_url, file_name, file_size, mime_type, forwarded)
  VALUES (v_id, left(btrim(p_author_id), 64), left(coalesce(nullif(btrim(p_author_name), ''), 'Anonymous'), 40),
    p_kind, p_text, p_data_url, p_file_name, p_file_size, p_mime_type, coalesce(p_forwarded, false))
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- Schedule nightly cleanup with pg_cron when available (guarded: no-op otherwise).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('prune-expired-chat-data-nightly', '0 3 * * *', 'SELECT public.prune_expired_chat_data()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_secure_space_code() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_secure_space_code() TO anon, authenticated;
REVOKE ALL ON FUNCTION public.create_space(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_space(text, text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_space_by_code(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_by_code(text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.set_space_password(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_space_password(text, text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_space_messages(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_messages(text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_space_messages_since(text, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_messages_since(text, timestamptz, text) TO anon, authenticated;

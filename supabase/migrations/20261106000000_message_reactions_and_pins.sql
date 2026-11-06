-- Server-backed message reactions + per-Space pinned message.
-- Until now both lived in React component state / localStorage only: they were
-- lost on reload and never visible to other members. This migration makes them
-- first-class server data, following the existing RPC patterns
-- (SECURITY DEFINER + get_space_by_code access gate, grants to anon/authenticated).

-- ---------- reactions ----------
CREATE TABLE IF NOT EXISTS public.message_reactions (
  message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

-- No direct table access for clients: every read/write goes through the
-- SECURITY DEFINER RPCs below (same posture as space_bans).
ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.message_reactions FROM anon, authenticated;
GRANT ALL ON public.message_reactions TO service_role;

CREATE INDEX IF NOT EXISTS message_reactions_message_id_idx
  ON public.message_reactions (message_id);

-- ---------- pinned message (one per Space, last pin wins) ----------
ALTER TABLE public.spaces
  ADD COLUMN IF NOT EXISTS pinned_message_id UUID
    REFERENCES public.messages(id) ON DELETE SET NULL;

-- ---------- read: all reactions for a Space in one call ----------
CREATE FUNCTION public.get_space_reactions(
  p_code text,
  p_password_hash text DEFAULT NULL,
  p_user_id text DEFAULT NULL
)
RETURNS TABLE (
  message_id uuid,
  emoji text,
  user_id text
)
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
  SELECT r.message_id, r.emoji, r.user_id
    FROM public.message_reactions r
    JOIN public.messages m ON m.id = r.message_id
   WHERE m.space_id = v_id
     AND m.created_at >= NOW() - INTERVAL '7 days';
END;
$$;

REVOKE ALL ON FUNCTION public.get_space_reactions(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_reactions(text, text, text) TO anon, authenticated;

-- ---------- write: toggle one user's reaction on one message ----------
-- Returns true when the reaction is now present, false when it was removed.
CREATE FUNCTION public.toggle_space_message_reaction(
  p_code text,
  p_message_id uuid,
  p_emoji text,
  p_user_id text DEFAULT NULL,
  p_password_hash text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_uid text := left(btrim(coalesce(p_user_id, '')), 64);
  v_emoji text := left(btrim(coalesce(p_emoji, '')), 16);
  v_space uuid;
BEGIN
  IF v_uid = '' THEN
    RAISE EXCEPTION 'REACTION_USER_REQUIRED';
  END IF;
  IF v_emoji = '' THEN
    RAISE EXCEPTION 'REACTION_EMOJI_REQUIRED';
  END IF;
  SELECT s.id INTO v_id
    FROM public.get_space_by_code(p_code, p_password_hash, v_uid, false) s;
  IF v_id IS NULL THEN
    RETURN false;
  END IF;
  -- The message must live in the Space the caller named.
  SELECT m.space_id INTO v_space FROM public.messages m WHERE m.id = p_message_id;
  IF v_space IS NULL OR v_space <> v_id THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.message_reactions r
     WHERE r.message_id = p_message_id AND r.user_id = v_uid AND r.emoji = v_emoji
  ) THEN
    DELETE FROM public.message_reactions r
     WHERE r.message_id = p_message_id AND r.user_id = v_uid AND r.emoji = v_emoji;
    RETURN false;
  END IF;
  INSERT INTO public.message_reactions (message_id, user_id, emoji)
  VALUES (p_message_id, v_uid, v_emoji)
  ON CONFLICT DO NOTHING;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.toggle_space_message_reaction(text, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.toggle_space_message_reaction(text, uuid, text, text, text)
  TO anon, authenticated;

-- ---------- write: pin / unpin a message for the whole Space ----------
-- p_message_id = NULL unpins. Any non-banned member may pin (no owner ticket),
-- matching how members can already edit/delete their own content.
CREATE FUNCTION public.pin_space_message(
  p_code text,
  p_message_id uuid DEFAULT NULL,
  p_user_id text DEFAULT NULL,
  p_password_hash text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_uid text := left(btrim(coalesce(p_user_id, '')), 64);
  v_space uuid;
BEGIN
  SELECT s.id INTO v_id
    FROM public.get_space_by_code(p_code, p_password_hash, v_uid, false) s;
  IF v_id IS NULL THEN
    RETURN false;
  END IF;
  IF p_message_id IS NULL THEN
    UPDATE public.spaces SET pinned_message_id = NULL WHERE id = v_id;
    RETURN true;
  END IF;
  SELECT m.space_id INTO v_space FROM public.messages m WHERE m.id = p_message_id;
  IF v_space IS NULL OR v_space <> v_id THEN
    RETURN false;
  END IF;
  UPDATE public.spaces SET pinned_message_id = p_message_id WHERE id = v_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.pin_space_message(text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pin_space_message(text, uuid, text, text) TO anon, authenticated;

-- ---------- expose the pin on the space lookup ----------
-- Signature/args unchanged (PostgREST resolves by name+args), only one output
-- column is appended; internal callers use `SELECT s.id ... s`, which is safe.
DROP FUNCTION IF EXISTS public.get_space_by_code(text, text, text, boolean);

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
  expires_at timestamptz,
  pinned_message_id uuid
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
    v_row.last_activity_at, v_row.expires_at, v_row.pinned_message_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_space_by_code(text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_by_code(text, text, text, boolean) TO anon, authenticated;

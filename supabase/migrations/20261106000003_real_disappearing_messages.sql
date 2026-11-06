-- Real disappearing messages ("Auto-destruct").
-- Until now the per-space timer only wrote to localStorage: nothing on the
-- server ever deleted or hid a message because of it. This migration makes it
-- a first-class, server-backed Space setting:
--
--   1. spaces.retention ('off' | '24h' | '7d' | '30d') — synced to every
--      member through get_space_by_code.
--   2. prune_expired_chat_data() (nightly pg_cron at 03:00) deletes per-space
--      instead of one flat global 7 days. 'off' keeps the existing 7-day
--      default; '30d' lets a room keep history for up to 30 days.
--   3. set_space_retention() lets any member of the room change the policy
--      (rate-limited; goes through the same get_space_by_code access gate as
--      reads, so password/ban/lock rules apply).
--
-- Read windows are widened from 7 to 30 days (the maximum retention) — still
-- capped at 100 rows per page either way. Exact per-space expiry is enforced
-- by the nightly prune and mirrored client-side (filterRetained in
-- heymama.ts), so the UI hides a message the moment it crosses its boundary.

-- ---------- 1. the column ----------
ALTER TABLE public.spaces
  ADD COLUMN IF NOT EXISTS retention text
    NOT NULL DEFAULT 'off'
    CHECK (retention IN ('off', '24h', '7d', '30d'));

-- ---------- 2. expose it on the space lookup ----------
-- Same pattern as pinned_message_id (20261106000000): one output column
-- appended; every internal caller reads named columns (`SELECT s.id ... s`),
-- so the extra column is safe.
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
  pinned_message_id uuid,
  retention text
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
    v_row.last_activity_at, v_row.expires_at, v_row.pinned_message_id,
    v_row.retention;
END;
$$;

REVOKE ALL ON FUNCTION public.get_space_by_code(text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_by_code(text, text, text, boolean)
  TO anon, authenticated;

-- ---------- 3. per-space prune ----------
-- Replaces the flat "delete everything older than 7 days" rule. The nightly
-- pg_cron job (scheduled in 20261013000000) picks this up automatically.
CREATE OR REPLACE FUNCTION public.prune_expired_chat_data()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Per-space message retention (spaces.retention): 'off' = global 7-day default.
  DELETE FROM public.messages m
  USING public.spaces s
  WHERE m.space_id = s.id
    AND m.created_at < NOW() - CASE s.retention
      WHEN '24h' THEN INTERVAL '24 hours'
      WHEN '7d'  THEN INTERVAL '7 days'
      WHEN '30d' THEN INTERVAL '30 days'
      ELSE INTERVAL '7 days'
    END;

  -- Orphaned messages (space row already gone) keep the flat 7-day cap.
  DELETE FROM public.messages m
  WHERE m.space_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.spaces s WHERE s.id = m.space_id)
    AND m.created_at < NOW() - INTERVAL '7 days';

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

-- ---------- 4. the setter ----------
CREATE FUNCTION public.set_space_retention(
  p_code text,
  p_retention text,
  p_password_hash text DEFAULT NULL,
  p_user_id text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_val text := btrim(coalesce(p_retention, ''));
  v_uid text := left(coalesce(nullif(btrim(coalesce(p_user_id, '')), ''), 'ANON'), 64);
BEGIN
  IF v_val NOT IN ('off', '24h', '7d', '30d') THEN
    RAISE EXCEPTION 'Invalid retention value';
  END IF;
  SELECT s.id INTO v_id
    FROM public.get_space_by_code(p_code, p_password_hash, p_user_id, false) s;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Space not found';
  END IF;
  -- A rare, deliberate action — a modest budget is plenty.
  IF NOT public.bump_rate_limit('retention:' || v_id::text || ':' || v_uid, 10, 60) THEN
    RAISE EXCEPTION 'RATE_LIMITED';
  END IF;
  UPDATE public.spaces
    SET retention = v_val,
        last_activity_at = NOW()
    WHERE id = v_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.set_space_retention(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_space_retention(text, text, text, text)
  TO anon, authenticated;

-- ---------- 5. widen read windows to the maximum retention ----------
-- The read RPCs hard-filtered to 7 days, which would hide a 30-day room's own
-- history. 30 days is now the fetch window (LIMIT 100 keeps payloads bounded);
-- exact per-space expiry is enforced by prune + the client-side filter.
-- Signatures and grants are unchanged — only the interval constant moves.

DROP FUNCTION IF EXISTS public.get_space_messages(text, text, text);

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
      AND m.created_at >= NOW() - INTERVAL '30 days'
    ORDER BY m.created_at DESC
    LIMIT 100
  ) AS recent
  ORDER BY recent.created_at ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_space_messages(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_messages(text, text, text) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.get_space_messages_since(text, timestamptz, text, text);

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
  SELECT s.id INTO v_id FROM public.get_space_by_code(p_code, p_password_hash, p_user_id, false) s;
  IF v_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT m.*
  FROM public.messages m
  WHERE m.space_id = v_id
    AND m.created_at >= coalesce(p_after, NOW() - INTERVAL '30 days')
    AND m.created_at >= NOW() - INTERVAL '30 days'
  ORDER BY m.created_at ASC
  LIMIT 100;
END;
$$;

REVOKE ALL ON FUNCTION public.get_space_messages_since(text, timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_messages_since(text, timestamptz, text, text)
  TO anon, authenticated;

DROP FUNCTION IF EXISTS public.get_space_messages_before(text, timestamptz, text, text);

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
      AND m.created_at >= NOW() - INTERVAL '30 days'
    ORDER BY m.created_at DESC
    LIMIT 100
  ) AS older
  ORDER BY older.created_at ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_space_messages_before(text, timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_messages_before(text, timestamptz, text, text)
  TO anon, authenticated;

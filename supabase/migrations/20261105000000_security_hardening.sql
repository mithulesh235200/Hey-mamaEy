-- Security hardening pass (findings S1 / S2 / S4) + rate limits + read-path perf.
--
-- S1  Owner ops must be unforgeable. set_space_password, set_space_lock,
--     set_space_readonly, kick_space_user, unban_space_user and
--     delete_space_for_everyone only required a consumed admin ticket WHEN the
--     owner had a registered identity_keys row; otherwise a plain p_owner_id
--     text match sufficed, and owner IDs are copyable from any message's
--     author_id by any room member. A valid, consumed ticket is now ALWAYS
--     required. Argument lists and return types are unchanged, so the deployed
--     client keeps working (it already mints tickets via requestAdminTicket in
--     src/lib/identity.ts before every owner RPC).
--     NOTE: an owner WITHOUT a registered identity key cannot run admin ops
--     until their client registers one — registration happens automatically on
--     app start (ensureRegisteredIdentity in src/lib/heymama.ts).
--
-- S2  register_identity hardening: (a) p_reg_hash validated strictly — hex
--     only, then left(...,128); (b) per-user rate limit 5/hour (see rate
--     limiting below); (c) the first-claim-wins conflict error now carries the
--     original claim date so the UI can explain it. The IDENTITY_KEY_CONFLICT
--     token is kept as a prefix because the client matches on it with
--     String.includes (src/lib/identity.ts). No cryptographic key<->ID binding
--     attempted: it is impossible without exposing the secret server-side.
--
-- S4  Webhook authentication (edge functions, not SQL): supabase/functions/
--     scan-upload/index.ts and supabase/functions/push-on-message/index.ts now
--     fail closed with a 401 JSON body unless the x-webhook-secret request
--     header exactly equals the WEBHOOK_SECRET env var (empty/undefined env is
--     rejected too). The check runs before any service-role storage delete or
--     FCM call. Operator action required: `supabase secrets set
--     WEBHOOK_SECRET=...` and add the same value as an `x-webhook-secret`
--     header on both dashboard webhooks, otherwise both webhooks reject.
--
-- Rate limiting: new public.rate_limits table (RLS enabled, NO policies =>
--     anon/authenticated denied outright) + SECURITY DEFINER helper
--     bump_rate_limit(). Applied inside send_space_message (30 msgs / 60 s per
--     author per space), create_space (5 rooms / 300 s per owner) and
--     register_identity (5 / 3600 s per user). All three functions signal the
--     condition the way they already signal errors: RAISE EXCEPTION
--     'RATE_LIMITED'.
--
-- Performance: indexes on messages(created_at), messages(author_id),
--     space_members(user_id), spaces(owner_id), spaces(last_activity_at); the
--     prune_expired_chat_data() PERFORM calls are removed from the read RPCs
--     (pg_cron already schedules that prune — see the reads section) and client
--     EXECUTE on the prune functions is revoked (cron/owner still runs them).

-- ---------- rate limiting infrastructure ----------

CREATE TABLE IF NOT EXISTS public.rate_limits (
  key TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  count INT NOT NULL
);

-- RLS enabled with NO policies: anon/authenticated are denied outright even if
-- default privileges granted them table access. Only SECURITY DEFINER
-- functions (executing as the owner) touch this table.
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limits FROM anon, authenticated;
GRANT ALL ON public.rate_limits TO service_role;

DROP FUNCTION IF EXISTS public.bump_rate_limit(text, int, int);

CREATE FUNCTION public.bump_rate_limit(
  p_key text,
  p_limit int,
  p_window_seconds int
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text := left(btrim(coalesce(p_key, '')), 160);
  v_limit int := coalesce(p_limit, 0);
  v_window int := greatest(coalesce(p_window_seconds, 1), 1);
  v_count int;
BEGIN
  IF v_key = '' THEN
    RETURN false;
  END IF;
  -- Window expired -> reset to (now, 1); otherwise increment in place.
  INSERT INTO public.rate_limits AS rl (key, window_start, count)
  VALUES (v_key, now(), 1)
  ON CONFLICT (key) DO UPDATE
    SET window_start = CASE
          WHEN rl.window_start < now() - make_interval(secs => v_window) THEN now()
          ELSE rl.window_start
        END,
        count = CASE
          WHEN rl.window_start < now() - make_interval(secs => v_window) THEN 1
          ELSE rl.count + 1
        END
  RETURNING rl.count INTO v_count;
  RETURN v_count <= v_limit;
END;
$$;

-- Deliberately NOT granted to anon/authenticated: clients reach this helper
-- only through the RPCs below, and a public grant would let anyone call it
-- directly and burn a victim's budget (e.g. exhaust 'create:<victim>').
REVOKE ALL ON FUNCTION public.bump_rate_limit(text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bump_rate_limit(text, int, int) TO service_role;

-- ---------- S1: owner ops always require a consumed admin ticket ----------
-- Old check in every function below:
--   IF EXISTS (SELECT 1 FROM public.identity_keys k WHERE k.user_id = v_uid)
--     AND NOT public.consume_admin_ticket(...) THEN RAISE ...
-- i.e. a ticket was only required once the owner had registered an identity
-- key; otherwise any member could forge owner ops with a copied author_id.
-- The conditional is removed: a valid, consumed ticket is mandatory.
-- IMPORTANT: an owner without a registered identity key cannot run admin ops
-- until their client registers one — register_identity runs automatically on
-- app start, and the secure-room-admin edge function only mints tickets for
-- registered keys (returns NO_IDENTITY otherwise).

DROP FUNCTION IF EXISTS public.set_space_password(text, text, text, uuid);

CREATE FUNCTION public.set_space_password(
  p_code text,
  p_owner_id text,
  p_password_hash text DEFAULT NULL,
  p_ticket uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pw text := nullif(btrim(coalesce(p_password_hash, '')), '');
  v_uid text := left(btrim(coalesce(p_owner_id, '')), 64);
  v_space public.spaces%ROWTYPE;
BEGIN
  IF v_pw IS NOT NULL AND length(v_pw) > 128 THEN
    RAISE EXCEPTION 'Invalid password hash';
  END IF;
  SELECT * INTO v_space FROM public.spaces s WHERE s.code = btrim(p_code);
  IF NOT FOUND OR v_space.owner_id IS DISTINCT FROM v_uid THEN
    RETURN false;
  END IF;
  -- S1: always require a valid, consumed ticket (see section note).
  IF NOT public.consume_admin_ticket(p_ticket, p_code, v_uid, 'set_password') THEN
    RAISE EXCEPTION 'ADMIN_TICKET_REQUIRED';
  END IF;
  UPDATE public.spaces SET password_hash = v_pw
  WHERE id = v_space.id;
  RETURN FOUND;
END;
$$;

DROP FUNCTION IF EXISTS public.set_space_lock(text, text, boolean, uuid);

CREATE FUNCTION public.set_space_lock(
  p_code text,
  p_owner_id text,
  p_locked boolean DEFAULT false,
  p_ticket uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := left(btrim(coalesce(p_owner_id, '')), 64);
  v_space public.spaces%ROWTYPE;
BEGIN
  SELECT * INTO v_space FROM public.spaces s WHERE s.code = btrim(p_code);
  IF NOT FOUND OR v_space.owner_id IS DISTINCT FROM v_uid THEN
    RETURN false;
  END IF;
  -- S1: always require a valid, consumed ticket (see section note).
  IF NOT public.consume_admin_ticket(p_ticket, p_code, v_uid, 'set_lock') THEN
    RAISE EXCEPTION 'ADMIN_TICKET_REQUIRED';
  END IF;
  UPDATE public.spaces SET is_locked = coalesce(p_locked, false)
  WHERE id = v_space.id;
  RETURN FOUND;
END;
$$;

DROP FUNCTION IF EXISTS public.set_space_readonly(text, text, boolean, uuid);

CREATE FUNCTION public.set_space_readonly(
  p_code text,
  p_owner_id text,
  p_readonly boolean DEFAULT false,
  p_ticket uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := left(btrim(coalesce(p_owner_id, '')), 64);
  v_space public.spaces%ROWTYPE;
BEGIN
  SELECT * INTO v_space FROM public.spaces s WHERE s.code = btrim(p_code);
  IF NOT FOUND OR v_space.owner_id IS DISTINCT FROM v_uid THEN
    RETURN false;
  END IF;
  -- S1: always require a valid, consumed ticket (see section note).
  IF NOT public.consume_admin_ticket(p_ticket, p_code, v_uid, 'set_readonly') THEN
    RAISE EXCEPTION 'ADMIN_TICKET_REQUIRED';
  END IF;
  UPDATE public.spaces SET is_readonly = coalesce(p_readonly, false)
  WHERE id = v_space.id;
  RETURN FOUND;
END;
$$;

DROP FUNCTION IF EXISTS public.kick_space_user(text, text, text, uuid);

CREATE FUNCTION public.kick_space_user(
  p_code text,
  p_owner_id text,
  p_target_user_id text,
  p_ticket uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := left(btrim(coalesce(p_owner_id, '')), 64);
  v_target text := left(btrim(coalesce(p_target_user_id, '')), 64);
  v_space public.spaces%ROWTYPE;
BEGIN
  IF v_target = '' THEN
    RAISE EXCEPTION 'A user id is required';
  END IF;
  SELECT * INTO v_space FROM public.spaces s WHERE s.code = btrim(p_code);
  IF NOT FOUND OR v_space.owner_id IS DISTINCT FROM v_uid THEN
    RETURN false;
  END IF;
  -- S1: always require a valid, consumed ticket (see section note).
  IF NOT public.consume_admin_ticket(p_ticket, p_code, v_uid, 'kick') THEN
    RAISE EXCEPTION 'ADMIN_TICKET_REQUIRED';
  END IF;
  INSERT INTO public.space_bans (space_id, banned_user_id, banned_by)
  VALUES (v_space.id, v_target, v_uid)
  ON CONFLICT (space_id, banned_user_id) DO NOTHING;
  DELETE FROM public.space_members m
  WHERE m.space_id = v_space.id AND m.user_id = v_target;
  RETURN true;
END;
$$;

DROP FUNCTION IF EXISTS public.unban_space_user(text, text, text, uuid);

CREATE FUNCTION public.unban_space_user(
  p_code text,
  p_owner_id text,
  p_target_user_id text,
  p_ticket uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := left(btrim(coalesce(p_owner_id, '')), 64);
  v_space public.spaces%ROWTYPE;
BEGIN
  SELECT * INTO v_space FROM public.spaces s WHERE s.code = btrim(p_code);
  IF NOT FOUND OR v_space.owner_id IS DISTINCT FROM v_uid THEN
    RETURN false;
  END IF;
  -- S1: always require a valid, consumed ticket (see section note).
  IF NOT public.consume_admin_ticket(p_ticket, p_code, v_uid, 'unban') THEN
    RAISE EXCEPTION 'ADMIN_TICKET_REQUIRED';
  END IF;
  DELETE FROM public.space_bans b
  WHERE b.space_id = v_space.id
    AND b.banned_user_id = left(btrim(coalesce(p_target_user_id, '')), 64);
  RETURN FOUND;
END;
$$;

DROP FUNCTION IF EXISTS public.delete_space_for_everyone(text, text, uuid);

CREATE FUNCTION public.delete_space_for_everyone(
  p_code text,
  p_owner_id text,
  p_ticket uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := left(btrim(coalesce(p_owner_id, '')), 64);
  v_space public.spaces%ROWTYPE;
  v_deleted_id uuid;
BEGIN
  SELECT * INTO v_space FROM public.spaces s WHERE s.code = btrim(p_code);
  IF NOT FOUND OR v_space.owner_id IS DISTINCT FROM v_uid THEN
    RETURN false;
  END IF;
  -- S1: always require a valid, consumed ticket (see section note).
  IF NOT public.consume_admin_ticket(p_ticket, p_code, v_uid, 'delete_space') THEN
    RAISE EXCEPTION 'ADMIN_TICKET_REQUIRED';
  END IF;
  DELETE FROM public.spaces WHERE id = v_space.id RETURNING id INTO v_deleted_id;
  RETURN v_deleted_id IS NOT NULL;
END;
$$;

-- Re-grant after DROP (identical to 20261018000000:476-487; signatures unchanged).
REVOKE ALL ON FUNCTION public.set_space_password(text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_space_password(text, text, text, uuid) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.set_space_lock(text, text, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_space_lock(text, text, boolean, uuid) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.set_space_readonly(text, text, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_space_readonly(text, text, boolean, uuid) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.kick_space_user(text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kick_space_user(text, text, text, uuid) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.unban_space_user(text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unban_space_user(text, text, text, uuid) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_space_for_everyone(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_space_for_everyone(text, text, uuid) TO anon, authenticated;

-- ---------- S2: identity registration hardening ----------
-- First-claim-wins is preserved; adds strict p_reg_hash validation, a per-user
-- rate limit, and a conflict message that carries the original claim date.

DROP FUNCTION IF EXISTS public.register_identity(text, text, text);

CREATE FUNCTION public.register_identity(
  p_user_id text,
  p_public_jwk text,
  p_reg_hash text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := left(btrim(coalesce(p_user_id, '')), 64);
  v_jwk text := btrim(coalesce(p_public_jwk, ''));
  v_hash text := btrim(coalesce(p_reg_hash, ''));
  v_row public.identity_keys%ROWTYPE;
BEGIN
  IF v_uid = '' OR v_jwk = '' OR v_hash = '' THEN
    RAISE EXCEPTION 'Missing identity fields';
  END IF;
  -- S2a: registration hash must be plain hex; store at most 128 chars.
  IF v_hash !~ '^[0-9a-fA-F]+$' THEN
    RAISE EXCEPTION 'Invalid registration hash';
  END IF;
  v_hash := left(v_hash, 128);
  IF char_length(v_jwk) > 512 THEN
    RAISE EXCEPTION 'Invalid identity key';
  END IF;
  IF v_jwk NOT LIKE '%"kty":"EC"%' OR v_jwk NOT LIKE '%"crv":"P-256"%' THEN
    RAISE EXCEPTION 'Invalid identity key';
  END IF;
  -- S2b: 5 registration attempts per user per hour.
  IF NOT public.bump_rate_limit('reg:' || v_uid, 5, 3600) THEN
    RAISE EXCEPTION 'RATE_LIMITED';
  END IF;
  SELECT * INTO v_row FROM public.identity_keys k WHERE k.user_id = v_uid;
  IF NOT FOUND THEN
    INSERT INTO public.identity_keys (user_id, public_jwk, reg_hash)
    VALUES (v_uid, v_jwk, left(v_hash, 128));
    RETURN true;
  END IF;
  IF v_row.public_jwk = v_jwk THEN
    UPDATE public.identity_keys SET updated_at = now() WHERE user_id = v_uid;
    RETURN true;
  END IF;
  -- S2c: keep the IDENTITY_KEY_CONFLICT token (the client matches on it with
  -- String.includes) and append the original claim date for the UI.
  RAISE EXCEPTION 'IDENTITY_KEY_CONFLICT: identity already claimed on %',
    to_char(v_row.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') || ' UTC';
END;
$$;

REVOKE ALL ON FUNCTION public.register_identity(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_identity(text, text, text) TO anon, authenticated;

-- ---------- rate limit: send_space_message (30 msgs / 60 s per author/space) ----------
-- Signatures unchanged (12-arg canonical from 20261018000000); recreated after
-- DROP per house style, grants re-issued identical to 20261018000000:472-473.

DROP FUNCTION IF EXISTS public.send_space_message(text, text, text, text, text, text, text, bigint, text, boolean, text, text);

CREATE FUNCTION public.send_space_message(
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
  p_password_hash text DEFAULT NULL,
  p_sig text DEFAULT NULL
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
  v_sig text := nullif(btrim(coalesce(p_sig, '')), '');
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
  IF v_sig IS NOT NULL AND char_length(v_sig) > 256 THEN
    RAISE EXCEPTION 'Invalid signature';
  END IF;
  SELECT s.id INTO v_id FROM public.get_space_by_code(p_code, p_password_hash, p_author_id, false) s;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Space not found';
  END IF;
  SELECT s.owner_id, s.is_readonly INTO v_owner, v_readonly
  FROM public.spaces s WHERE s.id = v_id;
  IF coalesce(v_readonly, false) AND v_author_id <> v_owner THEN
    RAISE EXCEPTION 'SPACE_READ_ONLY';
  END IF;
  -- Rate limit after the gates so only actual sends consume budget.
  IF NOT public.bump_rate_limit('send:' || v_id::text || ':' || v_author_id, 30, 60) THEN
    RAISE EXCEPTION 'RATE_LIMITED';
  END IF;
  INSERT INTO public.messages (space_id, author_id, author_name, kind, text, data_url, file_name, file_size, mime_type, forwarded, sig)
  VALUES (v_id, v_author_id, left(coalesce(nullif(btrim(p_author_name), ''), 'Anonymous'), 40),
    v_kind, p_text, p_data_url, p_file_name, p_file_size, p_mime_type, coalesce(p_forwarded, false), v_sig)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.send_space_message(text, text, text, text, text, text, text, bigint, text, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_space_message(text, text, text, text, text, text, text, bigint, text, boolean, text, text) TO anon, authenticated;

-- ---------- rate limit: create_space (5 rooms / 300 s per owner) ----------
-- Canonical 4-arg signature from 20261013000002_quick_share_mode.sql; grants
-- re-issued identical to 20261013000002:60-61.

DROP FUNCTION IF EXISTS public.create_space(text, text, text, text);

CREATE FUNCTION public.create_space(
  p_name text,
  p_owner_id text,
  p_password_hash text DEFAULT NULL,
  p_mode text DEFAULT 'private'
)
RETURNS public.spaces
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := left(coalesce(nullif(btrim(p_name), ''), 'New Space'), 60);
  v_owner_id text := left(btrim(coalesce(p_owner_id, '')), 64);
  v_pw text := nullif(btrim(coalesce(p_password_hash, '')), '');
  v_mode text := lower(btrim(coalesce(p_mode, 'private')));
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
  IF v_mode NOT IN ('quick', 'private') THEN
    v_mode := 'private';
  END IF;

  IF NOT public.bump_rate_limit('create:' || v_owner_id, 5, 300) THEN
    RAISE EXCEPTION 'RATE_LIMITED';
  END IF;

  FOR i IN 1..20 LOOP
    IF v_mode = 'quick' THEN
      -- 8-digit numeric XXXX-XXXX: easy to read out / type, weaker entropy.
      v_code := lpad((floor(random() * 10000))::int::text, 4, '0') || '-' ||
                lpad((floor(random() * 10000))::int::text, 4, '0');
    ELSE
      v_code := public.generate_secure_space_code();
    END IF;
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

REVOKE ALL ON FUNCTION public.create_space(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_space(text, text, text, text) TO anon, authenticated;

-- ---------- performance: hot-column indexes ----------
-- Naming follows the existing messages_space_id_created_at_idx convention
-- (20260818024128:23).
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON public.messages (created_at);
CREATE INDEX IF NOT EXISTS messages_author_id_idx ON public.messages (author_id);
CREATE INDEX IF NOT EXISTS space_members_user_id_idx ON public.space_members (user_id);
CREATE INDEX IF NOT EXISTS spaces_owner_id_idx ON public.spaces (owner_id);
CREATE INDEX IF NOT EXISTS spaces_last_activity_at_idx ON public.spaces (last_activity_at);

-- ---------- performance: no more pruning on the read path ----------
-- Confirmed: pg_cron already runs prune_expired_chat_data() nightly at 03:00 —
-- 20261013000000_room_security_ttl.sql line 288:
--   PERFORM cron.schedule('prune-expired-chat-data-nightly', '0 3 * * *',
--                         'SELECT public.prune_expired_chat_data()');
-- so the PERFORM public.prune_expired_chat_data() calls in these read RPCs only
-- added write-heavy latency to every poll. Both queries still filter to the
-- 7-day retention window, so returned rows are unchanged.
-- Signatures unchanged (3-arg / 4-arg canonical from 20261017000000); grants
-- re-issued identical to 20261017000000:407-410.

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
      AND m.created_at >= NOW() - INTERVAL '7 days'
    ORDER BY m.created_at DESC
    LIMIT 100
  ) AS recent
  ORDER BY recent.created_at ASC;
END;
$$;

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
    AND m.created_at >= coalesce(p_after, NOW() - INTERVAL '7 days')
    AND m.created_at >= NOW() - INTERVAL '7 days'
  ORDER BY m.created_at ASC
  LIMIT 100;
END;
$$;

REVOKE ALL ON FUNCTION public.get_space_messages(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_messages(text, text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_space_messages_since(text, timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_messages_since(text, timestamptz, text, text) TO anon, authenticated;

-- ---------- prune functions are cron/owner-only now ----------
-- cleanup_expired_chats was granted to anon at 20260921000000:84-85 and both
-- functions inherited the default PUBLIC EXECUTE grant — any client could wipe
-- 7-day-old messages on demand. pg_cron (20261013000000:288) and the function
-- owner are unaffected: the owner keeps implicit EXECUTE and the cron job runs
-- as the scheduling role.
REVOKE ALL ON FUNCTION public.prune_expired_chat_data() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_expired_chats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_expired_chat_data() TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_chats() TO service_role;

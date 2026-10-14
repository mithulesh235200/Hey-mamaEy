-- Phase 2 verifiable identity: key registry, message signatures, admin tickets.
-- * identity_keys binds a user ID to a device ECDSA P-256 public key
--   (first-claim-wins; rotation requires the registration proof hash).
-- * messages.sig carries an ECDSA signature over the wire payload.
--   Verification happens client-side; the server just stores it.
-- * admin_tickets closes the ID-spoofing hole on owner ops: once an owner
--   has registered an identity key, owner RPCs require a ticket minted by
--   the secure-room-admin edge function (which DOES verify ECDSA).
--   Legacy owners without a registered key keep working unchanged.

-- ---------- registry ----------
CREATE TABLE IF NOT EXISTS public.identity_keys (
  user_id TEXT PRIMARY KEY,
  public_jwk TEXT NOT NULL,
  reg_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.identity_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.identity_keys FROM anon, authenticated;
GRANT ALL ON public.identity_keys TO service_role;

CREATE OR REPLACE FUNCTION public.register_identity(
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
  IF char_length(v_jwk) > 512 THEN
    RAISE EXCEPTION 'Invalid identity key';
  END IF;
  IF v_jwk NOT LIKE '%"kty":"EC"%' OR v_jwk NOT LIKE '%"crv":"P-256"%' THEN
    RAISE EXCEPTION 'Invalid identity key';
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
  RAISE EXCEPTION 'IDENTITY_KEY_CONFLICT';
END;
$$;

CREATE OR REPLACE FUNCTION public.rotate_identity(
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
BEGIN
  IF v_uid = '' OR v_jwk = '' OR v_hash = '' THEN
    RETURN false;
  END IF;
  IF v_jwk NOT LIKE '%"kty":"EC"%' OR v_jwk NOT LIKE '%"crv":"P-256"%' THEN
    RETURN false;
  END IF;
  UPDATE public.identity_keys
  SET public_jwk = v_jwk, updated_at = now()
  WHERE user_id = v_uid AND reg_hash = left(v_hash, 128);
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_identity_keys(p_user_ids text[])
RETURNS TABLE (user_id text, public_jwk text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT k.user_id, k.public_jwk
  FROM public.identity_keys k
  WHERE k.user_id = ANY (p_user_ids);
$$;

-- ---------- one-time admin tickets (minted by the edge function) ----------
CREATE TABLE IF NOT EXISTS public.admin_tickets (
  ticket UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_tickets FROM anon, authenticated;
GRANT ALL ON public.admin_tickets TO service_role;

CREATE OR REPLACE FUNCTION public.consume_admin_ticket(
  p_ticket uuid,
  p_code text,
  p_user_id text,
  p_action text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid text := left(btrim(coalesce(p_user_id, '')), 64);
  v_consumed uuid;
BEGIN
  IF p_ticket IS NULL OR v_uid = '' THEN
    RETURN false;
  END IF;
  DELETE FROM public.admin_tickets t
  USING public.spaces s
  WHERE t.ticket = p_ticket
    AND t.space_id = s.id
    AND s.code = btrim(p_code)
    AND t.user_id = v_uid
    AND t.action = btrim(p_action)
    AND t.expires_at > now()
  RETURNING t.ticket INTO v_consumed;
  RETURN v_consumed IS NOT NULL;
END;
$$;

-- Tickets older than a day can never be valid (RPCs also check expiry).
DELETE FROM public.admin_tickets WHERE expires_at < NOW() - INTERVAL '1 day';

-- ---------- message signatures (stored, verified client-side) ----------
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS sig TEXT;

-- ---------- send/edit carry p_sig ----------
DROP FUNCTION IF EXISTS public.send_space_message(text, text, text, text, text, text, text, bigint, text, boolean, text);

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
  INSERT INTO public.messages (space_id, author_id, author_name, kind, text, data_url, file_name, file_size, mime_type, forwarded, sig)
  VALUES (v_id, v_author_id, left(coalesce(nullif(btrim(p_author_name), ''), 'Anonymous'), 40),
    v_kind, p_text, p_data_url, p_file_name, p_file_size, p_mime_type, coalesce(p_forwarded, false), v_sig)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

DROP FUNCTION IF EXISTS public.edit_space_message(text, uuid, text, text, text);

CREATE FUNCTION public.edit_space_message(
  p_code text,
  p_message_id uuid,
  p_author_id text,
  p_text text,
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
  v_message public.messages;
  v_sig text := nullif(btrim(coalesce(p_sig, '')), '');
BEGIN
  IF btrim(coalesce(p_text, '')) = '' THEN
    RAISE EXCEPTION 'Message text cannot be empty';
  END IF;
  IF length(p_text) > 20000 THEN
    RAISE EXCEPTION 'Message text is too long';
  END IF;
  IF v_sig IS NOT NULL AND char_length(v_sig) > 256 THEN
    RAISE EXCEPTION 'Invalid signature';
  END IF;
  SELECT s.id INTO v_id FROM public.get_space_by_code(p_code, p_password_hash, p_author_id, false) s;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Space not found';
  END IF;

  UPDATE public.messages m
  SET text = p_text, sig = v_sig
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

-- ---------- owner ops: ticket required once the owner registered an identity ----------
DROP FUNCTION IF EXISTS public.set_space_password(text, text, text);

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
  IF EXISTS (SELECT 1 FROM public.identity_keys k WHERE k.user_id = v_uid)
    AND NOT public.consume_admin_ticket(p_ticket, p_code, v_uid, 'set_password') THEN
    RAISE EXCEPTION 'ADMIN_TICKET_REQUIRED';
  END IF;
  UPDATE public.spaces SET password_hash = v_pw
  WHERE id = v_space.id;
  RETURN FOUND;
END;
$$;

DROP FUNCTION IF EXISTS public.set_space_lock(text, text, boolean);

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
  IF EXISTS (SELECT 1 FROM public.identity_keys k WHERE k.user_id = v_uid)
    AND NOT public.consume_admin_ticket(p_ticket, p_code, v_uid, 'set_lock') THEN
    RAISE EXCEPTION 'ADMIN_TICKET_REQUIRED';
  END IF;
  UPDATE public.spaces SET is_locked = coalesce(p_locked, false)
  WHERE id = v_space.id;
  RETURN FOUND;
END;
$$;

DROP FUNCTION IF EXISTS public.set_space_readonly(text, text, boolean);

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
  IF EXISTS (SELECT 1 FROM public.identity_keys k WHERE k.user_id = v_uid)
    AND NOT public.consume_admin_ticket(p_ticket, p_code, v_uid, 'set_readonly') THEN
    RAISE EXCEPTION 'ADMIN_TICKET_REQUIRED';
  END IF;
  UPDATE public.spaces SET is_readonly = coalesce(p_readonly, false)
  WHERE id = v_space.id;
  RETURN FOUND;
END;
$$;

DROP FUNCTION IF EXISTS public.kick_space_user(text, text, text);

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
  IF EXISTS (SELECT 1 FROM public.identity_keys k WHERE k.user_id = v_uid)
    AND NOT public.consume_admin_ticket(p_ticket, p_code, v_uid, 'kick') THEN
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

DROP FUNCTION IF EXISTS public.unban_space_user(text, text, text);

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
  IF EXISTS (SELECT 1 FROM public.identity_keys k WHERE k.user_id = v_uid)
    AND NOT public.consume_admin_ticket(p_ticket, p_code, v_uid, 'unban') THEN
    RAISE EXCEPTION 'ADMIN_TICKET_REQUIRED';
  END IF;
  DELETE FROM public.space_bans b
  WHERE b.space_id = v_space.id
    AND b.banned_user_id = left(btrim(coalesce(p_target_user_id, '')), 64);
  RETURN FOUND;
END;
$$;

DROP FUNCTION IF EXISTS public.delete_space_for_everyone(text, text);

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
  IF EXISTS (SELECT 1 FROM public.identity_keys k WHERE k.user_id = v_uid)
    AND NOT public.consume_admin_ticket(p_ticket, p_code, v_uid, 'delete_space') THEN
    RAISE EXCEPTION 'ADMIN_TICKET_REQUIRED';
  END IF;
  DELETE FROM public.spaces WHERE id = v_space.id RETURNING id INTO v_deleted_id;
  RETURN v_deleted_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.register_identity(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_identity(text, text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.rotate_identity(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rotate_identity(text, text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_identity_keys(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_identity_keys(text[]) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_admin_ticket(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_admin_ticket(uuid, text, text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.send_space_message(text, text, text, text, text, text, text, bigint, text, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_space_message(text, text, text, text, text, text, text, bigint, text, boolean, text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.edit_space_message(text, uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.edit_space_message(text, uuid, text, text, text, text) TO anon, authenticated;
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

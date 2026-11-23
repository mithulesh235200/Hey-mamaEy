-- People (WhatsApp-like 1:1): ONE direct thread per identity pair.
--
-- Before this, tapping "chat" with a contact created a fresh private room on
-- each side — two different codes, neither side ever saw the other's messages.
-- Now the first side to open the chat creates THE shared room and the server
-- pre-registers BOTH identities as members, so the friend's device discovers
-- it through get_member_space_codes (membership sync) even when push invite
-- never arrives. The other side's own "chat" tap returns the SAME thread.
--
-- Threat model (unchanged app-wide): knowing BOTH identity codes opens the
-- thread — the same bearer knowledge as knowing a space code.

CREATE TABLE IF NOT EXISTS public.direct_threads (
  pair_key text PRIMARY KEY,
  user_a text NOT NULL,
  user_b text NOT NULL,
  space_id uuid NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT direct_threads_pair_order CHECK (user_a < user_b)
);

ALTER TABLE public.direct_threads ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.direct_threads FROM anon, authenticated;
GRANT ALL ON public.direct_threads TO service_role;

-- Get (or create on first use) the shared 1:1 room for a pair of identities.
-- SECURITY DEFINER: clients have no table access; everything goes through
-- functions, like the rest of the app.
CREATE OR REPLACE FUNCTION public.get_or_create_direct_space(
  p_me text,
  p_other text,
  p_name text DEFAULT NULL
)
RETURNS public.spaces
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me text := left(btrim(coalesce(p_me, '')), 64);
  v_other text := left(btrim(coalesce(p_other, '')), 64);
  v_a text;
  v_b text;
  v_thread public.direct_threads%ROWTYPE;
  v_space public.spaces;
  v_name text := left(coalesce(nullif(btrim(p_name), ''), 'Direct chat'), 60);
  v_code text;
  i int;
BEGIN
  IF v_me = '' OR v_other = '' THEN
    RAISE EXCEPTION 'Both identity codes are required';
  END IF;
  IF v_me = v_other THEN
    RAISE EXCEPTION 'Cannot start a chat with yourself';
  END IF;
  IF position('|' in v_me) > 0 OR position('|' in v_other) > 0 THEN
    RAISE EXCEPTION 'Invalid identity code';
  END IF;
  v_a := least(v_me, v_other);
  v_b := greatest(v_me, v_other);

  -- Serialize concurrent opens of the SAME pair: exactly one room is ever
  -- created for it (both simultaneous taps land on the same code).
  PERFORM pg_advisory_xact_lock(hashtext('direct:' || v_a || '|' || v_b));

  SELECT * INTO v_thread FROM public.direct_threads WHERE pair_key = v_a || '|' || v_b;
  IF FOUND THEN
    -- FK ON DELETE CASCADE: the thread row exists only while its space does.
    SELECT * INTO v_space FROM public.spaces WHERE id = v_thread.space_id;
    RETURN v_space;
  END IF;

  -- Same room shape as create_space (private, 12-char token) with its own
  -- rate bucket, so connecting with MANY friends at once isn't throttled by
  -- the 5-room/300 s general create limit.
  IF NOT public.bump_rate_limit('direct:' || v_me, 15, 300) THEN
    RAISE EXCEPTION 'RATE_LIMITED';
  END IF;

  FOR i IN 1..20 LOOP
    v_code := public.generate_secure_space_code();
    BEGIN
      INSERT INTO public.spaces (name, code, owner_id, last_activity_at)
      VALUES (v_name, v_code, v_me, now())
      RETURNING * INTO v_space;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      CONTINUE;
    END;
  END LOOP;
  IF v_space.id IS NULL THEN
    RAISE EXCEPTION 'Could not allocate a Space code, please try again';
  END IF;

  INSERT INTO public.direct_threads (pair_key, user_a, user_b, space_id, created_by)
  VALUES (v_a || '|' || v_b, v_a, v_b, v_space.id, v_me);

  -- Pre-register BOTH identities: the creator adopts the room locally via
  -- rememberCode; the other side discovers it through get_member_space_codes
  -- on their next membership sync (no push required).
  INSERT INTO public.space_members (space_id, user_id) VALUES
    (v_space.id, v_me),
    (v_space.id, v_other)
  ON CONFLICT (space_id, user_id) DO NOTHING;

  RETURN v_space;
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_create_direct_space(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_or_create_direct_space(text, text, text) TO anon, authenticated;

-- Leaving a room must drop the membership row, or the client's membership
-- sync (get_member_space_codes) would adopt the left room right back.
CREATE OR REPLACE FUNCTION public.unregister_space_member(p_code text, p_user_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_space_id uuid;
  v_uid text := left(btrim(coalesce(p_user_id, '')), 64);
BEGIN
  IF v_uid = '' THEN
    RETURN false;
  END IF;
  SELECT id INTO v_space_id FROM public.spaces WHERE code = btrim(p_code);
  IF v_space_id IS NULL THEN
    RETURN false;
  END IF;
  DELETE FROM public.space_members WHERE space_id = v_space_id AND user_id = v_uid;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.unregister_space_member(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unregister_space_member(text, text) TO anon, authenticated;

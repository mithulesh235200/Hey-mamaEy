-- Stranger request queue for 1:1 DMs (WhatsApp-style message requests).
--
-- Before this, knowing someone's identity code let you open a shared room
-- with them instantly: get_or_create_direct_space pre-registered the STRANGER
-- as a member of a room with you. Now a NEW direct thread can only be created
-- when the RECIPIENT has consented:
--
--   * consent = a dm_approvals row (approved_by = recipient, approved_for =
--     requester), uploaded fire-and-forget when the recipient saves the
--     requester in People, or when the recipient ACCEPTS a request here; and
--   * existing direct_threads pairs keep working — an open thread IS consent.
--
-- Without consent the tap is downgraded to a REQUEST: a dm_requests row the
-- recipient reviews in People → Requests. Accept records mutual consent and
-- creates THE shared room (both sides discover it exactly as before — the
-- requester through get_member_space_codes); decline dismisses it.
--
-- Client RPCs:
--   get_or_create_direct_space(p_me, p_other, p_name, p_from_name) -> jsonb
--       {status:'open', space:{...}} | {status:'requested'}
--   record_dm_approval(p_me, p_other) -> boolean   (my consent, best-effort)
--   list_dm_requests(p_me) -> pending requests addressed to me
--   respond_dm_request(p_me, p_other, p_accept) -> same jsonb as open
--
-- Threat model (unchanged app-wide): bearer knowledge of identity codes.
-- This gates who may START a thread, not who may read an existing one.

CREATE TABLE IF NOT EXISTS public.dm_approvals (
  approved_by text NOT NULL,
  approved_for text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (approved_by, approved_for)
);

-- One row per (pair, requester): both directions of a pair can have their
-- own pending request independently.
CREATE TABLE IF NOT EXISTS public.dm_requests (
  pair_key text NOT NULL,
  requester text NOT NULL,
  target text NOT NULL,
  -- Room name the requester offered (their perspective of the recipient).
  request_name text NOT NULL DEFAULT '',
  -- The requester's OWN display name — what the recipient sees in the inbox.
  from_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  PRIMARY KEY (pair_key, requester)
);

ALTER TABLE public.dm_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dm_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.dm_approvals FROM anon, authenticated;
REVOKE ALL ON public.dm_requests FROM anon, authenticated;
GRANT ALL ON public.dm_approvals TO service_role;
GRANT ALL ON public.dm_requests TO service_role;

-- My consent: "identity p_other may open a direct thread with me". Called
-- when I save someone in People (addContact). SECURITY DEFINER like the rest
-- of the app — no table access for clients.
CREATE OR REPLACE FUNCTION public.record_dm_approval(p_me text, p_other text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me text := left(btrim(coalesce(p_me, '')), 64);
  v_other text := left(btrim(coalesce(p_other, '')), 64);
BEGIN
  IF v_me = '' OR v_other = '' OR v_me = v_other THEN
    RETURN false;
  END IF;
  IF position('|' in v_me) > 0 OR position('|' in v_other) > 0 THEN
    RETURN false;
  END IF;
  -- Generous bucket: a 200-contact restore may upload in bulk; still caps
  -- runaway clients from growing the table without bound.
  IF NOT public.bump_rate_limit('appr:' || v_me, 250, 300) THEN
    RETURN false;
  END IF;
  INSERT INTO public.dm_approvals (approved_by, approved_for)
  VALUES (v_me, v_other)
  ON CONFLICT DO NOTHING;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.record_dm_approval(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_dm_approval(text, text) TO anon, authenticated;

-- Open THE shared 1:1 room for a pair — unless the recipient never consented,
-- in which case queue a request instead of touching their membership.
-- Replaces the previous (spaces) return type with a status envelope so the
-- client can tell "opened" from "requested"; only our client calls this.
DROP FUNCTION IF EXISTS public.get_or_create_direct_space(text, text, text);

CREATE FUNCTION public.get_or_create_direct_space(
  p_me text,
  p_other text,
  p_name text DEFAULT NULL,
  p_from_name text DEFAULT NULL
)
RETURNS jsonb
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
  v_from text := left(coalesce(btrim(p_from_name), ''), 40);
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
    -- Thread exists = consent already settled; retire any stale pending rows.
    UPDATE public.dm_requests
       SET status = 'accepted', responded_at = now()
     WHERE pair_key = v_a || '|' || v_b AND status = 'pending';
    RETURN jsonb_build_object('status', 'open', 'space', to_jsonb(v_space));
  END IF;

  -- No thread yet: the RECIPIENT must have consented to this requester.
  IF NOT EXISTS (
    SELECT 1 FROM public.dm_approvals
     WHERE approved_by = v_other AND approved_for = v_me
  ) THEN
    -- Queue a request instead of registering the stranger as a member.
    -- Same rate bucket shape as the room-create limit: one pending row per
    -- pair, so this caps how many DIFFERENT people one identity can ping.
    IF NOT public.bump_rate_limit('dmreq:' || v_me, 15, 300) THEN
      RAISE EXCEPTION 'RATE_LIMITED';
    END IF;
    INSERT INTO public.dm_requests
      (pair_key, requester, target, request_name, from_name, status, created_at, responded_at)
    VALUES
      (v_a || '|' || v_b, v_me, v_other, v_name, v_from, 'pending', now(), NULL)
    ON CONFLICT (pair_key, requester) DO UPDATE
      SET request_name = EXCLUDED.request_name,
          from_name = EXCLUDED.from_name,
          status = 'pending',
          created_at = now(),
          responded_at = NULL;
    RETURN jsonb_build_object('status', 'requested');
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

  -- A thread now exists: record the requester's own consent too (the
  -- recipient's was checked above) and retire pending request rows.
  INSERT INTO public.dm_approvals (approved_by, approved_for)
  VALUES (v_me, v_other)
  ON CONFLICT DO NOTHING;
  UPDATE public.dm_requests
     SET status = 'accepted', responded_at = now()
   WHERE pair_key = v_a || '|' || v_b AND status = 'pending';

  RETURN jsonb_build_object('status', 'open', 'space', to_jsonb(v_space));
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_create_direct_space(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_or_create_direct_space(text, text, text, text) TO anon, authenticated;

-- Pending requests addressed to me (People → Requests inbox).
CREATE OR REPLACE FUNCTION public.list_dm_requests(p_me text)
RETURNS TABLE (
  pair_key text,
  requester text,
  request_name text,
  from_name text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me text := left(btrim(coalesce(p_me, '')), 64);
BEGIN
  IF v_me = '' THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT r.pair_key, r.requester, r.request_name, r.from_name, r.created_at
      FROM public.dm_requests r
     WHERE r.target = v_me AND r.status = 'pending'
     ORDER BY r.created_at DESC
     LIMIT 50;
END;
$$;

REVOKE ALL ON FUNCTION public.list_dm_requests(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_dm_requests(text) TO anon, authenticated;

-- Accept (mutual consent + THE shared room) or decline a pending request.
-- p_me must be the request's target — you can only answer requests sent to you.
CREATE OR REPLACE FUNCTION public.respond_dm_request(
  p_me text,
  p_other text,
  p_accept boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me text := left(btrim(coalesce(p_me, '')), 64);
  v_other text := left(btrim(coalesce(p_other, '')), 64);
  v_a text;
  v_b text;
  v_req public.dm_requests%ROWTYPE;
BEGIN
  IF v_me = '' OR v_other = '' OR v_me = v_other THEN
    RAISE EXCEPTION 'Both identity codes are required';
  END IF;
  v_a := least(v_me, v_other);
  v_b := greatest(v_me, v_other);

  SELECT * INTO v_req
    FROM public.dm_requests
   WHERE pair_key = v_a || '|' || v_b
     AND requester = v_other
     AND target = v_me
     AND status = 'pending';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'none');
  END IF;

  IF NOT coalesce(p_accept, false) THEN
    UPDATE public.dm_requests
       SET status = 'declined', responded_at = now()
     WHERE pair_key = v_a || '|' || v_b
       AND requester = v_other
       AND target = v_me
       AND status = 'pending';
    RETURN jsonb_build_object('status', 'declined');
  END IF;

  -- Accept = mutual consent (they asked, I said yes), then open the room.
  -- Both approvals mean either side can reopen the pair later without a
  -- fresh request — same as any established chat.
  INSERT INTO public.dm_approvals (approved_by, approved_for)
  VALUES (v_me, v_other), (v_other, v_me)
  ON CONFLICT DO NOTHING;
  UPDATE public.dm_requests
     SET status = 'accepted', responded_at = now()
   WHERE pair_key = v_a || '|' || v_b AND status = 'pending';

  -- Recipient's perspective for the room title: the requester's OWN name
  -- (they have no saved nickname for a stranger), falling back to the
  -- name the requester offered for the room.
  RETURN public.get_or_create_direct_space(
    v_me,
    v_other,
    nullif(coalesce(nullif(v_req.from_name, ''), v_req.request_name), ''),
    v_req.from_name
  );
END;
$$;

REVOKE ALL ON FUNCTION public.respond_dm_request(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.respond_dm_request(text, text, boolean) TO anon, authenticated;

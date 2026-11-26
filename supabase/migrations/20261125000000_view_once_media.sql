-- View-once media: send a photo/video that opens exactly once, then it's gone.
--
-- HOW IT WORKS
-- 1. A view-once attachment travels INLINE inside the message row as an
--    E2E-encrypted `data:` URL (roomCrypto.encryptRoomDataUrl). It is never
--    uploaded to the public `space-media` bucket, so no public URL for it
--    ever exists — there is nothing to leak, hot-link or reopen later.
-- 2. `messages.view_once` marks the message. `messages.viewed_by` records
--    every user id that has already opened it — PER VIEWER, so one member
--    opening it never burns everyone else's copy.
-- 3. `consume_view_once()` is the only way to open one: it records the
--    viewer, refuses the author (you can never reopen your own view-once
--    media, matching WhatsApp), and once every current member has opened it
--    it scrubs `data_url` so the payload leaves the database for good.
-- 4. The media stays AES-GCM sealed with the room key the whole time it is
--    at rest, so even an unscrubbed row is unreadable outside the room.
--
-- APPLY: `supabase db push` (or run once in the Supabase SQL editor).
--
-- BACKWARD COMPATIBILITY
-- `p_view_once` is only ever sent by the client for a view-once message, so
-- every existing send keeps working against the old signature until this
-- migration is applied. Until then a view-once send fails with the app's
-- explicit "View-once isn't enabled on the server yet" toast instead of a
-- generic send error.

-- ---------- 1. the columns ----------
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS view_once boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS viewed_by text[] NOT NULL DEFAULT '{}';

-- ---------- 2. send_space_message gains p_view_once ----------
-- Signature change (14 -> 15 args) => drop the old overload first, exactly
-- like 20261106000002 did for the relation params.
DROP FUNCTION IF EXISTS public.send_space_message(
  text, text, text, text, text, text, text, bigint, text, boolean, text, text, uuid, uuid
);

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
  p_sig text DEFAULT NULL,
  p_reply_to uuid DEFAULT NULL,
  p_thread_parent_id uuid DEFAULT NULL,
  p_view_once boolean DEFAULT false
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
  v_reply uuid := p_reply_to;
  v_thread uuid := p_thread_parent_id;
  v_view_once boolean := coalesce(p_view_once, false);
BEGIN
  IF v_kind NOT IN ('text', 'image', 'video', 'audio', 'file') THEN
    RAISE EXCEPTION 'Invalid message kind';
  END IF;
  IF coalesce(char_length(coalesce(p_text, '')), 0) > 20000 THEN
    RAISE EXCEPTION 'Message text too long';
  END IF;
  -- 18.1M: old 18M cap + room for the fixed E2E wire overhead (~60 chars).
  IF p_data_url IS NOT NULL AND char_length(p_data_url) > 18100000 THEN
    RAISE EXCEPTION 'Attachment too large';
  END IF;
  IF p_file_size IS NOT NULL AND p_file_size > 20000000 THEN
    RAISE EXCEPTION 'File too large';
  END IF;
  IF v_sig IS NOT NULL AND char_length(v_sig) > 256 THEN
    RAISE EXCEPTION 'Invalid signature';
  END IF;
  -- View-once is a photo/video feature only (and the payload must fit the
  -- inline cap above — see MAX_VIEW_ONCE_DATA_URL_CHARS in ChatPanel).
  IF v_view_once AND v_kind NOT IN ('image', 'video') THEN
    RAISE EXCEPTION 'VIEW_ONCE_KIND';
  END IF;
  SELECT s.id INTO v_id FROM public.get_space_by_code(p_code, p_password_hash, p_author_id, false) s;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Space not found';
  END IF;
  -- Relations must point at messages in THIS space; anything else is dropped
  -- rather than trusted (a caller can't use this to link across rooms).
  IF v_reply IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.messages m WHERE m.id = v_reply AND m.space_id = v_id
  ) THEN
    v_reply := NULL;
  END IF;
  IF v_thread IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.messages m WHERE m.id = v_thread AND m.space_id = v_id
  ) THEN
    v_thread := NULL;
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
  INSERT INTO public.messages
    (space_id, author_id, author_name, kind, text, data_url, file_name, file_size,
     mime_type, forwarded, sig, reply_to, thread_parent_id, view_once, viewed_by)
  VALUES
    (v_id, v_author_id, left(coalesce(nullif(btrim(p_author_name), ''), 'Anonymous'), 40),
     v_kind, p_text, p_data_url, p_file_name, p_file_size, p_mime_type,
     coalesce(p_forwarded, false), v_sig, v_reply, v_thread, v_view_once, '{}')
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.send_space_message(
  text, text, text, text, text, text, text, bigint, text, boolean, text, text, uuid, uuid, boolean
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_space_message(
  text, text, text, text, text, text, text, bigint, text, boolean, text, text, uuid, uuid, boolean
) TO anon, authenticated;

-- ---------- 3. consume_view_once ----------
-- Records "this user has opened this message" and hands back the media so
-- the caller can show it one last time.
--
--   returns the media URL      -> open it (this is the viewer's one and only view)
--   returns '' (empty string)  -> refused: already opened (this or another
--                                 device), not view-once, or the sender
--   returns NULL               -> allowed and recorded, but the payload was
--                                 already scrubbed (nothing left to show)
--   raises                     -> no access to the room / bad arguments
CREATE FUNCTION public.consume_view_once(
  p_code text,
  p_message_id uuid,
  p_reader_id text,
  p_password_hash text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_space_id uuid;
  v_reader text := left(btrim(coalesce(p_reader_id, '')), 64);
  v_msg public.messages%ROWTYPE;
  v_seen text[];
  v_expected integer;
  v_url text;
BEGIN
  IF v_reader = '' THEN
    RAISE EXCEPTION 'A user id is required';
  END IF;
  SELECT s.id INTO v_space_id
    FROM public.get_space_by_code(p_code, p_password_hash, v_reader, false) s;
  IF v_space_id IS NULL THEN
    RAISE EXCEPTION 'Space not found';
  END IF;

  SELECT * INTO v_msg FROM public.messages m
   WHERE m.id = p_message_id AND m.space_id = v_space_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN '';
  END IF;
  IF NOT v_msg.view_once THEN
    RETURN '';
  END IF;
  -- The sender's own copy is a receipt, not a viewer: they can never reopen it.
  IF v_msg.author_id = v_reader THEN
    RETURN '';
  END IF;
  -- Already opened (here or on another device): one view, ever.
  IF v_msg.viewed_by @> ARRAY[v_reader] THEN
    RETURN '';
  END IF;

  v_seen := v_msg.viewed_by || v_reader;
  UPDATE public.messages m
     SET viewed_by = v_seen
   WHERE m.id = p_message_id;

  v_url := v_msg.data_url;

  -- Once every CURRENT member other than the author has opened it, the
  -- payload has no readers left: erase it from the row for good.
  SELECT count(*) INTO v_expected
    FROM public.space_members sm
   WHERE sm.space_id = v_space_id AND sm.user_id <> v_msg.author_id;
  IF coalesce(v_expected, 0) > 0
     AND coalesce(array_length(v_seen, 1), 0) >= v_expected THEN
    -- v_url was captured above: the viewer who triggers the scrub still gets
    -- to see the media they just earned — only the row is emptied.
    UPDATE public.messages m SET data_url = NULL WHERE m.id = p_message_id;
  END IF;

  RETURN v_url;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_view_once(text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_view_once(text, uuid, text, text)
  TO anon, authenticated;

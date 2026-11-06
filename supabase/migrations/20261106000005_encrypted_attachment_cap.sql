-- Headroom for encrypted attachments.
-- Client E2E now seals data_url payloads with AES-GCM (roomCrypto), which
-- adds a fixed ~60 chars of wire overhead (__enc1__ prefix + 12-byte IV +
-- GCM tag + base64). Without this bump, an attachment landing within ~60
-- chars of the old 18,000,000 cap would be rejected AFTER encryption even
-- though its plaintext fit. CREATE OR REPLACE: signature and return type
-- are unchanged (same 14 args, same SETOF public.messages), so PostgREST
-- sees no signature change.

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
  p_password_hash text DEFAULT NULL,
  p_sig text DEFAULT NULL,
  p_reply_to uuid DEFAULT NULL,
  p_thread_parent_id uuid DEFAULT NULL
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
     mime_type, forwarded, sig, reply_to, thread_parent_id)
  VALUES
    (v_id, v_author_id, left(coalesce(nullif(btrim(p_author_name), ''), 'Anonymous'), 40),
     v_kind, p_text, p_data_url, p_file_name, p_file_size, p_mime_type,
     coalesce(p_forwarded, false), v_sig, v_reply, v_thread)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.send_space_message(text, text, text, text, text, text, text, bigint, text, boolean, text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_space_message(text, text, text, text, text, text, text, bigint, text, boolean, text, text, uuid, uuid)
  TO anon, authenticated;

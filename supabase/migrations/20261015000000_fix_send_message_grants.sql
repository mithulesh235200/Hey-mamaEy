-- Fix send_space_message grants + NULL author crash + restore payload validation.
-- Additive only: safe to apply on top of HEAD.

-- 1) Explicit grants for the canonical 11-arg signature (was relying on
-- default PUBLIC execute after 20261013000001 dropped the old 10-arg grant).
REVOKE ALL ON FUNCTION public.send_space_message(text, text, text, text, text, text, text, bigint, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_space_message(text, text, text, text, text, text, text, bigint, text, boolean, text) TO anon, authenticated;

-- 2) Guard NULL author id (btrim(NULL) -> NULL -> NOT NULL violation).
-- Re-create with coalesce fallback while keeping the password gate.
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
BEGIN
  IF v_author_id = '' THEN
    v_author_id := 'ANON';
  END IF;
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
  SELECT s.id INTO v_id FROM public.get_space_by_code(p_code, p_password_hash) s;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Space not found';
  END IF;
  INSERT INTO public.messages (space_id, author_id, author_name, kind, text, data_url, file_name, file_size, mime_type, forwarded)
  VALUES (v_id, v_author_id, left(coalesce(nullif(btrim(p_author_name), ''), 'Anonymous'), 40),
    v_kind, p_text, p_data_url, p_file_name, p_file_size, p_mime_type, coalesce(p_forwarded, false))
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.send_space_message(text, text, text, text, text, text, text, bigint, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_space_message(text, text, text, text, text, text, text, bigint, text, boolean, text) TO anon, authenticated;

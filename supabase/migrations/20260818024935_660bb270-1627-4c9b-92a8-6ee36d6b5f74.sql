-- 1. Remove open policies
DROP POLICY IF EXISTS "Anyone can view spaces" ON public.spaces;
DROP POLICY IF EXISTS "Anyone can create spaces" ON public.spaces;
DROP POLICY IF EXISTS "Anyone can view messages" ON public.messages;
DROP POLICY IF EXISTS "Anyone can send messages" ON public.messages;

-- 2. Revoke direct table access from public clients (RLS stays enabled, default deny)
REVOKE ALL ON public.spaces FROM anon, authenticated;
REVOKE ALL ON public.messages FROM anon, authenticated;
GRANT ALL ON public.spaces TO service_role;
GRANT ALL ON public.messages TO service_role;

-- 3. Code-gated access functions

CREATE OR REPLACE FUNCTION public.create_space(p_name text)
RETURNS public.spaces
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := btrim(coalesce(p_name, ''));
  v_code text;
  v_space public.spaces;
  i int;
BEGIN
  IF v_name = '' THEN v_name := 'New Space'; END IF;
  IF length(v_name) > 60 THEN v_name := left(v_name, 60); END IF;

  FOR i IN 1..10 LOOP
    v_code := lpad((floor(random() * 1000))::int::text, 3, '0') || '-' ||
              lpad((floor(random() * 1000))::int::text, 3, '0');
    BEGIN
      INSERT INTO public.spaces (name, code) VALUES (v_name, v_code) RETURNING * INTO v_space;
      RETURN v_space;
    EXCEPTION WHEN unique_violation THEN
      CONTINUE;
    END;
  END LOOP;

  RAISE EXCEPTION 'Could not allocate a Space code, please try again';
END;
$$;

CREATE OR REPLACE FUNCTION public.get_space_by_code(p_code text)
RETURNS public.spaces
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.spaces WHERE code = btrim(p_code) LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_space_messages(p_code text)
RETURNS SETOF public.messages
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.*
  FROM public.messages m
  JOIN public.spaces s ON s.id = m.space_id
  WHERE s.code = btrim(p_code)
  ORDER BY m.created_at ASC
  LIMIT 500;
$$;

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
  p_forwarded boolean DEFAULT false
)
RETURNS public.messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_space_id uuid;
  v_message public.messages;
BEGIN
  SELECT id INTO v_space_id FROM public.spaces WHERE code = btrim(p_code);
  IF v_space_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Space code';
  END IF;

  IF p_kind IS NULL OR p_kind NOT IN ('text', 'image', 'video', 'audio', 'file') THEN
    RAISE EXCEPTION 'Invalid message kind';
  END IF;

  IF p_text IS NOT NULL AND length(p_text) > 5000 THEN
    RAISE EXCEPTION 'Message text is too long';
  END IF;

  IF p_data_url IS NOT NULL AND length(p_data_url) > 18000000 THEN
    RAISE EXCEPTION 'Attachment is too large';
  END IF;

  IF p_file_size IS NOT NULL AND (p_file_size < 0 OR p_file_size > 20000000) THEN
    RAISE EXCEPTION 'Attachment is too large';
  END IF;

  INSERT INTO public.messages (
    space_id, author_id, author_name, kind, text, data_url,
    file_name, file_size, mime_type, forwarded
  ) VALUES (
    v_space_id,
    left(coalesce(nullif(btrim(p_author_id), ''), 'ANON'), 64),
    left(coalesce(nullif(btrim(p_author_name), ''), 'Anonymous'), 64),
    p_kind,
    p_text,
    p_data_url,
    left(p_file_name, 200),
    p_file_size,
    left(p_mime_type, 120),
    coalesce(p_forwarded, false)
  )
  RETURNING * INTO v_message;

  RETURN v_message;
END;
$$;

REVOKE ALL ON FUNCTION public.create_space(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_space_by_code(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_space_messages(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.send_space_message(text, text, text, text, text, text, text, bigint, text, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_space(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_space_by_code(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_space_messages(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_space_message(text, text, text, text, text, text, text, bigint, text, boolean) TO anon, authenticated;
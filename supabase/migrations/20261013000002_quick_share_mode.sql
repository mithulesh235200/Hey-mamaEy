-- Room-type choice: "quick" (8-digit numeric, fast to dictate/type for file
-- sharing) vs "private" (12-char alphanumeric token, default).
-- Single canonical signature only: the previous 3-arg overload is dropped in
-- this same migration so PostgREST never sees two candidates (PGRST203).

DROP FUNCTION IF EXISTS public.create_space(text, text, text);

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

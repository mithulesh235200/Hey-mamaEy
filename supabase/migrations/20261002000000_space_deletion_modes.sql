ALTER TABLE public.spaces
ADD COLUMN IF NOT EXISTS owner_id text;

CREATE OR REPLACE FUNCTION public.create_space(p_name text, p_owner_id text)
RETURNS public.spaces
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := left(coalesce(nullif(btrim(p_name), ''), 'New Space'), 60);
  v_owner_id text := left(btrim(coalesce(p_owner_id, '')), 64);
  v_code text;
  v_space public.spaces;
  i int;
BEGIN
  IF v_owner_id = '' THEN
    RAISE EXCEPTION 'A Space owner is required';
  END IF;

  FOR i IN 1..10 LOOP
    v_code := lpad((floor(random() * 10000))::int::text, 4, '0') || '-' ||
              lpad((floor(random() * 10000))::int::text, 4, '0');
    BEGIN
      INSERT INTO public.spaces (name, code, owner_id)
      VALUES (v_name, v_code, v_owner_id)
      RETURNING * INTO v_space;
      RETURN v_space;
    EXCEPTION WHEN unique_violation THEN
      CONTINUE;
    END;
  END LOOP;

  RAISE EXCEPTION 'Could not allocate a Space code, please try again';
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_space_for_everyone(p_code text, p_owner_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted_id uuid;
BEGIN
  DELETE FROM public.spaces
  WHERE code = btrim(p_code)
    AND owner_id = left(btrim(coalesce(p_owner_id, '')), 64)
  RETURNING id INTO v_deleted_id;

  RETURN v_deleted_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.create_space(text) FROM PUBLIC;
DROP FUNCTION IF EXISTS public.create_space(text);
REVOKE ALL ON FUNCTION public.create_space(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_space_for_everyone(text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_space(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_space_for_everyone(text, text) TO anon, authenticated;

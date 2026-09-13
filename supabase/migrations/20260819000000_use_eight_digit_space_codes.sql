-- Increase the code space from one million to one hundred million combinations.
-- Existing 3-3 codes remain valid and can still be joined by users who have them.
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
    v_code := lpad((floor(random() * 10000))::int::text, 4, '0') || '-' ||
              lpad((floor(random() * 10000))::int::text, 4, '0');
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

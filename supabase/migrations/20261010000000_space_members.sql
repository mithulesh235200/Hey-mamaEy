-- Explicit space membership so a restored identity recovers EVERY space,
-- including silent ones (never messaged) and pre-owner-tracking legacy spaces.
-- get_user_spaces only sees owners/authors; this table is the source of truth.
-- Run once in the Supabase SQL editor. Client failures are non-fatal until applied.

CREATE TABLE IF NOT EXISTS public.space_members (
  space_id UUID NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, user_id)
);

ALTER TABLE public.space_members ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.space_members FROM anon, authenticated;
GRANT ALL ON public.space_members TO service_role;

-- Register membership by space code (knowing the code authorizes the join,
-- same model as the rest of the app).
CREATE OR REPLACE FUNCTION public.register_space_member(p_code text, p_user_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_space_id uuid;
BEGIN
  IF btrim(coalesce(p_user_id, '')) = '' THEN
    RAISE EXCEPTION 'A user id is required';
  END IF;
  SELECT id INTO v_space_id FROM public.spaces WHERE code = btrim(p_code);
  IF v_space_id IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO public.space_members (space_id, user_id)
  VALUES (v_space_id, left(btrim(p_user_id), 64))
  ON CONFLICT (space_id, user_id) DO NOTHING;
  RETURN true;
END;
$$;

-- All space codes a user id belongs to (used after identity restore).
CREATE OR REPLACE FUNCTION public.get_member_space_codes(p_user_id text)
RETURNS TABLE (code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.code
  FROM public.space_members m
  JOIN public.spaces s ON s.id = m.space_id
  WHERE m.user_id = btrim(p_user_id);
$$;

REVOKE ALL ON FUNCTION public.register_space_member(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_space_member(text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_member_space_codes(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_member_space_codes(text) TO anon, authenticated;

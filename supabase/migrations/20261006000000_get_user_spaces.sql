-- Function to retrieve all spaces associated with a user ID (by owner_id or message author_id)
CREATE OR REPLACE FUNCTION public.get_user_spaces(p_user_id text)
RETURNS SETOF public.spaces
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT s.*
  FROM public.spaces s
  LEFT JOIN public.messages m ON m.space_id = s.id
  WHERE (s.owner_id IS NOT NULL AND s.owner_id = btrim(p_user_id))
     OR (m.author_id IS NOT NULL AND m.author_id = btrim(p_user_id));
$$;

REVOKE ALL ON FUNCTION public.get_user_spaces(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_spaces(text) TO anon, authenticated;

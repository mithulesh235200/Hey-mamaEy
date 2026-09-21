-- Keep background chat sync small by returning only newer messages.
CREATE OR REPLACE FUNCTION public.get_space_messages(p_code text)
RETURNS SETOF public.messages
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT recent.*
  FROM (
    SELECT m.*
    FROM public.messages m
    JOIN public.spaces s ON s.id = m.space_id
    WHERE s.code = btrim(p_code)
    ORDER BY m.created_at DESC
    LIMIT 100
  ) AS recent
  ORDER BY recent.created_at ASC;
$$;

CREATE OR REPLACE FUNCTION public.get_space_messages_since(
  p_code text,
  p_after timestamptz
)
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
    AND m.created_at >= coalesce(p_after, '-infinity'::timestamptz)
  ORDER BY m.created_at ASC
  LIMIT 100;
$$;

REVOKE ALL ON FUNCTION public.get_space_messages_since(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_messages_since(text, timestamptz) TO anon, authenticated;
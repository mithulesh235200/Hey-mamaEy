ALTER TABLE public.messages
ADD COLUMN IF NOT EXISTS read_at timestamptz;

CREATE OR REPLACE FUNCTION public.mark_space_messages_read(
  p_code text,
  p_reader_id text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
  v_reader_id text := left(btrim(coalesce(p_reader_id, '')), 64);
BEGIN
  IF v_reader_id = '' THEN
    RETURN 0;
  END IF;

  UPDATE public.messages AS m
  SET read_at = NOW()
  FROM public.spaces AS s
  WHERE s.code = btrim(p_code)
    AND m.space_id = s.id
    AND m.author_id <> v_reader_id
    AND m.read_at IS NULL
    AND m.created_at >= NOW() - INTERVAL '7 days';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_space_messages_read(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_space_messages_read(text, text) TO anon, authenticated;

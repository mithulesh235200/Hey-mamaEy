-- Device push tokens for background message notifications.
-- Membership is derived exactly like get_user_spaces (owner or message author),
-- so no extra membership table is needed. The edge function reads tokens via
-- get_space_push_tokens with the service-role key. Run once in SQL editor.

CREATE TABLE IF NOT EXISTS public.push_tokens (
  user_id TEXT NOT NULL,
  token TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'android',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, token)
);

ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;

-- No direct client access: all reads/writes go through SECURITY DEFINER functions.
REVOKE ALL ON public.push_tokens FROM anon, authenticated;
GRANT ALL ON public.push_tokens TO service_role;

CREATE OR REPLACE FUNCTION public.register_push_token(
  p_user_id text,
  p_token text,
  p_platform text DEFAULT 'android'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF btrim(coalesce(p_user_id, '')) = '' OR btrim(coalesce(p_token, '')) = '' THEN
    RAISE EXCEPTION 'Missing user or token';
  END IF;
  INSERT INTO public.push_tokens (user_id, token, platform)
  VALUES (left(btrim(p_user_id), 64), left(btrim(p_token), 512), left(coalesce(p_platform, 'android'), 16))
  ON CONFLICT (user_id, token) DO UPDATE SET updated_at = now();
  RETURN true;
END;
$$;

-- Tokens of everyone in a space except the author. Service-role only (edge function).
CREATE OR REPLACE FUNCTION public.get_space_push_tokens(
  p_space_id uuid,
  p_exclude_user_id text
)
RETURNS TABLE (user_id text, token text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT t.user_id, t.token
  FROM public.push_tokens t
  WHERE t.user_id <> btrim(p_exclude_user_id)
    AND (
      EXISTS (
        SELECT 1 FROM public.spaces s
        WHERE s.id = p_space_id AND s.owner_id IS NOT NULL AND s.owner_id = t.user_id
      )
      OR EXISTS (
        SELECT 1 FROM public.messages m
        WHERE m.space_id = p_space_id AND m.author_id = t.user_id
      )
    );
$$;

REVOKE ALL ON FUNCTION public.register_push_token(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_push_token(text, text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_space_push_tokens(uuid, text) FROM PUBLIC;

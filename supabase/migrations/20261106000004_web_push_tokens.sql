-- Web Push support in the existing push_tokens table.
--
-- A web subscription is a JSON object (~300-400 chars:
-- {"endpoint":"...","keys":{"p256dh":"...","auth":"..."}}), which the old
-- 512-char token column could truncate on some endpoints. Widen the cap to
-- 1024 and let the edge function fan out to both FCM (android/ios) and
-- Web Push (platform='web') subscribers.
--
-- get_space_push_tokens gains a `platform` output column so push-on-message
-- can route each token to the right transport. DROP + CREATE (not
-- CREATE OR REPLACE): return-shape changes break PostgREST's cached
-- signature (PGRST203). Service-role only — no client types affected.

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
  VALUES (
    left(btrim(p_user_id), 64),
    left(btrim(p_token), 1024),
    left(coalesce(p_platform, 'android'), 16)
  )
  ON CONFLICT (user_id, token) DO UPDATE SET updated_at = now();
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.register_push_token(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_push_token(text, text, text)
  TO anon, authenticated;

DROP FUNCTION IF EXISTS public.get_space_push_tokens(uuid, text);

CREATE FUNCTION public.get_space_push_tokens(
  p_space_id uuid,
  p_exclude_user_id text
)
RETURNS TABLE (user_id text, token text, platform text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT t.user_id, t.token, t.platform
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

REVOKE ALL ON FUNCTION public.get_space_push_tokens(uuid, text) FROM PUBLIC;

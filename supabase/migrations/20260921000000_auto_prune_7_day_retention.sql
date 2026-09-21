-- 7-Day Auto-Cleanup Data Retention Migration
-- Automatically deletes messages older than 7 days and empty inactive spaces to keep Supabase storage light.

CREATE OR REPLACE FUNCTION public.prune_expired_chat_data()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Delete all messages older than 7 days
  DELETE FROM public.messages
  WHERE created_at < NOW() - INTERVAL '7 days';

  -- Delete spaces with no messages that were created more than 7 days ago
  DELETE FROM public.spaces s
  WHERE s.created_at < NOW() - INTERVAL '7 days'
    AND NOT EXISTS (
      SELECT 1 FROM public.messages m WHERE m.space_id = s.id
    );
END;
$$;

-- Function to allow clients to explicitly trigger cleanup
CREATE OR REPLACE FUNCTION public.cleanup_expired_chats()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.prune_expired_chat_data();
  RETURN true;
END;
$$;

-- Hook auto-pruning into existing RPC methods
CREATE OR REPLACE FUNCTION public.get_space_messages(p_code text)
RETURNS SETOF public.messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.prune_expired_chat_data();
  RETURN QUERY
  SELECT recent.*
  FROM (
    SELECT m.*
    FROM public.messages m
    JOIN public.spaces s ON s.id = m.space_id
    WHERE s.code = btrim(p_code)
      AND m.created_at >= NOW() - INTERVAL '7 days'
    ORDER BY m.created_at DESC
    LIMIT 100
  ) AS recent
  ORDER BY recent.created_at ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_space_messages_since(
  p_code text,
  p_after timestamptz
)
RETURNS SETOF public.messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.prune_expired_chat_data();
  RETURN QUERY
  SELECT m.*
  FROM public.messages m
  JOIN public.spaces s ON s.id = m.space_id
  WHERE s.code = btrim(p_code)
    AND m.created_at >= coalesce(p_after, NOW() - INTERVAL '7 days')
    AND m.created_at >= NOW() - INTERVAL '7 days'
  ORDER BY m.created_at ASC
  LIMIT 100;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_expired_chats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_chats() TO anon, authenticated;

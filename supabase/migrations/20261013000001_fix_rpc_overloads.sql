-- Fix PGRST203 "Could not choose the best candidate function".
-- CREATE OR REPLACE with a new signature creates an OVERLOAD instead of
-- replacing: the old 1-arg/2-arg RPCs survived next to the new password-aware
-- versions, so PostgREST cannot pick one. Drop every legacy overload and keep
-- only the canonical password-aware signatures (extra args have DEFAULTs, so
-- old 2-arg calls keep working).

-- Legacy create_space overloads (ancient 1-arg + previous 2-arg).
DROP FUNCTION IF EXISTS public.create_space(text);
DROP FUNCTION IF EXISTS public.create_space(text, text);

-- Legacy read overloads.
DROP FUNCTION IF EXISTS public.get_space_by_code(text);
DROP FUNCTION IF EXISTS public.get_space_messages(text);
DROP FUNCTION IF EXISTS public.get_space_messages_since(text, timestamptz);

-- Legacy send overload (10 args, no p_password_hash).
DROP FUNCTION IF EXISTS public.send_space_message(text, text, text, text, text, text, text, bigint, text, boolean);

-- Re-grant the canonical signatures (idempotent).
REVOKE ALL ON FUNCTION public.create_space(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_space(text, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_space_by_code(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_by_code(text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_space_messages(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_messages(text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_space_messages_since(text, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_space_messages_since(text, timestamptz, text) TO anon, authenticated;

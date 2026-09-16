-- Message actions for the anonymous code-based chat model.
-- The author ID check prevents editing or deleting another local identity's messages.

CREATE OR REPLACE FUNCTION public.edit_space_message(
  p_code text,
  p_message_id uuid,
  p_author_id text,
  p_text text
)
RETURNS public.messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_message public.messages;
BEGIN
  IF btrim(coalesce(p_text, '')) = '' THEN
    RAISE EXCEPTION 'Message text cannot be empty';
  END IF;
  IF length(p_text) > 5000 THEN
    RAISE EXCEPTION 'Message text is too long';
  END IF;

  UPDATE public.messages m
  SET text = p_text
  FROM public.spaces s
  WHERE m.id = p_message_id
    AND m.space_id = s.id
    AND s.code = btrim(p_code)
    AND m.author_id = left(coalesce(nullif(btrim(p_author_id), ''), 'ANON'), 64)
    AND m.kind = 'text'
  RETURNING m.* INTO v_message;

  IF v_message.id IS NULL THEN
    RAISE EXCEPTION 'Message not found or not owned by this identity';
  END IF;
  RETURN v_message;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_space_message(
  p_code text,
  p_message_id uuid,
  p_author_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted boolean;
BEGIN
  DELETE FROM public.messages m
  USING public.spaces s
  WHERE m.id = p_message_id
    AND m.space_id = s.id
    AND s.code = btrim(p_code)
    AND m.author_id = left(coalesce(nullif(btrim(p_author_id), ''), 'ANON'), 64)
  RETURNING true INTO v_deleted;

  IF NOT coalesce(v_deleted, false) THEN
    RAISE EXCEPTION 'Message not found or not owned by this identity';
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.edit_space_message(text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_space_message(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.edit_space_message(text, uuid, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_space_message(text, uuid, text) TO anon, authenticated;

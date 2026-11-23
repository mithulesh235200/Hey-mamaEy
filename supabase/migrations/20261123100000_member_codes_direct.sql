-- WhatsApp-style chat titles: the client needs to know WHICH of my rooms
-- are direct 1:1 threads and who created them, so it can map each room to
-- MY saved contact and show MY nickname for that person on each side —
-- never the other person's name for me ("Chat with Hamri" is the creator's
-- perspective; the friend must see "Alice").
--
-- get_member_space_codes grows two columns (owner_id, is_direct). Older
-- deployed builds read only `code`, so the extra columns are backward
-- compatible. DROP first: Postgres cannot change a function's return type
-- in place.
--
-- Privacy: same bearer model as before — knowing an identity code already
-- exposes that identity's room codes via this function; the new columns
-- only add the owner id and a direct-thread flag for rooms the caller is
-- already a member of.

DROP FUNCTION IF EXISTS public.get_member_space_codes(text);

CREATE FUNCTION public.get_member_space_codes(p_user_id text)
RETURNS TABLE (code text, owner_id text, is_direct boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.code AS code,
         s.owner_id AS owner_id,
         EXISTS (
           SELECT 1 FROM public.direct_threads d WHERE d.space_id = s.id
         ) AS is_direct
  FROM public.space_members m
  JOIN public.spaces s ON s.id = m.space_id
  WHERE m.user_id = btrim(p_user_id);
$$;

REVOKE ALL ON FUNCTION public.get_member_space_codes(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_member_space_codes(text) TO anon, authenticated;

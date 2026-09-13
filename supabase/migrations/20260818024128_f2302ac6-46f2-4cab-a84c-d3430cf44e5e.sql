CREATE TABLE public.spaces (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  space_id UUID NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT 'Anonymous',
  kind TEXT NOT NULL DEFAULT 'text',
  text TEXT,
  data_url TEXT,
  file_name TEXT,
  file_size BIGINT,
  mime_type TEXT,
  forwarded BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX messages_space_id_created_at_idx ON public.messages (space_id, created_at);

GRANT SELECT, INSERT ON public.spaces TO anon, authenticated;
GRANT ALL ON public.spaces TO service_role;
GRANT SELECT, INSERT ON public.messages TO anon, authenticated;
GRANT ALL ON public.messages TO service_role;

ALTER TABLE public.spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view spaces" ON public.spaces FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Anyone can create spaces" ON public.spaces FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Anyone can view messages" ON public.messages FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Anyone can send messages" ON public.messages FOR INSERT TO anon, authenticated WITH CHECK (true);

ALTER PUBLICATION supabase_realtime ADD TABLE public.spaces;
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
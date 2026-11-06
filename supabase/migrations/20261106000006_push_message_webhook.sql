-- Wire the push-on-message database webhook natively (pg_net), implementing
-- the setup documented in supabase/functions/push-on-message/index.ts:
--   messages INSERT -> POST https://<project>.supabase.co/functions/v1/push-on-message
--   with an x-webhook-secret header (the function fails closed with 401
--   without it). Previously this trigger existed only as an undocumented
--   dashboard step, so pushes never fired for anyone.
--
-- The shared secret is NOT stored here. After applying this migration:
--   1. supabase secrets set WEBHOOK_SECRET=<random>
--   2. seed the matching value into the RLS-locked config table:
--      insert into public.webhook_config(name, value)
--      values ('push_webhook_secret', '<same random>')
--      on conflict (name) do update set value = excluded.value;
--
-- NOTE: for a different project, update the function URL below to that
-- project's supabase.co domain.

create extension if not exists pg_net with schema extensions;

create table if not exists public.webhook_config (
  name text primary key,
  value text not null
);

alter table public.webhook_config enable row level security;
-- No policies: readable only by the table owner (postgres) / SECURITY DEFINER
-- functions; explicitly unreachable from the API roles.
revoke all on public.webhook_config from anon, authenticated, service_role;

create or replace function public.on_message_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret text;
begin
  select w.value into secret from public.webhook_config w where w.name = 'push_webhook_secret';
  if secret is null or secret = '' then
    return new;
  end if;
  perform net.http_post(
    url := 'https://nawjajqlavcjpucsvtun.supabase.co/functions/v1/push-on-message',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', secret
    ),
    body := jsonb_build_object(
      'type', 'INSERT',
      'schema', 'public',
      'table', 'messages',
      'record', to_jsonb(new)
    )
  );
  return new;
end
$$;

drop trigger if exists trg_push_on_message on public.messages;
create trigger trg_push_on_message
  after insert on public.messages
  for each row
  execute function public.on_message_push();

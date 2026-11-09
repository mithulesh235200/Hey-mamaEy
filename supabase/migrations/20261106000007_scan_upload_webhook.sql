-- Wire the scan-upload database webhook (layer 3 of upload security), and
-- harden the push webhook trigger: both notifications must be BEST-EFFORT —
-- a pg_net hiccup can never roll back a message insert or a file upload.
--
-- 1. on_message_push is re-created with an EXCEPTION guard (same behavior,
--    failures now raise NOTICE instead of aborting the INSERT).
-- 2. on_object_scan fires on storage.objects INSERT (bucket space-media) and
--    POSTs the object record to the scan-upload edge function with the
--    x-webhook-secret header (same WEBHOOK_SECRET as push-on-message).
--
-- The secret value is NOT stored here. After applying, seed it (same value
-- as the push row — both edge functions read the same WEBHOOK_SECRET env):
--   insert into public.webhook_config(name, value)
--   select 'scan_upload_webhook_secret', value from public.webhook_config
--   where name = 'push_webhook_secret'
--   on conflict (name) do update set value = excluded.value;
--
-- NOTE: for a different project, update the URLs below to that project's
-- supabase.co domain.

create or replace function public.on_message_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret text;
begin
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
  exception when others then
    raise notice 'push webhook failed: %', sqlerrm;
  end;
  return new;
end
$$;

create or replace function public.on_object_scan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret text;
begin
  begin
    select w.value into secret from public.webhook_config w where w.name = 'scan_upload_webhook_secret';
    if secret is null or secret = '' then
      return new;
    end if;
    perform net.http_post(
      url := 'https://nawjajqlavcjpucsvtun.supabase.co/functions/v1/scan-upload',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', secret
      ),
      body := jsonb_build_object(
        'type', 'INSERT',
        'schema', 'storage',
        'table', 'objects',
        'record', to_jsonb(new)
      )
    );
  exception when others then
    raise notice 'scan webhook failed: %', sqlerrm;
  end;
  return new;
end
$$;

drop trigger if exists trg_scan_upload on storage.objects;
create trigger trg_scan_upload
  after insert on storage.objects
  for each row
  when (new.bucket_id = 'space-media')
  execute function public.on_object_scan();

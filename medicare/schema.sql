alter table public.leads add column phone_callback_consent boolean not null default false;
create table public.medicare_phone_calls(
 id uuid primary key default gen_random_uuid(),provider_call_id text not null unique,lead_id uuid references public.leads(id),
 caller_phone text,started_at timestamptz not null default now(),direction text not null check(direction in ('inbound','outbound')),
 status text not null default 'in-progress',duration_seconds integer,recording_consent boolean not null default false,
 recording_status text not null default 'none',recording_sid text,summary text,transcript jsonb not null default '[]',
 intake jsonb not null default '{}',voice_context jsonb not null default '{}'
);
create index medicare_phone_calls_lead_idx on public.medicare_phone_calls(lead_id,started_at desc);
alter table public.medicare_phone_calls enable row level security;
create table public.voice_event_receipts(event_id uuid primary key,received_at timestamptz not null default now());
alter table public.voice_event_receipts enable row level security;
revoke all on public.voice_event_receipts,public.medicare_phone_calls from public,anon,authenticated;
grant all on public.voice_event_receipts,public.medicare_phone_calls to service_role;
create or replace function public.ingest_medicare_voice(p_event_id uuid,p_kind text,p_call_sid text,p_data jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare callrow public.medicare_phone_calls; target uuid;info jsonb;v_phone text;chosen_name text;new_info jsonb;
begin
 perform pg_advisory_xact_lock(hashtext(p_call_sid));
 insert into public.voice_event_receipts(event_id) values(p_event_id) on conflict do nothing;
 if not found then return jsonb_build_object('ok',true,'duplicate',true);end if;
 select * into callrow from public.medicare_phone_calls where provider_call_id=p_call_sid for update;
 if callrow.id is null and p_kind<>'started' then return jsonb_build_object('ok',true,'pending_start',true);end if;
 if callrow.id is null then
  v_phone:=regexp_replace(coalesce(p_data->>'phone',''),'[^0-9]','','g');if v_phone!~'^[0-9]{10,15}$' then v_phone:=null;end if;
  if coalesce(p_data->>'lead_id','')~'^[0-9a-f-]{36}$' then select id into target from public.leads where id=(p_data->>'lead_id')::uuid and deleted_at is null;end if;
  if target is null and v_phone is not null then select id into target from public.leads where leads.phone=v_phone and deleted_at is null order by created_at desc limit 1;end if;
  insert into public.medicare_phone_calls(lead_id,caller_phone,direction,status,provider_call_id,voice_context)
  values(target,v_phone,case when p_data->>'direction'='outbound' then 'outbound' else 'inbound' end,'in-progress',p_call_sid,coalesce(p_data->'voice_context','{}')) returning * into callrow;
 end if;
 target:=callrow.lead_id;
 if p_kind='started' then update public.medicare_phone_calls set voice_context=case when p_data?'voice_context' then p_data->'voice_context' else voice_context end where id=callrow.id;end if;
 if p_kind='context' then return jsonb_build_object('ok',true,'context',callrow.voice_context||jsonb_build_object('direction',callrow.direction,'phone',callrow.caller_phone,'lead_id',target));end if;
 if p_kind='recording_consent' then update public.medicare_phone_calls set recording_consent=coalesce((p_data->>'consent')::boolean,false),recording_status=case when (p_data->>'consent')::boolean then 'pending' else 'none' end where id=callrow.id;end if;
 if p_kind='recording_failed' then update public.medicare_phone_calls set recording_status='failed' where id=callrow.id;end if;
 if p_kind='recording' and (p_data->>'recording_sid')~'^RE[0-9a-f]{32}$' then update public.medicare_phone_calls set recording_sid=p_data->>'recording_sid',recording_status=case when p_data->>'status'='completed' then 'available' else 'failed' end where id=callrow.id;end if;
 if p_kind='status' then update public.medicare_phone_calls set status=left(coalesce(p_data->>'status','unknown'),40),duration_seconds=greatest(0,coalesce((p_data->>'duration_seconds')::integer,0)) where id=callrow.id;end if;
 if p_kind in ('intake','summary') then
  info:=callrow.intake||coalesce(p_data->'intake','{}');chosen_name:=nullif(left(trim(info->>'full_name'),100),'');v_phone:=regexp_replace(coalesce(info->>'phone',callrow.caller_phone,''),'[^0-9]','','g');
  if target is null and char_length(chosen_name)>=2 and v_phone~'^[0-9]{10,15}$' and (info->>'zip_code')~'^[0-9]{5}$' and info->>'has_parts_a_b'='true' then
   insert into public.leads(request_id,full_name,phone,zip_code,has_parts_a_b,consent_text,consent_version,source,phone_callback_consent)
   values(gen_random_uuid(),chosen_name,v_phone,info->>'zip_code',true,'Caller initiated an inbound call. Callback permission is recorded separately.','phone-inbound-v1','phone-inbound',coalesce((info->>'phone_callback_consent')::boolean,false)) returning id into target;
  end if;
  if target is not null then
   update public.leads set full_name=case when char_length(chosen_name)>=2 then chosen_name else full_name end,
    phone=case when v_phone~'^[0-9]{10,15}$' then v_phone else leads.phone end,
    zip_code=case when (info->>'zip_code')~'^[0-9]{5}$' then info->>'zip_code' else zip_code end,
    current_coverage=case when info->>'current_coverage' in ('original_medicare','medicare_advantage','employer_retiree','other','unsure') then info->>'current_coverage' else current_coverage end,
    review_priority=case when info->>'review_priority' in ('costs','doctors','prescriptions','extra_benefits','compare_options') then info->>'review_priority' else review_priority end,
    callback_timezone=case when (info->>'callback_timezone')~'^[A-Za-z0-9_+./-]{1,100}$' then info->>'callback_timezone' else callback_timezone end,
    phone_callback_consent=case when jsonb_typeof(info->'phone_callback_consent')='boolean' then (info->>'phone_callback_consent')::boolean else phone_callback_consent end,
    status=case when info->>'do_not_contact'='true' then 'do_not_contact' when nullif(info->>'callback_request','') is not null and status<>'do_not_contact' then 'follow_up' else status end,
    notes=case when nullif(info->>'callback_request','') is not null and strpos(notes,'Callback requested: '||left(info->>'callback_request',500))=0 then left(notes||E'\nCallback requested: '||left(info->>'callback_request',500),5000) else notes end,
    updated_at=clock_timestamp() where id=target and deleted_at is null;
  end if;
  update public.medicare_phone_calls set lead_id=target,intake=info,summary=coalesce(nullif(left(p_data->>'summary',2000),''),nullif(left(info->>'summary',2000),''),summary),transcript=case when recording_consent and jsonb_typeof(p_data->'transcript')='array' then p_data->'transcript' else transcript end where id=callrow.id;
 end if;
 delete from public.voice_event_receipts where received_at<now()-interval '2 days';
 return jsonb_build_object('ok',true,'lead_id',target,'call_id',callrow.id);
end $$;
revoke all on function public.ingest_medicare_voice(uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_medicare_voice(uuid,text,text,jsonb) to service_role;

-- Routing is private configuration. Set the destination through the database;
-- do not commit personal telephone numbers into source code.
create table public.medicare_voice_settings (id text primary key, transfer_phone text not null check(transfer_phone ~ '^\\+[1-9][0-9]{9,14}$'));
alter table public.medicare_voice_settings enable row level security;
revoke all on public.medicare_voice_settings from public,anon,authenticated;
grant select on public.medicare_voice_settings to service_role;

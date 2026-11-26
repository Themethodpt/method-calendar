-- The Method Calendar: database setup.
-- Paste this whole file into Supabase > SQL Editor > New query, then click Run.
-- Safe to run more than once.

create extension if not exists pgcrypto;

-- ---------- Tables ----------
create table if not exists trainers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  full_name text,
  color text not null default '#b5583a',
  hours jsonb not null default '{"0":null,"1":[5,21],"2":[5,21],"3":[5,21],"4":[5,21],"5":[5,21],"6":[7,12]}',
  active boolean not null default true,
  created_at timestamptz default now()
);

-- One row per login. role: 'pending' until an admin approves it.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  role text not null default 'pending' check (role in ('pending','trainer','admin')),
  trainer_id uuid references trainers(id) on delete set null,
  created_at timestamptz default now()
);

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null default '',
  trainer_id uuid references trainers(id) on delete set null,
  active boolean not null default true,
  prior_sessions int not null default 0,   -- sessions before this app started
  member_since date,
  birthday text,                            -- 'MM-DD'
  sessions_left text,
  session_type text not null default 'Single session',
  created_at timestamptz default now()
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  hour int not null check (hour between 0 and 23),
  client_id uuid not null references clients(id) on delete cascade,
  trainer_id uuid not null references trainers(id) on delete cascade,
  type text not null default 'Single session',
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz default now()
);
create index if not exists sessions_date on sessions(date);
create index if not exists sessions_client on sessions(client_id);

create table if not exists checkins (
  week_start date not null,
  client_id uuid not null references clients(id) on delete cascade,
  status text not null check (status in ('away','inactive')),
  set_by uuid references auth.users(id) default auth.uid(),
  primary key (week_start, client_id)
);

create table if not exists settings (
  key text primary key,
  value jsonb
);
insert into settings(key,value) values ('tv_names','"first"') on conflict do nothing;

-- ---------- Helpers ----------
create or replace function is_admin() returns boolean language sql stable security definer set search_path=public as
$$ select exists(select 1 from profiles where id=auth.uid() and role='admin') $$;

create or replace function my_trainer() returns uuid language sql stable security definer set search_path=public as
$$ select trainer_id from profiles where id=auth.uid() and role in ('trainer','admin') $$;

-- New sign-ups get a 'pending' profile. The very first account becomes admin.
create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into profiles(id,email,display_name,role)
  values (new.id,new.email,coalesce(new.raw_user_meta_data->>'display_name',split_part(new.email,'@',1)),
          case when not exists(select 1 from profiles where role='admin') then 'admin' else 'pending' end);
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- ---------- Row level security ----------
alter table trainers enable row level security;
alter table profiles enable row level security;
alter table clients enable row level security;
alter table sessions enable row level security;
alter table checkins enable row level security;
alter table settings enable row level security;

drop policy if exists tr_read on trainers;   create policy tr_read on trainers for select to authenticated using (true);
drop policy if exists tr_admin on trainers;  create policy tr_admin on trainers for all to authenticated using (is_admin()) with check (is_admin());
drop policy if exists tr_own_hours on trainers; create policy tr_own_hours on trainers for update to authenticated using (id=my_trainer()) with check (id=my_trainer());

drop policy if exists pr_self on profiles;   create policy pr_self on profiles for select to authenticated using (id=auth.uid() or is_admin());
drop policy if exists pr_admin on profiles;  create policy pr_admin on profiles for update to authenticated using (is_admin()) with check (is_admin());

-- Trainers see only their own clients. Admins see everyone.
drop policy if exists cl_read on clients;    create policy cl_read on clients for select to authenticated using (is_admin() or trainer_id=my_trainer());
drop policy if exists cl_admin on clients;   create policy cl_admin on clients for all to authenticated using (is_admin()) with check (is_admin());

-- Trainers see and change only sessions they run.
drop policy if exists se_read on sessions;   create policy se_read on sessions for select to authenticated using (is_admin() or trainer_id=my_trainer());
drop policy if exists se_ins on sessions;    create policy se_ins on sessions for insert to authenticated with check (is_admin() or trainer_id=my_trainer());
drop policy if exists se_upd on sessions;    create policy se_upd on sessions for update to authenticated using (is_admin() or trainer_id=my_trainer()) with check (is_admin() or trainer_id=my_trainer());
drop policy if exists se_del on sessions;    create policy se_del on sessions for delete to authenticated using (is_admin() or trainer_id=my_trainer());

drop policy if exists ck_rw on checkins;     create policy ck_rw on checkins for all to authenticated
  using (is_admin() or client_id in (select id from clients where trainer_id=my_trainer()))
  with check (is_admin() or client_id in (select id from clients where trainer_id=my_trainer()));

drop policy if exists st_read on settings;   create policy st_read on settings for select to authenticated using (true);
drop policy if exists st_admin on settings;  create policy st_admin on settings for all to authenticated using (is_admin()) with check (is_admin());

-- A trainer marking a client inactive in the weekly check-in.
create or replace function checkin_inactive(cid uuid) returns void language plpgsql security definer set search_path=public as $$
begin
  if not (is_admin() or exists(select 1 from clients where id=cid and trainer_id=my_trainer())) then raise exception 'not allowed'; end if;
  update clients set active=false where id=cid;
end $$;

-- Covering for another trainer: search active clients by name (name only, nothing else).
create or replace function search_cover_clients(q text) returns table(id uuid, name text, trainer text)
language sql stable security definer set search_path=public as $$
  select c.id, c.first_name||' '||c.last_name, t.name from clients c left join trainers t on t.id=c.trainer_id
  where auth.uid() is not null and c.active and length(trim(q))>=2
    and (c.first_name||' '||c.last_name) ilike '%'||trim(q)||'%'
  order by 2 limit 15 $$;

-- Name of a client on a session this trainer runs (covering), so their calendar can show it.
create or replace function session_client_names(ids uuid[]) returns table(id uuid, name text, trainer_id uuid)
language sql stable security definer set search_path=public as $$
  select c.id, c.first_name||' '||c.last_name, c.trainer_id from clients c
  where c.id = any(ids) and exists(select 1 from sessions s where s.client_id=c.id and (is_admin() or s.trainer_id=my_trainer())) $$;

-- Gym TV: public, no login. Returns FIRST NAMES ONLY plus what the badges need.
create or replace function tv_board(day date) returns jsonb language sql stable security definer set search_path=public as $$
  with s as (
    select se.date, se.hour, se.trainer_id, se.client_id from sessions se where se.date between day and day+1
  ), lifetime as (
    select c.id, c.prior_sessions + (select count(*) from sessions x where x.client_id=c.id and x.date<=day+1) as total from clients c
    where c.id in (select client_id from s)
  )
  select jsonb_build_object(
    'tv_names',(select value from settings where key='tv_names'),
    'trainers',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'color',color)),'[]') from trainers),
    'sessions',(select coalesce(jsonb_agg(jsonb_build_object(
        'date',s.date,'hour',s.hour,'trainer',s.trainer_id,
        'name',case (select value#>>'{}' from settings where key='tv_names') when 'none' then '' when 'full' then c.first_name||' '||c.last_name else c.first_name end,
        'n',c.prior_sessions+(select count(*) from sessions x where x.client_id=c.id and (x.date<s.date or (x.date=s.date and x.hour<=s.hour))),
        'bday',c.birthday,'since',c.member_since,
        'weeks',(select array_agg(distinct (x.date - ((extract(dow from x.date)::int+1)%7))) from sessions x where x.client_id=c.id and x.date>day-120 and x.date<=s.date)
      ) order by s.date,s.hour),'[]') from s join clients c on c.id=s.client_id),
    'month_total',(select count(*) from sessions where date_trunc('month',date)=date_trunc('month',day) and date<=day)
  ) $$;
grant execute on function tv_board(date) to anon, authenticated;

-- Method Mascots: each client can have a pet (name, kind, small face photo) for the TV.
alter table clients add column if not exists pet_name text;
alter table clients add column if not exists pet_type text;
alter table clients add column if not exists pet_photo text check (pet_photo is null or (pet_photo like 'data:image/%' and length(pet_photo) < 400000));

-- Gym TV pets: public, no login. Only pets of clients booked today/tomorrow, with the owner's first name.
create or replace function tv_pets(day date) returns jsonb language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object('date',s.date,'hour',s.hour,'trainer',s.trainer_id,'pet',c.pet_name,'type',c.pet_type,
    'owner',case (select value#>>'{}' from settings where key='tv_names') when 'full' then c.first_name||' '||c.last_name else c.first_name end,
    'photo',c.pet_photo)),'[]')
  from sessions s join clients c on c.id=s.client_id
  where s.date between day and day+1 and c.pet_name is not null and c.pet_photo is not null
    and coalesce((select value#>>'{}' from settings where key='tv_names'),'first')<>'none' $$;
grant execute on function tv_pets(date) to anon, authenticated;
revoke execute on function checkin_inactive(uuid) from anon;
revoke execute on function search_cover_clients(text) from anon;
revoke execute on function session_client_names(uuid[]) from anon;

-- Lifetime session count per client the viewer can see (prior + sessions up to today).
create or replace function client_totals() returns table(id uuid, total int)
language sql stable security definer set search_path=public as $$
  select c.id, (c.prior_sessions + (select count(*) from sessions x where x.client_id=c.id and x.date<=current_date))::int
  from clients c where is_admin() or c.trainer_id=my_trainer() $$;
revoke execute on function client_totals() from anon;

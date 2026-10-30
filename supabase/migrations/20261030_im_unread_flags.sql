-- ============================================================
-- 20261030_im_unread_flags.sql
-- 站内私信（IM）未读镜像表（spec/nexconn-im，plan.md D2/D5）
--
-- 定位：im_unread_flags 是首页"消息"徽标的镜像数据源；
--       会话/消息/未读的权威源在 NexConn 云端，本表仅做镜像：
--       · nexconn-webhook EF（service role）对接收方行 unread_count+1
--       · chat.js 在 SDK 未读真值变化时将校正值写回本人行（镜像自愈）
--       · chat-badge.js 读本人行 + Realtime postgres_changes 订阅实时更新徽标
-- 使用：Supabase Dashboard → SQL Editor 粘贴执行（或 supabase db push）
-- ============================================================

-- 1. 建表（幂等）：user_id PK + FK auth.users；unread_count 镜像值；updated_at 写入时间
create table if not exists public.im_unread_flags (
    user_id uuid primary key references auth.users(id) on delete cascade,
    unread_count integer not null default 0,
    updated_at timestamptz not null default now()
);

-- 2. RLS：本人可 SELECT / INSERT / UPDATE 自己的行
--    （徽标读取 + chat.js 校正写回/无行时自建首行——镜像自愈；
--     INSERT/UPDATE 均以 auth.uid() = user_id 收口，仅能写本人行，伪造他人未读不可行）；
--    DELETE 不设 policy（普通用户不可删行）；
--    webhook EF 经 service role key 写入（service role 绕过 RLS，无需额外 policy）
alter table public.im_unread_flags enable row level security;

drop policy if exists "im_unread_flags_select_own" on public.im_unread_flags;
create policy "im_unread_flags_select_own"
    on public.im_unread_flags
    for select
    using (auth.uid() = user_id);

drop policy if exists "im_unread_flags_insert_own" on public.im_unread_flags;
create policy "im_unread_flags_insert_own"
    on public.im_unread_flags
    for insert
    with check (auth.uid() = user_id);

drop policy if exists "im_unread_flags_update_own" on public.im_unread_flags;
create policy "im_unread_flags_update_own"
    on public.im_unread_flags
    for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- 3. Realtime：replica identity full + 加入 supabase_realtime publication，
--    使 postgres_changes 的行级变更按 RLS 过滤下发（订阅者仅收到本人行的 UPDATE）
alter table public.im_unread_flags replica identity full;

do $$
begin
    -- 表尚未加入 publication 时才添加（重复执行不报错）
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'im_unread_flags'
    ) then
        alter publication supabase_realtime add table public.im_unread_flags;
    end if;
end $$;

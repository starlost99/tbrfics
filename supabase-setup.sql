create table if not exists public.stacks (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.stacks enable row level security;

create policy "own row: select" on public.stacks
  for select using (auth.uid() = user_id);
create policy "own row: insert" on public.stacks
  for insert with check (auth.uid() = user_id);
create policy "own row: update" on public.stacks
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own row: delete" on public.stacks
  for delete using (auth.uid() = user_id);

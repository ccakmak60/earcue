alter table users add column plan text not null default 'none';
alter table users add column plan_status text;
alter table users add column current_period_end timestamptz;

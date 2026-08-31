alter table users add column email_nightly boolean not null default true;
alter table users add column email_weekly boolean not null default true;
alter table day_reviews add column emailed_at timestamptz;

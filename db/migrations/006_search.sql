alter table traces add column text_tsv tsvector generated always as (to_tsvector('english', text)) stored;
create index traces_text_tsv on traces using gin (text_tsv);
create index traces_user_ts on traces (user_id, ts desc);

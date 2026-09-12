-- NVIDIA NIM meters requests and tokens, not the call counts usage_daily caps. api/_lib/nim.js
-- chat() writes one row per day and model: every HTTP attempt adds a request (retries are billed
-- too), successful responses add the `usage` token counts every caller used to discard.
create table nim_usage_daily (
  day date not null default current_date,
  model text not null,
  requests integer not null default 0,
  prompt_tokens bigint not null default 0,
  completion_tokens bigint not null default 0,
  primary key (day, model)
);

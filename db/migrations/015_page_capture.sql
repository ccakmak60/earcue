alter table users add column capture_pages boolean not null default true;
create index context_items_page_text on context_items (ts desc) where kind = 'page_text';

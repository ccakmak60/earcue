-- Names the embedding model behind each memories.embedding.
--
-- Vectors from different models are not comparable: a cosine distance between a
-- gemini-embedding-001 vector and an Azure text-embedding-3-small vector is noise, and acting on
-- it would merge unrelated memories permanently. Every similarity query in knowledge.ts filters on
-- this column, so pre-existing rows (embed_model null) simply stop being recall and dedup
-- candidates until scripts/reembed.mjs re-embeds them and stamps the current model.
alter table memories add column embed_model text;

-- The dedup probe and the recall knn both filter on embed_model before ordering by distance.
create index memories_embed_model on memories (user_id, embed_model) where superseded_by is null and forgotten_at is null;

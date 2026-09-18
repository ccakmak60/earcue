-- Azure OpenAI text-embedding-3-small replaced gemini-embedding-001. Cosine distance between
-- vectors from two different models is meaningless, so every stored vector is dropped here
-- rather than left to poison dedup and recall. scripts/reembed-memories.ts regenerates them;
-- until it finishes, recall() and upsertMemories() skip these rows (`embedding is not null`)
-- and recall falls back to its full-text branch. Dimensions are unchanged, so vector(768) and
-- the HNSW index in 008_knowledge.sql stay as they are.
update memories set embedding = null;

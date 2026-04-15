# SparkBook — Claude Context

## Search Before Reading Files

Before exploring the codebase, run a semantic search against the Obsidian vault:

```
mcp__smart-connections__lookup(
  query: "<your question>",
  vault_path: "/Users/leonardodavinci/Desktop/authorspark"
)
```

The vault has `SparkBook.md` (architecture, phase status, open items, key decisions) and `Claude Sessions/` (full history of what was built each session). Search it first — it's faster and cheaper than reading files.

---

## Project

SaaS: YouTube/TikTok creators log in → transcripts ingested → AI drafts a book → EPUB export.

**Full plan:** `~/.claude/plans/floating-hatching-valiant.md`
**Vault doc:** `/Users/leonardodavinci/Desktop/authorspark/SparkBook.md`

---

## Stack

- Next.js 16, App Router, TypeScript
- NextAuth v5 (Google/YouTube OAuth, JWT-cached user data)
- Neon (Postgres + pgvector), Cloudflare R2
- Inngest for all background jobs (`INNGEST_DEV=1` locally, DevServer at `:8288`)
- OpenRouter for Claude + embeddings (text-embedding-3-small) — no separate OpenAI/Anthropic keys
- Tailwind + shadcn/ui, Milkdown editor

---

## Current Phase

Phase 3 (chunking + embeddings) is coded but **not yet run end-to-end**. Next step:

```sql
UPDATE ingestion_jobs SET status = 'failed';
DELETE FROM chunks;
```

Then re-run Sync YouTube in the UI → `ingest-youtube` fires → triggers `embed-chunks` → verify `chunks.embedding` is non-null in Neon.

Phase 4 is outline generation via Claude (OpenRouter) with prompt caching.

---

## Key Patterns

- **Never block API routes** — queue everything through Inngest
- **JWT caching** — DB user data in JWT, not re-fetched per request (`lib/auth.ts`)
- **Token refresh** at start of every Inngest function (`refreshAccessToken()` in `lib/youtube.ts`)
- **OpenRouter** as single AI gateway — covers Claude, embeddings, Whisper
- **Webpack** preferred over Turbopack (memory leaks in dev) — Turbopack still on in `next.config.ts`, remove if RAM issues return
- **Node RAM cap**: `NODE_OPTIONS='--max-old-space-size=2048'` in dev script

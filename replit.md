# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **AI**: Gemini via Replit AI Integrations (gemini-2.5-flash for chat and title generation)

## Artifacts

### `artifacts/codegen` — CodeGen AI (react-vite, preview at `/`)

A full-stack AI coding assistant with:
- Language selector dropdown (18+ programming languages)
- Streaming SSE chat with gpt-5.3-codex
- Conversation history with auto-naming (AI names the chat from the first prompt)
- Markdown + code block rendering with copy-to-clipboard
- Light blue and white color scheme

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   ├── api-server/         # Express API server
│   └── codegen/            # CodeGen AI react-vite frontend
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   ├── db/                 # Drizzle ORM schema + DB connection
│   ├── integrations-openai-ai-server/  # OpenAI server-side client
│   └── integrations-openai-ai-react/   # OpenAI react hooks
├── scripts/                # Utility scripts (single workspace package)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## Database Schema

- `conversations` — id, title, language, createdAt
- `messages` — id, conversationId, role, content, createdAt

## API Routes

- `GET /api/openai/conversations` — list all conversations
- `POST /api/openai/conversations` — create conversation (title, language)
- `GET /api/openai/conversations/:id` — get conversation with messages
- `DELETE /api/openai/conversations/:id` — delete conversation
- `GET /api/openai/conversations/:id/messages` — list messages
- `POST /api/openai/conversations/:id/messages` — send message (SSE streaming)

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server. Routes live in `src/routes/` and use `@workspace/api-zod` for request and response validation and `@workspace/db` for persistence.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes at `/api`
- Routes: `src/routes/index.ts` mounts sub-routers; `src/routes/openai/index.ts` handles all CodeGen AI endpoints
- Depends on: `@workspace/db`, `@workspace/api-zod`, `@workspace/integrations-openai-ai-server`

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL.

- `src/schema/conversations.ts` — conversations table (id, title, language, createdAt)
- `src/schema/messages.ts` — messages table (id, conversationId, role, content, createdAt)
- `drizzle.config.ts` — Drizzle Kit config

Production migrations are handled by Replit when publishing. In development, run `pnpm --filter @workspace/db run push`.

### `lib/api-spec` (`@workspace/api-spec`)

Owns the OpenAPI 3.1 spec (`openapi.yaml`) and the Orval config (`orval.config.ts`).

Run codegen: `pnpm --filter @workspace/api-spec run codegen`

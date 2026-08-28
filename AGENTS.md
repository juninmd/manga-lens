# AGENTS.md

## Workspace Instructions

- Stack: Bun, TypeScript, Hono, Tauri v2, Vercel AI SDK (`ai`, `@ai-sdk/openai-compatible`, `@openrouter/ai-sdk-provider`).
- Lint & Validation: `bun run check` (`oxlint` + `tsc --noEmit` + `bun test`).
- AI Engine: Multi-provider via AI SDK (`openrouter`, `ollama`, `openaicompatible`).

# AGENTS.md

## Workspace Instructions

- Stack: Bun, TypeScript, Hono, Tauri v2, Vercel AI SDK (`ai`, `@ai-sdk/openai-compatible`, `@openrouter/ai-sdk-provider`).
- Lint & Validation: `bun run check` (`oxlint` + `tsc --noEmit` + `bun test`).
- AI Engine: Multi-provider via AI SDK (`openrouter`, `ollama`, `openaicompatible`).

<!-- base-actions-main-policy -->
## GitHub Actions — padrão obrigatório (@main)

- Referencie as actions internas sempre pelo branch, nunca por SHA:
  - `uses: juninmd/base-actions/<action>@main`
  - `uses: juninmd/base-actions/.github/workflows/<arquivo>.yml@main`
- Não fixe `@<sha>` em `juninmd/base-actions`: a atualização é centralizada no
  `main` e passa a valer no próximo run.
- PRs cujos checks não iniciam por billing/spending limit são mesclados pelo bot central
  `juninmd/base-actions/.github/workflows/auto-merge-billing-blocked.yml`.
  Para impedir o merge automático de um PR, aplique a label `do-not-merge`.
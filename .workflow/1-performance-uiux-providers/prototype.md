# Prototype — Separação Mangá / HQ / Livro no catálogo

Artifact clicável (dados fake, sem wiring real): https://claude.ai/code/artifact/15e5a137-da4b-4c45-a0bf-1f2ace40e923

Escopo escolhido para este round de protótipo: a mudança de UI/UX mais
concreta e decidível que saiu do research (separar mangá/HQ/livro), já que o
pedido original de "melhorias em UI/UX" não trouxe tela específica. Performance
e arquitetura de provider ficam para o plano — não são coisas que se prototipam
visualmente.

## Variantes

- **A — Abas segmentadas**: um catálogo por tipo (Mangá / HQ / Livro), cada
  aba com seus próprios filtros e paginação, sem misturar resultados.
  Tradeoff: zero mistura entre tipos, mas quem quer ver tudo junto precisa
  trocar de aba.
- **B — Filtro unificado**: grade única, tipo é mais um chip de filtro
  combinável com os já existentes (gênero, status, fonte), badge de tipo no
  card. Tradeoff: descoberta cruzada fácil, mas o filtro de tipo compete por
  espaço visual com os outros filtros.
- **C — Prateleiras (estilo Netflix)**: tela inicial com prateleiras
  horizontais por tipo + uma de "continuar lendo" misturando os três; "ver
  tudo" abre o catálogo filtrado. Tradeoff: melhor curadoria/primeira
  impressão, mas esconde a busca avançada atrás de "ver tudo".

Cada variante mostra estado vazio (Livro sem fonte configurada), populado, e
erro/aviso (banner de 403 do MangaRead, replicando o comportamento real
descrito em `README.md:41-44`).

## Decisão

**Escolhida: A — Abas segmentadas.** Catálogo próprio por tipo (Mangá / HQ /
Livro), filtros e paginação isolados por aba, sem mistura de resultados.

Rejeitadas:
- **B — Filtro unificado**: descartada por competir por espaço visual com os
  filtros já existentes (gênero, status, fonte).
- **C — Prateleiras**: descartada por esconder a busca avançada atrás de "ver
  tudo", priorizando curadoria sobre busca — não é o caso de uso principal
  do catálogo atual (README já é centrado em busca/filtro).

Essa escolha carrega para o plano: contrato `Provider` ganha campo de tipo de
conteúdo, catálogo (`catalog.ts`) ganha abas por tipo, cada aba mantém seu
próprio estado de filtro/paginação.

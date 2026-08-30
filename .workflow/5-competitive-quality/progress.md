# Progress — Rodada de qualidade competitiva (issue #5)

Branch: `quality/competitive-round-5`

## Passo 1 — Benchmark de OCR (spike)

**Mudança**: `scripts/ocr-benchmark.mjs` (Tesseract.js eng/jpn/jpn_vert) +
`scripts/ocr-benchmark-manga-ocr.py` (manga-ocr + EasyOCR), gabarito e
recortes em `.workflow/5-competitive-quality/{crops,crops-jp,ocr-ground-truth*.json}`.
Nenhum arquivo de produção tocado — spike puro.

**Comando**: `node scripts/ocr-benchmark.mjs` e
`PYTHONIOENCODING=utf-8 python scripts/ocr-benchmark-manga-ocr.py`

**Resultado** (completo em `ocr-benchmark.md`):

| Idioma | Motor | CER médio | Latência/item |
|---|---|---|---|
| eng | Tesseract.js (atual) | 0.484 | 82 ms |
| eng | EasyOCR | 0.232 | 2190 ms |
| jpn horizontal | Tesseract.js jpn | 0.559 | 43 ms |
| jpn vertical | Tesseract.js jpn_vert | 0.000 | 41 ms |
| jpn (ambos) | **manga-ocr** | **0.000** | 976 ms (CPU) |

**Decisão**: nenhuma integração nesta rodada. Inglês (EasyOCR) não compensa —
custo de infra alto, sem caminho client-side. Japonês (`manga-ocr`) é o lever
real (zero erro nos dois estilos testados) — vira tema de uma próxima
`phase-research` dedicada a um caminho ONNX/sidecar, não implementação
ad-hoc aqui. Evidência registrada em `ocr-benchmark.md`.

## Passo 2 — Inpainting por difusão

**Mudança**: `src/client/ocr.ts` — `sampleColors` (extraído de
`flatBackground`, mesmo cálculo, comportamento idêntico), `diffusePixels`
(matemática pura, exportada para teste sem DOM) e `diffuseFill` (canvas).
`looseText` agora usa `diffuseFill` como fallback em vez de descartar o
bloco quando o fundo não é liso; `eraseBalloon` desenha `b.bgCanvas` quando
presente. `OcrBlock` ganhou o campo opcional `bgCanvas`.

**Drift registrado**: o plano previa achar um caso de "balão texturizado
renderizando mal"; a inspeção do código (`flatBackground`, comentário
original em `ocr.ts:501-506`) mostrou que esse caso já era **descartado de
propósito** (texto solto sobre arte nunca era traduzido, não "traduzido
malfeito"). O alvo real da melhoria é habilitar a tradução nesse caso, não
consertar uma renderização ruim — mesma direção do plano (heurística
barata), alvo mais preciso.

**Comando**: `bun test tests/ocr-inpaint.test.ts`
**Saída decisiva**:
```
 3 pass
 0 fail
 5 expect() calls
Ran 3 tests across 1 file. [74.00ms]
```

**Evidência visual**: `.workflow/5-competitive-quality/inpaint-before-after.png`
— recorte real de "LOOOOSERS!! WANNA-BE'S!" (Naruto cap. 1, texto solto sobre
arte, sem balão): topo = original, baixo = após `diffusePixels` apagar o
texto. Antes desta mudança esse bloco era descartado inteiro (texto original
em inglês permanecia, sem tradução); agora o fundo reconstruído permite
letreirar a tradução por cima.

## Passo 3 — Export/import de progresso

**Mudança**: `src/client/state.ts` — `exportStore()`/`importStore()`
(JSON versionado com `settings`/`favorites`/`progress`/`read`/`bookmarks`,
falha sem tocar no estado atual se malformado). `src/client/catalog.ts` —
botões "⭳ Backup" e "⭱ Importar" na barra de topo. `README.md` — seção
"Onde você parou" documenta o recurso.

**Comando**: `bun test tests/state-export.test.ts`
**Saída decisiva**:
```
 3 pass
 0 fail
 11 expect() calls
Ran 3 tests across 1 file. [49.00ms]
```

## Verificação final

**Comando**: `bun run check`
**Saída decisiva**:
```
$ oxlint --deny-warnings src scripts tests
$ tsc --noEmit
$ bun test tests
...
 130 pass
 0 fail
 248 expect() calls
Ran 130 tests across 15 files. [16.68s]
```
(124 testes pré-existentes + 6 novos: 3 em `ocr-inpaint.test.ts`, 3 em
`state-export.test.ts` — nenhum teste existente mudou de comportamento.)

`bun run build:client` — `client compilado (2 artefatos, 5 arquivos do
tesseract)`, sem erro.

## Escopo entregue vs. plano

- Passo 1 (spike): entregue como planejado — sem integração, com decisão
  registrada e evidência numérica.
- Passo 2 (inpainting): entregue, com o ajuste de alvo descrito acima
  (drift registrado, mesma direção do plano).
- Passo 3 (export/import): entregue como planejado.
- Passo 4 (fechamento): este arquivo + `README.md` atualizado.

## Arquivos alterados (produção)

```
README.md
src/client/catalog.ts
src/client/ocr.ts
src/client/state.ts
scripts/ocr-benchmark.mjs          (novo, spike)
scripts/ocr-benchmark-manga-ocr.py (novo, spike)
tests/ocr-inpaint.test.ts          (novo)
tests/state-export.test.ts         (novo)
```

Artefatos do spike (`.workflow/5-competitive-quality/{crops,crops-jp,
benchmark-pages,*.json,*.py,*.png,*.md}`) ficam fora de produção — não
listados para merge, servem de evidência da decisão.

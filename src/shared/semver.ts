/**
 * Comparacao de versao `X.Y.Z`. Fica em `shared/` porque servidor (que consulta a
 * release) e cliente (que decide se acabou de ser atualizado) usam a mesma regra —
 * e nenhum dos dois pode importar o outro (o do servidor puxa `build-info.json`).
 */

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function parseVersion(v: string): [number, number, number] | null {
  const m = SEMVER.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** >0 quando `a` e' mais nova que `b`; 0 se igual ou se algum nao for versao valida. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    const d = pa[i]! - pb[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

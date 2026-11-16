/**
 * Tema: "sistema" (segue o claro/escuro do SO) ou fixo. A escolha fixa fica em
 * `localStorage`; "sistema" e' a ausencia dela — o CSS so' ve `data-theme` quando
 * a pessoa escolheu, e sem ele cai no `prefers-color-scheme`.
 */
export type ThemeMode = 'system' | 'light' | 'dark';

const KEY = 'ml:theme';

export function getThemeMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = mode;
  try {
    if (mode === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    // modo privado: o tema vale so' nesta sessao
  }
}

/** Tema que esta' valendo agora (o do sistema, se nada foi escolhido). */
export const effectiveTheme = (): 'light' | 'dark' => {
  const set = document.documentElement.dataset['theme'];
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
};

export const toggleTheme = (): void => applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark');

import { humanizeError, removeGlossaryTerm, saveGlossaryTerm, seriesMemory, type GlossaryTerm } from './api.ts';
import { el, plural, toast } from './ui.ts';

const GENDERS: [GlossaryTerm['gender'], string][] = [
  ['?', 'sem genero'],
  ['m', 'masculino'],
  ['f', 'feminino'],
];

let open: HTMLElement | undefined;

/**
 * Glossario da obra, editavel. A memoria aprende nomes sozinha, e um erro de OCR
 * aprendido ("OCEMON FOX") se repetia no resto da obra — a unica saida era apagar
 * tudo. Aqui cada termo pode ser corrigido, removido ou criado a mao; termo
 * tocado por quem le fica fixado (🔒) e a IA nao o altera mais.
 *
 * `onChange` avisa o leitor: as traducoes em cache foram feitas com o glossario antigo.
 */
export function openGlossary(series: string, target: string, opts: { usesAi: boolean }, onChange: () => void): void {
  open?.remove();
  const previousFocus = document.activeElement as HTMLElement | null;
  let terms: GlossaryTerm[] = [];
  let dirty = false;

  const list = el('ul', { class: 'ml-gloss-list', 'aria-label': 'Termos do glossario' });
  const count = el('span', { class: 'ml-popover-hint', role: 'status' }, 'lendo o glossario...');
  const origIn = el('input', { class: 'ml-input', placeholder: 'no original (ex.: 九尾)', maxlength: '40', 'aria-label': 'Termo no original' });
  const ptIn = el('input', { class: 'ml-input', placeholder: 'na traducao (ex.: Kyuubi)', maxlength: '40', 'aria-label': 'Termo na traducao' });
  const genderIn = genderSelect('?');

  const close = (): void => {
    wrap.remove();
    open = undefined;
    previousFocus?.focus?.();
    if (dirty) onChange();
  };

  const refresh = async (): Promise<void> => {
    try {
      terms = (await seriesMemory(series, target)).glossary;
    } catch (err) {
      count.textContent = `glossario indisponivel: ${humanizeError(err)}`;
      return;
    }
    const locked = terms.filter((t) => t.locked).length;
    count.textContent = terms.length
      ? `${plural(terms.length, 'termo')} · ${locked ? `${plural(locked, 'fixado')} por voce` : 'todos aprendidos pela IA'}`
      : 'nenhum termo ainda — a IA aprende ao traduzir, ou adicione abaixo';
    // fixados primeiro: sao os que a pessoa veio conferir
    list.replaceChildren(...[...terms].sort((a, b) => Number(b.locked ?? false) - Number(a.locked ?? false)).map(row));
  };

  const save = async (term: { orig: string; pt: string; gender: string; was?: string }): Promise<boolean> => {
    if (!term.orig.trim() || !term.pt.trim()) {
      toast('preencha o termo no original e na traducao', 'error');
      return false;
    }
    try {
      await saveGlossaryTerm(series, target, term);
      dirty = true;
      await refresh();
      return true;
    } catch (err) {
      toast(`nao consegui salvar o termo: ${humanizeError(err)}`, 'error');
      return false;
    }
  };

  function genderSelect(value: string): HTMLSelectElement {
    const select = el('select', { class: 'ml-select ml-select-sm', 'aria-label': 'Genero' });
    for (const [id, label] of GENDERS) select.append(el('option', { value: id, selected: id === value }, label));
    return select;
  }

  function row(term: GlossaryTerm): HTMLElement {
    const pt = el('input', { class: 'ml-input', value: term.pt, maxlength: '40', 'aria-label': `Traducao de ${term.orig}` });
    const gender = genderSelect(term.gender);
    const commit = (): void => {
      if (pt.value.trim() === term.pt && gender.value === term.gender) return;
      void save({ orig: term.orig, pt: pt.value, gender: gender.value, was: term.orig });
    };
    pt.addEventListener('change', commit);
    gender.addEventListener('change', commit);
    return el(
      'li',
      { class: `ml-gloss-row ${term.locked ? 'is-locked' : ''}` },
      el('span', { class: 'ml-gloss-orig', title: term.locked ? 'fixado por voce: a IA nao altera' : 'aprendido pela IA — edite para fixar' }, term.locked ? '🔒 ' : '', term.orig),
      pt,
      gender,
      el(
        'button',
        {
          class: 'ml-btn ml-btn-sm ml-btn-ghost',
          type: 'button',
          title: `remover "${term.orig}" do glossario`,
          'aria-label': `Remover ${term.orig}`,
          onclick: () => {
            void removeGlossaryTerm(series, target, term.orig)
              .then(() => {
                dirty = true;
                return refresh();
              })
              .catch((err) => toast(`nao consegui remover: ${humanizeError(err)}`, 'error'));
          },
        },
        '✕',
      ),
    );
  }

  const add = el(
    'form',
    {
      class: 'ml-gloss-add',
      onsubmit: (e: Event) => {
        e.preventDefault();
        void save({ orig: origIn.value, pt: ptIn.value, gender: genderIn.value }).then((ok) => {
          if (!ok) return;
          origIn.value = '';
          ptIn.value = '';
          origIn.focus();
        });
      },
    },
    origIn,
    ptIn,
    genderIn,
    el('button', { class: 'ml-btn ml-btn-sm ml-btn-action-primary', type: 'submit' }, 'adicionar'),
  );

  const wrap = el(
    'div',
    {
      class: 'ml-pal-wrap ml-gloss-wrap',
      onkeydown: (e: KeyboardEvent) => {
        // o leitor por baixo tambem ouve teclas (t, o, setas): nada daqui pode vazar para ele
        e.stopPropagation();
        if (e.key === 'Escape') close();
      },
    },
    el('div', { class: 'ml-pal-scrim', onclick: close }),
    el(
      'div',
      { class: 'ml-pal ml-gloss', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Glossario de ${series}`, tabindex: '-1' },
      el(
        'header',
        { class: 'ml-gloss-head' },
        el('div', {}, el('h2', {}, 'Glossario da obra'), el('p', { class: 'ml-popover-hint' }, series)),
        el('button', { class: 'ml-btn ml-btn-ghost ml-btn-sm', type: 'button', onclick: close, 'aria-label': 'Fechar glossario' }, '✕'),
      ),
      el(
        'p',
        { class: 'ml-gloss-help' },
        'Nomes, lugares e termos que a traducao por IA usa sempre da mesma forma. Edite a traducao ou o genero de um termo para fixa-lo: termo fixado (🔒) a IA nao muda.',
      ),
      // os motores web traduzem frase a frase, sem contexto: avisar aqui evita a pessoa fixar termos e nao ver efeito
      opts.usesAi ? null : el('p', { class: 'ml-gloss-warn', role: 'note' }, 'O Tradutor Web (Google/MyMemory) nao usa glossario. Troque para o modo IA nas opcoes de traducao para os termos valerem.'),
      count,
      list,
      add,
    ),
  );
  open = wrap;
  document.body.append(wrap);
  origIn.focus();
  void refresh();
}

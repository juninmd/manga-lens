import { describe, expect, test } from 'bun:test';
import { realign } from '../src/server/align.ts';

// p57 do cap. 1 de Naruto: o 7B pulava "NOT YET!" e escorregava as falas seguintes
const page = [
  { id: 3, text: 'OID You GUYS FIND NARUTO!' },
  { id: 2, text: 'NOT YET!' },
  { id: 1, text: 'THIS IS AWFUL! WHAT ARE WE GOING TO DO..?!' },
  { id: 4, text: 'HE COULD BE MILES AWAY NOW!' },
];

describe('realign', () => {
  test('resposta alinhada passa intacta', () => {
    const items = [
      { id: 3, src: 'DID YOU GUYS', pt: 'Acharam o Naruto?' },
      { id: 2, src: 'NOT YET!', pt: 'Ainda nao!' },
    ];
    expect(realign(items, page)).toEqual([
      { id: 3, pt: 'Acharam o Naruto?' },
      { id: 2, pt: 'Ainda nao!' },
    ]);
  });

  test('fala escorregada para o balao vizinho volta para o dono; o pulado fica vazio', () => {
    const items = [
      { id: 2, src: 'THIS IS AWFUL', pt: 'Que horror! O que a gente faz?!' },
      { id: 1, src: 'HE COULD BE', pt: 'Ele pode estar longe!' },
    ];
    expect(realign(items, page)).toEqual([
      { id: 1, pt: 'Que horror! O que a gente faz?!' },
      { id: 4, pt: 'Ele pode estar longe!' },
    ]);
  });

  test('modelo que ignorou o eco (ou traduziu o src) nao perde a traducao', () => {
    const items = [
      { id: 2, src: 'AINDA NAO', pt: 'Ainda nao!' },
      { id: 1, pt: 'Que horror!' },
    ];
    expect(realign(items, page)).toEqual([
      { id: 2, pt: 'Ainda nao!' },
      { id: 1, pt: 'Que horror!' },
    ]);
  });

  test('dois itens disputando o mesmo balao: vale o dono, o duplicado cai', () => {
    const items = [
      { id: 1, src: 'THIS IS AWFUL', pt: 'certo' },
      { id: 2, src: 'THIS IS AWFUL', pt: 'duplicado' },
    ];
    expect(realign(items, page)).toEqual([{ id: 1, pt: 'certo' }]);
  });

  test('exclamacao repetida na pagina: eco ambiguo entre textos iguais vai para o livre', () => {
    const blocks = [
      { id: 0, text: 'WHAT?!' },
      { id: 1, text: 'NOT YET!' },
      { id: 2, text: 'WHAT?!' },
    ];
    const items = [
      { id: 0, src: 'WHAT', pt: 'O que?!' },
      { id: 1, src: 'WHAT', pt: 'O que?!' },
    ];
    expect(realign(items, blocks)).toEqual([
      { id: 0, pt: 'O que?!' },
      { id: 2, pt: 'O que?!' },
    ]);
  });

  test('eco ambiguo entre textos diferentes nao chuta: balao vazio e melhor que fala errada', () => {
    const blocks = [
      { id: 0, text: 'NOTHING HERE' },
      { id: 1, text: 'WAIT!' },
      { id: 2, text: 'NOT NOW' },
    ];
    expect(realign([{ id: 1, src: 'NO', pt: 'Nao' }], blocks)).toEqual([]);
  });

  test('japones: eco casa pelo inicio do texto, sem depender de espaco', () => {
    const jp = [
      { id: 0, text: 'まだだ！' },
      { id: 1, text: 'どうしよう…大変だ！' },
    ];
    expect(realign([{ id: 0, src: 'どうしよう', pt: 'E agora?!' }], jp)).toEqual([{ id: 1, pt: 'E agora?!' }]);
  });
});

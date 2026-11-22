import { expect, test } from 'bun:test';
import { createLimiter } from '../src/server/translators.ts';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

// Quem chega entre o release e o despertar da fila nao pode furar o teto global.
test('slot liberado vai para quem esperava, sem passar do teto', async () => {
  const limiter = createLimiter(1);
  await limiter.acquire();
  let waiterIn = false;
  let bargerIn = false;
  const waiter = limiter.acquire().then(() => { waiterIn = true; });
  limiter.release();
  const barger = limiter.acquire().then(() => { bargerIn = true; });
  await flush();

  expect(limiter.active()).toBe(1);
  expect(waiterIn).toBe(true);
  expect(bargerIn).toBe(false);

  limiter.release();
  await Promise.all([waiter, barger]);
  expect(bargerIn).toBe(true);
  limiter.release();
  expect(limiter.active()).toBe(0);
});

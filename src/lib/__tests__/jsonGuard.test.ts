import { describe, it, expect } from 'vitest';
import { assertBoundedJson } from '../jsonGuard.js';

describe('assertBoundedJson', () => {
  it('aceita objetos rasos dentro dos limites', () => {
    expect(() => assertBoundedJson({ a: 1, b: 2 }, { maxDepth: 5, maxEntries: 200 })).not.toThrow();
  });

  it('rejeita profundidade acima do limite', () => {
    let deep: any = {};
    let cur = deep;
    for (let i = 0; i < 10; i++) {
      cur.child = {};
      cur = cur.child;
    }
    expect(() => assertBoundedJson(deep, { maxDepth: 5, maxEntries: 200 })).toThrow(/profundidade/);
  });

  it('rejeita número de campos acima do limite', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 300; i++) wide[`k${i}`] = i;
    expect(() => assertBoundedJson(wide, { maxDepth: 5, maxEntries: 200 })).toThrow(/campos/);
  });

  it('aceita arrays dentro dos limites e conta seus elementos', () => {
    expect(() => assertBoundedJson([1, 2, 3], { maxDepth: 5, maxEntries: 200 })).not.toThrow();
  });

  it('não estoura a pilha para estruturas muito profundas (guard iterativo)', () => {
    let deep: any = {};
    let cur = deep;
    for (let i = 0; i < 50000; i++) {
      cur.child = {};
      cur = cur.child;
    }
    expect(() => assertBoundedJson(deep, { maxDepth: 5, maxEntries: 200 })).toThrow(/profundidade/);
  });
});

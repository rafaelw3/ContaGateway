import { describe, it, expect } from 'vitest';
import { apiKeyMatches, parseApiKeys } from '../apiKeys.js';

describe('parseApiKeys', () => {
  it('uma chave (formato de sempre)', () => {
    expect(parseApiKeys('cgw_live_abc')).toEqual(['cgw_live_abc']);
  });

  it('várias chaves separadas por vírgula, sem espaços nem entradas vazias', () => {
    expect(parseApiKeys(' nova , antiga ,, ')).toEqual(['nova', 'antiga']);
  });

  it('ausente ou só vírgulas → lista vazia', () => {
    expect(parseApiKeys(undefined)).toEqual([]);
    expect(parseApiKeys(' , ,')).toEqual([]);
  });
});

describe('apiKeyMatches', () => {
  const keys = ['nova', 'antiga'];

  it('aceita qualquer uma das chaves da lista', () => {
    expect(apiKeyMatches('nova', keys)).toBe(true);
    expect(apiKeyMatches('antiga', keys)).toBe(true);
  });

  it('recusa chave fora da lista, a lista inteira como string e prefixo de chave válida', () => {
    expect(apiKeyMatches('outra', keys)).toBe(false);
    expect(apiKeyMatches('nova,antiga', keys)).toBe(false);
    expect(apiKeyMatches('nov', keys)).toBe(false);
  });

  it('lista vazia nunca casa (falha fechada)', () => {
    expect(apiKeyMatches('', [])).toBe(false);
    expect(apiKeyMatches('qualquer', [])).toBe(false);
  });
});

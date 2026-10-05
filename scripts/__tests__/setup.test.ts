import { describe, it, expect } from 'vitest';
import { isValidWallet, generateSecret, setVar } from '../setup.js';

describe('setup wizard — validação de wallet', () => {
  it('aceita um endereço Ethereum válido de 40 hex chars', () => {
    expect(isValidWallet('0x1234567890123456789012345678901234567890')).toBe(true);
  });

  it('rejeita o endereço zero', () => {
    expect(isValidWallet('0x0000000000000000000000000000000000000000')).toBe(false);
  });

  it('rejeita endereços com tamanho errado', () => {
    expect(isValidWallet('0x1234')).toBe(false);
  });

  it('rejeita valores sem o prefixo 0x', () => {
    expect(isValidWallet('A2759bB5EC901dB148495020753bbF99762dCaEc')).toBe(false);
  });

  it('rejeita string vazia', () => {
    expect(isValidWallet('')).toBe(false);
  });
});

describe('setup wizard — geração de segredos', () => {
  it('gera segredos com o prefixo esperado e alta entropia', () => {
    const a = generateSecret('cgw_live');
    const b = generateSecret('cgw_live');
    expect(a.startsWith('cgw_live_')).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(40);
  });
});

describe('setup wizard — templating do .env', () => {
  const template = 'FOO="bar"\nBAZ=\n# comentário\nQUX="valor"\n';

  it('substitui uma variável existente preservando o resto do template', () => {
    const result = setVar(template, 'FOO', 'novo-valor');
    expect(result).toContain('FOO="novo-valor"');
    expect(result).toContain('QUX="valor"');
    expect(result).toContain('# comentário');
  });

  it('preenche uma variável que estava vazia', () => {
    const result = setVar(template, 'BAZ', 'preenchido');
    expect(result).toContain('BAZ="preenchido"');
  });

  it('adiciona a variável ao final se ela não existir no template', () => {
    const result = setVar(template, 'NOVA_VAR', 'valor');
    expect(result).toContain('NOVA_VAR="valor"');
  });

  it('não duplica a variável quando já existe', () => {
    const result = setVar(template, 'FOO', 'x');
    const matches = result.match(/^FOO=/gm) ?? [];
    expect(matches.length).toBe(1);
  });
});

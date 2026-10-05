import { describe, it, expect } from 'vitest';
import {
  parseAmountToCents,
  isAmountParseFailure,
  formatCentsAsAmount,
  centsFromStoredAmount,
  MAX_PAYMENT_AMOUNT,
  MAX_PAYMENT_AMOUNT_CENTS,
} from '../paymentValidation.js';

/**
 * O valor da cobrança é a única coisa que o pagador realmente paga. Estes
 * testes fixam a regra de que o gateway nunca "ajusta" um valor por conta
 * própria: ou converte exato para centavos, ou recusa com 400.
 */

function centsOf(input: { amount?: unknown; amountCents?: unknown }): number | string {
  const result = parseAmountToCents(input);
  return isAmountParseFailure(result) ? result.error : result.cents;
}

describe('parseAmountToCents', () => {
  it('converte reais para centavos de forma exata', () => {
    expect(centsOf({ amount: '10.50' })).toBe(1050);
    expect(centsOf({ amount: 10.5 })).toBe(1050);
    expect(centsOf({ amount: '1' })).toBe(100);
    expect(centsOf({ amount: 1 })).toBe(100);
    expect(centsOf({ amount: '0.01' })).toBe(1);
    expect(centsOf({ amount: '1.5' })).toBe(150);
  });

  it('aceita centavos inteiros direto (a unidade da conta.vc)', () => {
    expect(centsOf({ amountCents: 1050 })).toBe(1050);
    expect(centsOf({ amountCents: '1050' })).toBe(1050);
    expect(centsOf({ amountCents: 1 })).toBe(1);
  });

  // O bug que motivou este módulo: Math.round(Number(amount) * 100) cobrava
  // um valor diferente do pedido, sem erro nenhum.
  it('recusa mais de 2 casas decimais em vez de arredondar o valor cobrado', () => {
    for (const amount of ['10.555', '1.004', '1.005', '0.4999', '0.001']) {
      const result = parseAmountToCents({ amount });
      expect(isAmountParseFailure(result), `deveria recusar ${amount}`).toBe(true);
    }
  });

  it('nunca arredonda um valor para zero centavo', () => {
    expect(isAmountParseFailure(parseAmountToCents({ amount: '0.001' }))).toBe(true);
    expect(isAmountParseFailure(parseAmountToCents({ amount: '0' }))).toBe(true);
    expect(isAmountParseFailure(parseAmountToCents({ amount: '0.00' }))).toBe(true);
    expect(isAmountParseFailure(parseAmountToCents({ amountCents: 0 }))).toBe(true);
  });

  it('recusa valor ausente', () => {
    expect(isAmountParseFailure(parseAmountToCents({}))).toBe(true);
    expect(isAmountParseFailure(parseAmountToCents({ amount: undefined }))).toBe(true);
    expect(isAmountParseFailure(parseAmountToCents({ amount: null }))).toBe(true);
    expect(isAmountParseFailure(parseAmountToCents({ amount: '' }))).toBe(true);
  });

  it('recusa amount e amountCents juntos: não há como saber qual cobrar', () => {
    const result = parseAmountToCents({ amount: '10.50', amountCents: 999 });
    expect(isAmountParseFailure(result)).toBe(true);
  });

  it('recusa negativos, não-numéricos e notação científica', () => {
    for (const amount of ['-5', -5, 'abc', '1e3', 1e3 + 0.001, Infinity, NaN, '0x10', ' ', '1,50', true]) {
      const result = parseAmountToCents({ amount });
      expect(isAmountParseFailure(result), `deveria recusar ${String(amount)}`).toBe(true);
    }
    expect(isAmountParseFailure(parseAmountToCents({ amountCents: 10.5 }))).toBe(true);
    expect(isAmountParseFailure(parseAmountToCents({ amountCents: '10.5' }))).toBe(true);
    expect(isAmountParseFailure(parseAmountToCents({ amountCents: -1 }))).toBe(true);
  });

  it('respeita o teto de negócio nas duas unidades', () => {
    expect(centsOf({ amount: String(MAX_PAYMENT_AMOUNT) })).toBe(MAX_PAYMENT_AMOUNT_CENTS);
    expect(isAmountParseFailure(parseAmountToCents({ amount: String(MAX_PAYMENT_AMOUNT + 1) }))).toBe(true);
    expect(centsOf({ amountCents: MAX_PAYMENT_AMOUNT_CENTS })).toBe(MAX_PAYMENT_AMOUNT_CENTS);
    expect(isAmountParseFailure(parseAmountToCents({ amountCents: MAX_PAYMENT_AMOUNT_CENTS + 1 }))).toBe(true);
  });

  it('a mensagem de erro aponta o caminho sem ambiguidade (amountCents)', () => {
    const result = parseAmountToCents({ amount: '10.555' });
    expect(isAmountParseFailure(result)).toBe(true);
    if (isAmountParseFailure(result)) {
      expect(result.error).toContain('amountCents');
      expect(result.error).toContain('2 casas decimais');
    }
  });
});

describe('formatCentsAsAmount', () => {
  it('sempre devolve 2 casas decimais', () => {
    expect(formatCentsAsAmount(100)).toBe('1.00');
    expect(formatCentsAsAmount(1050)).toBe('10.50');
    expect(formatCentsAsAmount(1)).toBe('0.01');
    expect(formatCentsAsAmount(10)).toBe('0.10');
    expect(formatCentsAsAmount(MAX_PAYMENT_AMOUNT_CENTS)).toBe(`${MAX_PAYMENT_AMOUNT}.00`);
  });

  it('é o inverso exato de parseAmountToCents', () => {
    for (const cents of [1, 10, 99, 100, 101, 1050, 123456]) {
      expect(centsOf({ amount: formatCentsAsAmount(cents) })).toBe(cents);
    }
  });
});

describe('centsFromStoredAmount', () => {
  // O Decimal do Prisma descarta zero à direita: a coluna guarda "1.00" e o
  // toString() devolve "1". Ler isso com float reintroduziria o bug.
  it('lê os centavos mesmo quando o Decimal corta o zero à direita', () => {
    expect(centsFromStoredAmount('1')).toBe(100);
    expect(centsFromStoredAmount('1.00')).toBe(100);
    expect(centsFromStoredAmount('10.5')).toBe(1050);
    expect(centsFromStoredAmount('10.50')).toBe(1050);
    expect(centsFromStoredAmount('0.01')).toBe(1);
  });

  it('aceita qualquer objeto com toString (o Decimal do Prisma)', () => {
    expect(centsFromStoredAmount({ toString: () => '7.07' })).toBe(707);
  });
});

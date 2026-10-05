import { describe, it, expect } from 'vitest';
import { crc16Ccitt, inspectPixEmv, parseEmvTlv } from '../pixEmv.js';
import { buildPixEmv } from '../../services/__tests__/fixtures/contaVcFake.js';

// Exemplo oficial do Manual de Padrões para Iniciação do Pix (BCB), com o CRC
// publicado no próprio manual — âncora independente da nossa implementação.
const BCB_EXAMPLE =
  '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';

describe('crc16Ccitt', () => {
  it('bate com o valor de referência do CRC-16/CCITT-FALSE ("123456789" → 29B1)', () => {
    expect(crc16Ccitt('123456789')).toBe('29B1');
  });

  it('bate com o CRC do exemplo oficial do BCB', () => {
    expect(crc16Ccitt(BCB_EXAMPLE.slice(0, -4))).toBe('1D3D');
  });
});

describe('parseEmvTlv', () => {
  it('separa os campos de primeiro nível', () => {
    const fields = parseEmvTlv(BCB_EXAMPLE);
    expect(fields?.get('00')).toBe('01');
    expect(fields?.get('58')).toBe('BR');
    expect(fields?.get('63')).toBe('1D3D');
  });

  it('devolve null quando o tamanho declarado passa do fim', () => {
    expect(parseEmvTlv('000201' + '5999AB')).toBeNull();
  });
});

describe('inspectPixEmv', () => {
  it('aceita o exemplo oficial do BCB (sem valor fixo)', () => {
    expect(inspectPixEmv(BCB_EXAMPLE)).toEqual({ problem: null, amountCents: null });
  });

  it('extrai o valor do campo 54 em centavos', () => {
    expect(inspectPixEmv(buildPixEmv(1050))).toEqual({ problem: null, amountCents: 1050 });
    expect(inspectPixEmv(buildPixEmv(1))).toEqual({ problem: null, amountCents: 1 });
  });

  it('tolera espaço/quebra de linha nas pontas', () => {
    expect(inspectPixEmv(`  ${buildPixEmv(500)}\n`).problem).toBeNull();
  });

  it('rejeita CRC errado', () => {
    expect(inspectPixEmv(BCB_EXAMPLE.slice(0, -4) + 'FFFF').problem).toMatch(/CRC inválido/);
  });

  it('rejeita payload que não começa com 000201', () => {
    expect(inspectPixEmv('https://app.conta.vc/pay/abc').problem).toMatch(/000201/);
  });

  it('rejeita BR Code sem conta Pix (GUI br.gov.bcb.pix)', () => {
    const body = '000201' + '26180014br.gov.bcb.xyz' + '5802BR' + '6304';
    expect(inspectPixEmv(body + crc16Ccitt(body)).problem).toMatch(/br\.gov\.bcb\.pix/);
  });

  it('rejeita CRC fora da última posição', () => {
    expect(inspectPixEmv(BCB_EXAMPLE + '5802BR').problem).toMatch(/CRC/);
  });
});

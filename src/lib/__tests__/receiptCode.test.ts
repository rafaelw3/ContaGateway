import { describe, it, expect } from 'vitest';
import { generateReceiptCode } from '../receiptCode.js';

describe('generateReceiptCode', () => {
  it('gera um código no formato XXXX-XXXX', () => {
    const code = generateReceiptCode();
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('nunca usa caracteres ambíguos (0, O, 1, I, L)', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateReceiptCode();
      expect(code).not.toMatch(/[0O1IL]/);
    }
  });

  it('gera valores diferentes em chamadas sucessivas (alta entropia)', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateReceiptCode()));
    expect(codes.size).toBe(200);
  });
});

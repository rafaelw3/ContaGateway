import { randomInt } from 'node:crypto';

// Alfabeto sem caracteres ambíguos (sem 0/O, 1/I/L) — pensado pra ser lido em
// voz alta ou digitado num formulário de suporte, ao contrário do `id` interno
// (cuid), que é opaco e serve só de chave técnica.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUP_SIZE = 4;
const GROUPS = 2;

/**
 * Gera um código de confirmação curto e legível pro pagador final (ex:
 * "K7X9-2B3F") — nunca expõe detalhes técnicos como transactionHash. Não é
 * garantidamente único por si só; o chamador deve tratar colisão via
 * constraint única no banco (ver PaymentService.createPayment).
 */
export function generateReceiptCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let group = '';
    for (let i = 0; i < GROUP_SIZE; i++) {
      group += ALPHABET[randomInt(ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

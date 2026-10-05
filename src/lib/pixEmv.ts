/**
 * Leitura estrutural de um "Pix Copia e Cola" (BR Code, padrão EMV-MPM do
 * Banco Central). Não é validação de negócio — só responde "isto é um Pix
 * bem formado, e que valor ele cobra?". Usado para detectar mudança no
 * endpoint interno da conta.vc (ver ARCHITECTURE.md seção 1): se ele passar a
 * devolver algo que não é um BR Code válido, ou um BR Code com valor
 * diferente do pedido, o pagador receberia um QR impagável ou com o valor
 * errado — e a liquidação por valor exato nunca casaria.
 *
 * Formato: sequência de campos TLV — ID (2 dígitos) + tamanho (2 dígitos) +
 * valor. O último campo é sempre o "63" (CRC16-CCITT, 4 hex), calculado sobre
 * todo o payload até "6304" inclusive.
 */

const PIX_GUI = 'br.gov.bcb.pix';

/** CRC16-CCITT-FALSE (polinômio 0x1021, valor inicial 0xFFFF), exigido pelo BR Code. */
export function crc16Ccitt(input: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(input, 'utf8')) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Separa um bloco TLV em pares id → valor. Devolve null se a estrutura não
 * fecha (tamanho declarado passa do fim, id não-numérico etc.).
 */
export function parseEmvTlv(payload: string): Map<string, string> | null {
  const fields = new Map<string, string>();
  let i = 0;

  while (i < payload.length) {
    const id = payload.slice(i, i + 2);
    const lengthRaw = payload.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(lengthRaw)) return null;

    const length = Number(lengthRaw);
    const valueStart = i + 4;
    const valueEnd = valueStart + length;
    if (valueEnd > payload.length) return null;

    fields.set(id, payload.slice(valueStart, valueEnd));
    i = valueEnd;
  }

  return fields;
}

export interface PixEmvInspection {
  /** Motivo pelo qual o payload não é um BR Code Pix utilizável; null se é válido. */
  problem: string | null;
  /** Valor em centavos declarado no campo 54, ou null se o QR não fixa valor. */
  amountCents: number | null;
}

/**
 * Checa se `emv` é um BR Code Pix estruturalmente válido e extrai o valor
 * (campo 54) quando presente. QR dinâmico pode omitir o campo 54 — isso não é
 * erro; quem chama decide o que fazer com `amountCents: null`.
 */
export function inspectPixEmv(emv: string): PixEmvInspection {
  const payload = emv.trim();
  const fail = (problem: string): PixEmvInspection => ({ problem, amountCents: null });

  if (!payload.startsWith('000201')) {
    return fail('não começa com o indicador de formato "000201"');
  }

  const fields = parseEmvTlv(payload);
  if (!fields) {
    return fail('estrutura TLV inválida');
  }

  const crcField = fields.get('63');
  if (!crcField || !payload.endsWith(`6304${crcField}`)) {
    return fail('campo CRC (63) ausente ou fora da última posição');
  }

  const expectedCrc = crc16Ccitt(payload.slice(0, -4));
  if (crcField.toUpperCase() !== expectedCrc) {
    return fail(`CRC inválido (recebido ${crcField}, calculado ${expectedCrc})`);
  }

  // Merchant Account Information do Pix vive em algum id entre 26 e 51, com o
  // subcampo 00 igual ao GUI do arranjo Pix.
  let hasPixAccount = false;
  for (let id = 26; id <= 51; id++) {
    const value = fields.get(String(id));
    const sub = value ? parseEmvTlv(value) : null;
    if (sub?.get('00')?.toLowerCase() === PIX_GUI) {
      hasPixAccount = true;
      break;
    }
  }
  if (!hasPixAccount) {
    return fail(`nenhum campo de conta com o GUI "${PIX_GUI}"`);
  }

  const amountRaw = fields.get('54');
  if (amountRaw === undefined) {
    return { problem: null, amountCents: null };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(amountRaw)) {
    return fail(`campo de valor (54) com formato inesperado: "${amountRaw}"`);
  }

  return { problem: null, amountCents: Math.round(Number(amountRaw) * 100) };
}

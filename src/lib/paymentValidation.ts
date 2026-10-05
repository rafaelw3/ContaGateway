export const MAX_PAYMENT_AMOUNT = Number(process.env.MAX_PAYMENT_AMOUNT) || 1_000_000;
export const MAX_PAYMENT_AMOUNT_CENTS = Math.round(MAX_PAYMENT_AMOUNT * 100);

/**
 * Centavo é a unidade canônica deste gateway, não o real decimal.
 *
 * A conta.vc contabiliza tudo em centavos inteiros (`amountCents`), o EMV do
 * Pix carrega o valor já formatado com 2 casas, e o Web3Listener casa mint com
 * cobrança comparando o valor exato. Em nenhum desses lugares existe espaço
 * para "R$ 10,555". Antes, a entrada era convertida com
 * `Math.round(Number(amount) * 100)`, o que silenciosamente alterava o valor
 * cobrado: "10.555" virava 1056 centavos (MAIS do que o integrador pediu),
 * "1.004" virava 100 (menos) e "0.001" virava 0 (cobrança de valor zero
 * enviada ao provedor). Erro de centavo em gateway de pagamento não se
 * arredonda: se recusa.
 *
 * Por isso a conversão aqui é feita sobre a STRING, com aritmética inteira —
 * nunca passando por float.
 */

/** Formato aceito em `amount`: dígitos, com no máximo 2 casas decimais. */
const AMOUNT_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;
/** Formato aceito em `amountCents`: inteiro em dígitos, sem sinal nem ponto. */
const CENTS_PATTERN = /^\d+$/;

export interface AmountParseSuccess {
  cents: number;
}

export interface AmountParseFailure {
  error: string;
}

export type AmountParseResult = AmountParseSuccess | AmountParseFailure;

export function isAmountParseFailure(result: AmountParseResult): result is AmountParseFailure {
  return 'error' in result;
}

/**
 * Converte um valor em BRL (`amount`) ou em centavos (`amountCents`) para
 * centavos inteiros. Exatamente um dos dois precisa vir preenchido.
 *
 * `amountCents` é o caminho preferido para integradores: é a unidade da
 * conta.vc e não tem ambiguidade de arredondamento. `amount` continua aceito
 * por conveniência, mas com regra estrita — no máximo 2 casas decimais.
 */
export function parseAmountToCents(input: { amount?: unknown; amountCents?: unknown }): AmountParseResult {
  const hasAmount = input.amount !== undefined && input.amount !== null && input.amount !== '';
  const hasCents = input.amountCents !== undefined && input.amountCents !== null && (input.amountCents as unknown) !== '';

  if (hasAmount && hasCents) {
    return {
      error:
        'Envie "amount" (reais, ex: "10.50") OU "amountCents" (centavos inteiros, ex: 1050), nunca os dois — ' +
        'com os dois preenchidos não há como saber qual valor cobrar.',
    };
  }

  if (!hasAmount && !hasCents) {
    return {
      error:
        'É obrigatório informar o valor da cobrança: "amount" em reais (ex: "10.50", no máximo 2 casas decimais) ' +
        'ou "amountCents" em centavos inteiros (ex: 1050).',
    };
  }

  const cents = hasCents ? centsFromCentsInput(input.amountCents) : centsFromAmountInput(input.amount);

  if (cents === null) {
    return hasCents
      ? {
          error:
            '"amountCents" deve ser um número inteiro de centavos, positivo e não superior a ' +
            `${MAX_PAYMENT_AMOUNT_CENTS} (R$ ${MAX_PAYMENT_AMOUNT}). Valor recebido: ${String(input.amountCents)}.`,
        }
      : {
          error:
            '"amount" deve ser um valor em reais positivo, com no máximo 2 casas decimais (ex: "10.50") e não ' +
            `superior a ${MAX_PAYMENT_AMOUNT}. Valor recebido: ${String(input.amount)}. ` +
            'Mais de 2 casas decimais é recusado de propósito: arredondar mudaria o valor cobrado sem o integrador saber. ' +
            'Para evitar qualquer ambiguidade, prefira enviar "amountCents" em centavos inteiros.',
        };
  }

  return { cents };
}

function centsFromCentsInput(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) return null;
    return withinRange(raw);
  }

  if (typeof raw !== 'string' || !CENTS_PATTERN.test(raw.trim())) return null;

  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed)) return null;
  return withinRange(parsed);
}

function centsFromAmountInput(raw: unknown): number | null {
  // `Number` não entra nessa conta: a string é a fonte da verdade. Para um
  // number vindo do JSON, serializamos de volta e exigimos o mesmo formato, o
  // que recusa notação científica (1e3) e precisão sub-centavo (1.004).
  let text: string;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    text = String(raw);
  } else if (typeof raw === 'string') {
    text = raw.trim();
  } else {
    return null;
  }

  const match = AMOUNT_PATTERN.exec(text);
  if (!match) return null;

  const [, wholePart, fractionPart = ''] = match;
  const centsFraction = fractionPart.padEnd(2, '0');

  const whole = Number(wholePart);
  if (!Number.isSafeInteger(whole)) return null;

  const cents = whole * 100 + Number(centsFraction);
  if (!Number.isSafeInteger(cents)) return null;
  return withinRange(cents);
}

function withinRange(cents: number): number | null {
  if (cents <= 0 || cents > MAX_PAYMENT_AMOUNT_CENTS) return null;
  return cents;
}

/**
 * Formata centavos inteiros como string de reais com 2 casas fixas ("1.00").
 * Usa aritmética inteira porque é também o formato gravado na coluna `amount`
 * e comparado pelo Web3Listener — um "1" em vez de "1.00" quebraria o casamento.
 */
export function formatCentsAsAmount(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const fraction = Math.abs(cents % 100);
  return `${whole}.${String(fraction).padStart(2, '0')}`;
}

/**
 * Lê de volta os centavos de um valor já gravado na coluna `amount`.
 *
 * O `Decimal` do Prisma descarta zero à direita no `toString()` ("1.00" volta
 * como "1"), então converter com float aqui reintroduziria exatamente o erro
 * que `parseAmountToCents` evita na entrada. A coluna só recebe valores
 * escritos por `formatCentsAsAmount`, logo o formato é sempre dígitos com até
 * 2 casas.
 */
export function centsFromStoredAmount(stored: { toString(): string }): number {
  const text = stored.toString().trim();
  const match = AMOUNT_PATTERN.exec(text);

  if (!match) {
    // Linha fora do formato esperado (escrita à mão no banco, por exemplo):
    // cai no caminho antigo em vez de derrubar a requisição.
    return Math.round(Number(text) * 100);
  }

  const [, wholePart, fractionPart = ''] = match;
  return Number(wholePart) * 100 + Number(fractionPart.padEnd(2, '0'));
}

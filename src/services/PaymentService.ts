import axios, { AxiosError } from 'axios';
import { prisma, type Payment, type Prisma } from '../lib/prisma.js';
import {
  parseAmountToCents,
  isAmountParseFailure,
  formatCentsAsAmount,
  centsFromStoredAmount,
} from '../lib/paymentValidation.js';
import { generateReceiptCode } from '../lib/receiptCode.js';
import { logger } from '../lib/logger.js';
import { ContaVcContractDriftError, reportContractDrift } from '../lib/contractGuard.js';
import { inspectPixEmv } from '../lib/pixEmv.js';

const KNOWN_INTENT_STATUSES = new Set(['pending', 'done', 'failed', 'expired']);

const RECEIPT_CODE_MAX_ATTEMPTS = 5;

/**
 * A mesma `Idempotency-Key` foi reenviada com um valor diferente da cobrança
 * que ela já identifica. Devolver a cobrança antiga em silêncio faria o
 * integrador mostrar ao pagador um QR de outro valor sem nenhum sinal; criar
 * uma nova quebraria a promessa da chave. A única resposta segura é recusar.
 */
export class IdempotencyConflictError extends Error {
  constructor(
    public readonly existingAmountCents: number,
    public readonly requestedAmountCents: number
  ) {
    super(
      `Idempotency-Key já usada para uma cobrança de ${(existingAmountCents / 100).toFixed(2)}; ` +
        `reenvio pediu ${(requestedAmountCents / 100).toFixed(2)}. Use uma chave nova para um valor diferente.`
    );
    this.name = 'IdempotencyConflictError';
  }
}

export interface CreatePaymentInput {
  /** Valor em reais, no máximo 2 casas decimais. Exclusivo com `amountCents`. */
  amount?: number | string;
  /** Valor em centavos inteiros — a unidade da conta.vc. Exclusivo com `amount`. */
  amountCents?: number | string;
  message?: string;
  metadata?: Prisma.InputJsonValue;
  webhookUrl?: string;
  idempotencyKey?: string;
}

export class PaymentService {
  private readonly defaultUsername: string;
  private readonly intentUrl = process.env.CONTA_VC_INTENT_URL || 'https://app.conta.vc/api/pay/intent';

  constructor() {
    const configuredHandle = process.env.CONTA_VC_USERNAME?.trim();
    if (!configuredHandle) {
      throw new Error(
        'CONTA_VC_USERNAME não está configurado. É o handle da conta.vc que recebe as cobranças Pix — ' +
          'sem ele não é possível gerar cobranças. Defina no .env (veja README, seção "Como Iniciar").'
      );
    }
    this.defaultUsername = configuredHandle;
  }

  /**
   * Forja a requisição para o endpoint /api/pay/intent da conta.vc simulando um navegador real,
   * extrai o código Pix Copia e Cola (EMV) e persiste no banco via Prisma.
   */
  async createPayment(input: CreatePaymentInput): Promise<Payment> {
    // A API do conta.vc espera o valor em centavos como número inteiro (ex:
    // R$ 1,50 -> 150). A conversão é exata e recusa precisão sub-centavo em
    // vez de arredondar — ver src/lib/paymentValidation.ts.
    const parsedAmount = parseAmountToCents(input);
    if (isAmountParseFailure(parsedAmount)) {
      throw new Error(`Valor de pagamento inválido: ${parsedAmount.error}`);
    }

    const amountCents = parsedAmount.cents;

    // Idempotência: se o chamador reenviar a mesma idempotencyKey (retry de rede,
    // duplo clique), devolve a cobrança já existente em vez de gerar outra cobrança
    // Pix real na conta.vc — desde que o valor seja o mesmo (ver
    // assertSameAmount).
    if (input.idempotencyKey) {
      const existing = await prisma.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) {
        return this.assertSameAmount(existing, amountCents);
      }
    }

    // Garantido pelo construtor: o serviço não é instanciado sem handle configurado.
    const username = this.defaultUsername;

    const truncatedMessage = input.message ? input.message.slice(0, 140) : undefined;

    const refererUrl = `https://app.conta.vc/pay/${encodeURIComponent(username)}`;

    // Headers defensivos simulando um navegador moderno (Chromium/Windows)
    const browserHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'Content-Type': 'application/json',
      'Origin': 'https://app.conta.vc',
      'Referer': refererUrl,
      'Sec-Ch-Ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'Priority': 'u=1, i',
    };

    const payload = {
      handle: username,
      amountCents,
      message: truncatedMessage,
    };

    interface IntentResponse {
      qrId: string;
      emv: string;
      amountCents: number;
      expiresAt: string;
    }

    let intentData: IntentResponse;

    try {
      const response = await axios.post<IntentResponse>(
        this.intentUrl,
        payload,
        {
          headers: browserHeaders,
          timeout: 15000,
          validateStatus: (status) => status >= 200 && status < 400,
        }
      );

      intentData = this.validateIntentResponse(response.data, amountCents);
    } catch (error) {
      if (error instanceof ContaVcContractDriftError) {
        reportContractDrift('createPayment', { username, amountCents, ...error.details });
        throw error;
      }
      if (axios.isAxiosError(error)) {
        const axiosErr = error as AxiosError;
        const statusCode = axiosErr.response?.status ?? 'SEM_STATUS';
        const responseData = JSON.stringify(axiosErr.response?.data || '').slice(0, 300);
        throw new Error(
          `Falha ao forjar requisição para conta.vc [Status ${statusCode}]: ${axiosErr.message}. Resposta: ${responseData}`
        );
      }
      throw new Error(`Erro inesperado ao gerar cobrança Pix: ${(error as Error).message}`);
    }

    // Mescla o metadata do usuário com os dados do QR code da conta.vc
    const mergedMetadata = {
      ...(typeof input.metadata === 'object' && input.metadata !== null ? (input.metadata as Record<string, unknown>) : {}),
      contaVcQrId: intentData.qrId,
      contaVcHandle: username,
      amountCents: intentData.amountCents,
      message: truncatedMessage,
    };

    // receiptCode é gerado aqui (não vem da conta.vc) — colisão é raríssima
    // (32^8 combinações), mas como é chave única, tenta de novo em vez de
    // falhar a cobrança inteira por causa disso.
    for (let attempt = 1; attempt <= RECEIPT_CODE_MAX_ATTEMPTS; attempt++) {
      try {
        const payment = await prisma.payment.create({
          data: {
            amount: formatCentsAsAmount(amountCents),
            status: 'PENDING',
            pixPayload: intentData.emv.trim(),
            qrId: intentData.qrId,
            receiptCode: generateReceiptCode(),
            idempotencyKey: input.idempotencyKey || null,
            expiresAt: new Date(intentData.expiresAt),
            metadata: JSON.stringify(mergedMetadata),
            webhookUrl: input.webhookUrl || null,
            webhookStatus: input.webhookUrl ? 'PENDING' : null,
          },
        });

        return payment;
      } catch (err) {
        const prismaErr = err as { code?: string; meta?: { target?: string[] } };

        // Corrida rara: duas requisições com a mesma idempotencyKey passaram pela
        // checagem acima quase simultaneamente. A constraint única do banco rejeita
        // a segunda inserção; devolvemos a cobrança que venceu a corrida em vez de
        // criar uma segunda cobrança real na conta.vc.
        if (input.idempotencyKey && prismaErr.code === 'P2002' && !prismaErr.meta?.target?.includes('receiptCode')) {
          const existing = await prisma.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
          if (existing) {
            return this.assertSameAmount(existing, amountCents);
          }
        }

        const isReceiptCodeCollision = prismaErr.code === 'P2002' && prismaErr.meta?.target?.includes('receiptCode');
        if (isReceiptCodeCollision && attempt < RECEIPT_CODE_MAX_ATTEMPTS) {
          continue;
        }

        throw err;
      }
    }

    throw new Error('Não foi possível gerar um código de confirmação único após várias tentativas.');
  }

  /**
   * Só o valor é comparado, de propósito: é o campo que decide quanto o
   * pagador paga e o que o Web3Listener casa por valor exato. Comparar
   * também `metadata`/`message` recusaria retentativas legítimas de
   * integradores que regeneram esses campos (timestamps, ids de rastreio) a
   * cada tentativa — ver DECISIONS.md, 2026-09-29.
   */
  private assertSameAmount(existing: Payment, requestedAmountCents: number): Payment {
    const existingAmountCents = centsFromStoredAmount(existing.amount);
    if (existingAmountCents !== requestedAmountCents) {
      throw new IdempotencyConflictError(existingAmountCents, requestedAmountCents);
    }
    return existing;
  }

  /**
   * Valida a resposta de `/api/pay/intent` contra o formato que o resto do
   * código assume. `CONTA_VC_INTENT_URL` é um endpoint interno sem suporte
   * oficial (ver ARCHITECTURE.md seção 1) — ele pode mudar de forma a qualquer
   * momento, sem aviso. Campos ausentes/de tipo errado que impediriam operar
   * corretamente (qrId, emv, expiresAt) bloqueiam a criação da cobrança;
   * anomalias que não impedem operar (amountCents divergente) só geram
   * alerta, sem falhar a cobrança.
   *
   * O `emv` também é lido como BR Code: um payload que não é Pix válido (CRC
   * errado, sem a conta `br.gov.bcb.pix`) ou que cobra um valor diferente do
   * pedido bloqueia a cobrança — o pagador receberia um QR impagável ou
   * pagaria um valor que a liquidação por valor exato (Web3Listener) nunca
   * casaria. `expiresAt` já vencido também bloqueia: o QR nasceria morto.
   */
  private validateIntentResponse(
    data: unknown,
    sentAmountCents: number
  ): { qrId: string; emv: string; amountCents: number; expiresAt: string } {
    const d = (data ?? {}) as Record<string, unknown>;

    if (typeof d.emv !== 'string' || d.emv.trim().length === 0) {
      throw new ContaVcContractDriftError('Resposta da conta.vc não continha a string EMV do Pix.', {
        receivedKeys: Object.keys(d),
      });
    }
    const emvInspection = inspectPixEmv(d.emv);
    if (emvInspection.problem) {
      throw new ContaVcContractDriftError(`EMV devolvido pela conta.vc não é um Pix válido: ${emvInspection.problem}.`, {
        emvPrefix: d.emv.slice(0, 12),
        emvLength: d.emv.length,
      });
    }
    if (emvInspection.amountCents !== null && emvInspection.amountCents !== sentAmountCents) {
      throw new ContaVcContractDriftError('EMV devolvido pela conta.vc cobra um valor diferente do solicitado.', {
        sentAmountCents,
        emvAmountCents: emvInspection.amountCents,
      });
    }
    if (typeof d.qrId !== 'string' || d.qrId.trim().length === 0) {
      throw new ContaVcContractDriftError('Resposta da conta.vc não continha um qrId válido.', {
        receivedKeys: Object.keys(d),
      });
    }
    const expiresAtDate = new Date(d.expiresAt as string);
    if (typeof d.expiresAt !== 'string' || isNaN(expiresAtDate.getTime())) {
      throw new ContaVcContractDriftError('Resposta da conta.vc trouxe expiresAt inválido/não-parseável.', {
        receivedExpiresAt: d.expiresAt,
      });
    }
    if (expiresAtDate.getTime() <= Date.now()) {
      throw new ContaVcContractDriftError('Resposta da conta.vc trouxe expiresAt já vencido.', {
        receivedExpiresAt: d.expiresAt,
      });
    }

    const amountCents = typeof d.amountCents === 'number' ? d.amountCents : sentAmountCents;
    if (typeof d.amountCents !== 'number' || d.amountCents !== sentAmountCents) {
      // Não bloqueia a cobrança (o valor enviado continua sendo a fonte de
      // verdade), mas é um sinal de que o contrato pode ter mudado sutilmente.
      reportContractDrift('createPayment.amountCents_mismatch', {
        sentAmountCents,
        receivedAmountCents: d.amountCents,
      });
    }

    return { qrId: d.qrId, emv: d.emv, amountCents, expiresAt: d.expiresAt };
  }

  /**
   * Consulta um pagamento por ID e garante expiração defensiva (lazy update)
   * se o prazo já tiver sido ultrapassado.
   */
  async getPaymentById(id: string): Promise<Payment | null> {
    let payment = await prisma.payment.findUnique({ where: { id } });
    if (!payment) return null;

    if (payment.status === 'PENDING' && new Date() > payment.expiresAt) {
      await prisma.payment.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      payment = (await prisma.payment.findUnique({ where: { id } })) ?? payment;
    }

    return payment;
  }

  /**
   * Consulta o status do intent de cobrança diretamente no endpoint da conta.vc
   * Retorna 'pending' | 'done' | 'failed' | 'expired' ou null em caso de falha de conexão.
   */
  async getIntentStatus(
    qrId: string,
    username?: string
  ): Promise<{ status: string; amountCents?: number } | null> {
    if (!qrId) return null;

    const handle = username || this.defaultUsername;
    // `defaultUsername` já é garantido não-vazio pelo construtor.
    // Deriva do mesmo CONTA_VC_INTENT_URL da criação: com a URL fixa, o
    // endpoint inalcançável do .env.test não valia para a consulta e um teste
    // (ou deploy apontando para outro host) batia na conta.vc real.
    const pollUrl = `${this.intentUrl.replace(/\/+$/, '')}/${encodeURIComponent(qrId)}`;

    const browserHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'Origin': 'https://app.conta.vc',
      'Referer': `https://app.conta.vc/pay/${encodeURIComponent(handle)}`,
      'Sec-Ch-Ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    };

    try {
      const response = await axios.get<{ status: string; amountCents?: number }>(
        pollUrl,
        {
          headers: browserHeaders,
          timeout: 6000,
          validateStatus: (status) => status >= 200 && status < 400,
        }
      );

      if (response.data && typeof response.data.status === 'string' && response.data.status) {
        if (!KNOWN_INTENT_STATUSES.has(response.data.status)) {
          reportContractDrift('getIntentStatus.unknown_status', { qrId, status: response.data.status });
        }
        return response.data;
      }
      // Resposta de sucesso sem `status` legível: o formato mudou (ou veio
      // HTML no lugar de JSON). Não bloqueia nada — só alerta e devolve null,
      // que o Web3Listener já trata como "não resolvido pelo provedor".
      reportContractDrift('getIntentStatus.missing_status', {
        qrId,
        httpStatus: response.status,
        receivedKeys: response.data && typeof response.data === 'object' ? Object.keys(response.data) : typeof response.data,
      });
      return null;
    } catch (err) {
      logger.warn({ err }, `[PaymentService] Falha ao consultar status do intent ${qrId}`);
      return null;
    }
  }
}

export const paymentService = new PaymentService();

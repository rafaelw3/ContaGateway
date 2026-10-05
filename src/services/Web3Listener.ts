import {
  createPublicClient,
  webSocket,
  parseAbiItem,
  formatUnits,
  getAddress,
  type Address,
  type Hash,
  type Log,
} from 'viem';
import { base } from 'viem/chains';
import { prisma, type Payment } from '../lib/prisma.js';
import { webhookService } from './WebhookService.js';
import { paymentService } from './PaymentService.js';
import { logger } from '../lib/logger.js';

// ABI minimalista para o evento Transfer ERC-20
const TRANSFER_EVENT_ABI = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

// Endereço do token contaBRL (cBRL) na Base, identificado durante uma
// investigação de incidente (ver README/relatório): o mint de cBRL é o que
// de fato representa o valor liquidado para o usuário. O transfer de BRLA
// que acompanha cada mint vai sempre para um endereço de reserva/lastro fixo
// do wrapped token (conta.vc: "cBRL é um wrapped de BRLA e BRS") — não prova
// que o pagamento específico chegou na carteira certa, por isso não decide
// mais liquidação (ver processTransferLog).
const DEFAULT_CBRL_CONTRACT_ADDRESS = '0x37422aE25c0f54442381eEA8406812cbe1Ab8A62';

// Sem checkpoint salvo (primeira subida), varre só esta janela recente (~20min
// na Base) — mesmo comportamento de antes do checkpoint existir.
const INITIAL_SYNC_BLOCKS = 600n;

// viem tipa o client de forma bem específica de acordo com os generics passados
// a createPublicClient; como só usamos getBlockNumber/getLogs/getTransactionReceipt
// (presentes em qualquer PublicClient), `any` evita brigar com esses generics.
type ViemPublicClient = any;

export interface Web3ListenerConfig {
  wssRpcUrl?: string;
  brlaContractAddress?: string;
  recipientWalletAddress?: string;
  brlaDecimals?: number;
  requiredConfirmations?: number;
  cbrlContractAddress?: string;
  cbrlDecimals?: number;
  expectedCbrlWalletAddress?: string;
  brlaReserveAddress?: string;
  settlementGracePeriodMs?: number;
  syncIntervalMs?: number;
  syncMaxLookbackBlocks?: bigint;
  syncChunkBlocks?: bigint;
}

export class Web3Listener {
  private readonly wssRpcUrl: string;
  // Versão com a chave do provedor redigida, para uso em qualquer log/erro.
  // Erros de transporte do viem (WebSocketRequestError, TimeoutError, etc.)
  // embutem a URL completa em .message — inclusive chaves de API no path
  // (ex: Alchemy), que viem NÃO redige sozinho. Nunca logar this.wssRpcUrl
  // nem um erro cru vindo do client sem passar por redact()/logError().
  private readonly safeWssRpcUrl: string;
  private readonly brlaContractAddress: Address;
  private readonly recipientWalletAddress: Address;
  private readonly brlaDecimals: number;

  // Nº de blocos de confirmação exigidos antes de liquidar um pagamento, para
  // reduzir o risco de creditar uma transferência que depois é revertida por reorg.
  private readonly requiredConfirmations: number;
  // Tempo médio de bloco da Base, usado só para calibrar o atraso do retry de confirmação.
  private readonly blockTimeMs = Number(process.env.WEB3_BLOCK_TIME_MS) || 2000;

  // cBRL é a liquidação oficial: só marca um pagamento como PAID quando o
  // mint de cBRL chega na carteira esperada (ver settleTransfer/flagMisroutedCbrl).
  private readonly cbrlContractAddress: Address;
  private readonly cbrlDecimals: number;
  private readonly expectedCbrlWalletAddress: Address;

  // BRLA vira só um sinal de diagnóstico opcional (ver processTransferLog) —
  // sem valor de decisão. Só ativa se BRLA_RESERVE_ADDRESS estiver configurado,
  // já que não faz sentido assumir um endereço de reserva de terceiros por padrão.
  private readonly brlaReserveAddress: Address | null;

  // O QR Code exibe "expirado" após expiresAt, mas o mint de cBRL pode chegar
  // minutos depois (fila da conta.vc, confirmações de bloco, etc.) — ver
  // README "Grace period de liquidação". Uma cobrança EXPIRED ainda pode ser
  // liquidada se a Tx chegar dentro dessa janela extra após o vencimento.
  private readonly settlementGracePeriodMs: number;

  // Varredura de recuperação a partir do checkpoint persistido (ver
  // syncPastTransfers): intervalo da varredura periódica, quanto no máximo
  // voltar numa subida após longa ausência, e tamanho de cada getLogs (RPCs
  // limitam o intervalo de blocos por chamada).
  private readonly syncIntervalMs: number;
  private readonly syncMaxLookbackBlocks: bigint;
  private readonly syncChunkBlocks: bigint;
  private readonly checkpointId: string;
  private syncTimer: NodeJS.Timeout | null = null;
  // Incrementado sempre que o processamento de um mint falha (banco, RPC). A
  // varredura só avança o checkpoint se este contador não mudou durante o
  // lote — senão o lote é refeito na próxima rodada, em vez de pulado.
  private processingFailures = 0;
  private readonly blockTimeCache = new Map<string, Date>();
  // Última vez que o RPC respondeu numa varredura (a cada WEB3_SYNC_INTERVAL_MS
  // e a cada lote). É o sinal do /health/ready: WebSocket "conectado" não
  // prova nada — um RPC que parou de responder não dá erro, só silêncio.
  private lastRpcOkAt: number | null = null;

  private client: ViemPublicClient | null = null;
  private unwatch: (() => void) | null = null;
  private unwatchCbrl: (() => void) | null = null;
  private isRunning = false;
  private isSyncing = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;

  constructor(config: Web3ListenerConfig = {}) {
    // Fallback: RPC público e gratuito da PublicNode (sem chave/conta). Bom
    // pra dev/baixo volume; para produção real, configure BASE_WSS_RPC_URL
    // com um provedor pago (Alchemy, Infura, QuickNode etc.) — mais
    // confiável, sem o rate limit/instabilidade de um endpoint compartilhado.
    this.wssRpcUrl =
      config.wssRpcUrl ||
      process.env.BASE_WSS_RPC_URL ||
      'wss://base-rpc.publicnode.com';
    this.safeWssRpcUrl = this.wssRpcUrl.replace(/\/[^/]+$/, '/***');

    // Endereço oficial do contrato BRLA na rede Base
    const rawContract =
      config.brlaContractAddress ||
      process.env.BRLA_CONTRACT_ADDRESS ||
      '0xfCB34c47f850f452C15EA1B84d51231C38A61783';

    // Carteira que deve receber a liquidação (cBRL) — sua carteira na conta.vc
    const rawRecipient =
      config.recipientWalletAddress ||
      process.env.RECIPIENT_WALLET_ADDRESS ||
      '0x0000000000000000000000000000000000000000';

    this.brlaContractAddress = getAddress(rawContract);
    this.recipientWalletAddress = getAddress(rawRecipient);
    this.brlaDecimals = config.brlaDecimals ?? Number(process.env.BRLA_DECIMALS || 18);
    this.requiredConfirmations =
      config.requiredConfirmations ?? (Number(process.env.WEB3_REQUIRED_CONFIRMATIONS) || 3);

    const rawCbrlContract = config.cbrlContractAddress || process.env.CBRL_CONTRACT_ADDRESS || DEFAULT_CBRL_CONTRACT_ADDRESS;
    this.cbrlContractAddress = getAddress(rawCbrlContract);
    this.cbrlDecimals = config.cbrlDecimals ?? Number(process.env.CBRL_DECIMALS || 18);

    // Por padrão, a carteira esperada do cBRL é a mesma RECIPIENT_WALLET_ADDRESS
    // (só existem duas variáveis separadas para permitir um valor diferente,
    // caso um dia isso realmente precise divergir).
    const rawExpectedCbrlWallet = config.expectedCbrlWalletAddress || process.env.EXPECTED_CBRL_WALLET_ADDRESS || rawRecipient;
    this.expectedCbrlWalletAddress = getAddress(rawExpectedCbrlWallet);

    const rawBrlaReserve = config.brlaReserveAddress || process.env.BRLA_RESERVE_ADDRESS;
    this.brlaReserveAddress = rawBrlaReserve ? getAddress(rawBrlaReserve) : null;

    this.settlementGracePeriodMs =
      config.settlementGracePeriodMs ?? (Number(process.env.SETTLEMENT_GRACE_PERIOD_MS) || 30 * 60 * 1000);

    this.syncIntervalMs = config.syncIntervalMs ?? (Number(process.env.WEB3_SYNC_INTERVAL_MS) || 60_000);
    this.syncMaxLookbackBlocks =
      config.syncMaxLookbackBlocks ?? BigInt(Number(process.env.WEB3_SYNC_MAX_LOOKBACK_BLOCKS) || 302_400); // ~7 dias
    this.syncChunkBlocks = config.syncChunkBlocks ?? BigInt(Number(process.env.WEB3_SYNC_CHUNK_BLOCKS) || 2_000);
    this.checkpointId = `cbrl-mints:${this.cbrlContractAddress.toLowerCase()}`;
  }

  /**
   * Inicia a escuta on-chain de liquidações (mint de cBRL) via WebSocket
   */
  start(): void {
    if (this.isRunning) {
      logger.info('[Web3Listener] O serviço já está em execução.');
      return;
    }

    this.isRunning = true;
    this.subscribe();

    // Varredura periódica a partir do checkpoint: mantém o checkpoint recente
    // (uma queda longa depois de semanas no ar não precisa voltar semanas) e
    // pega mints que o WebSocket tenha deixado de entregar sem erro nenhum.
    this.syncTimer = setInterval(() => {
      if (this.client) void this.syncPastTransfers(this.client, 'periodic');
    }, this.syncIntervalMs);
  }

  /**
   * Interrompe a escuta e limpa recursos/timers
   */
  stop(): void {
    this.isRunning = false;

    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.unwatch) {
      this.unwatch();
      this.unwatch = null;
    }

    if (this.unwatchCbrl) {
      this.unwatchCbrl();
      this.unwatchCbrl = null;
    }

    this.client = null;
    logger.info('[Web3Listener] Oráculo Web3 desconectado.');
  }

  private subscribe(): void {
    try {
      logger.info(`[Web3Listener] Conectando via WSS ao RPC Base: ${this.safeWssRpcUrl}`);
      logger.info(`[Web3Listener] Monitorando mints de cBRL: ${this.cbrlContractAddress}`);
      logger.info(`[Web3Listener] Carteira esperada para liquidação: ${this.expectedCbrlWalletAddress}`);

      const client = createPublicClient({
        chain: base,
        transport: webSocket(this.wssRpcUrl, {
          reconnect: {
            delay: 3000,
            attempts: 15,
          },
        }),
      });

      this.client = client;

      // Watcher principal: liquidação oficial via mint de cBRL.
      this.unwatchCbrl = client.watchContractEvent({
        address: this.cbrlContractAddress,
        abi: [TRANSFER_EVENT_ABI],
        eventName: 'Transfer',
        args: {
          from: ZERO_ADDRESS,
        },
        onLogs: async (logs: any[]) => {
          for (const log of logs) {
            await this.processCbrlMintLog(log);
          }
        },
        onError: (error: unknown) => {
          this.logError('[Web3Listener] Erro no stream de mints de cBRL (viem fará reconnect nativo):', error);
        },
      });

      // Watcher opcional, só diagnóstico: movimento de reserva BRLA. Nunca
      // decide liquidação — ver processTransferLog.
      if (this.brlaReserveAddress) {
        logger.info(`[Web3Listener] Monitorando (diagnóstico) reserva BRLA: ${this.brlaReserveAddress}`);

        this.unwatch = client.watchContractEvent({
          address: this.brlaContractAddress,
          abi: [TRANSFER_EVENT_ABI],
          eventName: 'Transfer',
          args: {
            to: this.brlaReserveAddress,
          },
          onLogs: async (logs) => {
            for (const log of logs) {
              await this.processTransferLog(log);
            }
          },
          onError: (error) => {
            // Diagnóstico apenas — uma falha aqui não deve derrubar a conexão
            // principal de liquidação com um reconnect.
            this.logError('[Web3Listener] Erro no stream de diagnóstico BRLA:', error, true);
          },
        });
      }

      logger.info('[Web3Listener] Conexão estabelecida e aguardando liquidações on-chain...');

      // Recupera o que aconteceu enquanto o serviço estava fora: varre desde o
      // checkpoint salvo (ou os ~20min recentes, na primeira subida).
      void this.syncPastTransfers(client, 'startup');
    } catch (error) {
      this.logError('[Web3Listener] Falha ao inicializar o cliente Web3:', error);
    }
  }

  /**
   * Recupera mints de cBRL que o watcher ao vivo não processou — o serviço
   * estava fora, o WebSocket caiu, ou o evento simplesmente não chegou.
   *
   * Varre de `checkpoint + 1` até `head - WEB3_REQUIRED_CONFIRMATIONS`, em
   * lotes de `syncChunkBlocks`. Só blocos já confirmados: neles o
   * awaitConfirmations liquida na hora (sem timer em memória), então ao fim do
   * lote o trabalho está de fato feito e o checkpoint pode avançar. Os blocos
   * mais novos ficam para o watcher ao vivo e para a próxima varredura.
   *
   * O checkpoint só avança se nenhum mint do lote falhou (processingFailures);
   * senão o lote é refeito depois. Reprocessar é seguro: transactionHash é
   * único, então um mint já liquidado é reconhecido e ignorado.
   *
   * Sem checkpoint salvo (primeira subida), varre só os INITIAL_SYNC_BLOCKS
   * recentes. Com um buraco maior que syncMaxLookbackBlocks, varre só o fim
   * dele e alerta — o início precisa de `npm run reconcile`.
   *
   * Guarda contra sobreposição: reconexões em sequência e a varredura
   * periódica não disparam varreduras concorrentes.
   */
  private async syncPastTransfers(client: ViemPublicClient, mode: 'startup' | 'periodic'): Promise<void> {
    if (this.isSyncing) {
      if (mode === 'startup') {
        logger.info('[Web3Listener] Sincronização histórica já em andamento; pulando execução sobreposta.');
      }
      return;
    }

    this.isSyncing = true;
    try {
      const head: bigint = await client.getBlockNumber();
      this.lastRpcOkAt = Date.now();
      const confirmations = BigInt(this.requiredConfirmations);
      const safeHead = head > confirmations ? head - confirmations : 0n;

      const saved = await prisma.syncCheckpoint.findUnique({ where: { id: this.checkpointId } });
      let fromBlock = saved
        ? saved.lastBlock + 1n
        : safeHead > INITIAL_SYNC_BLOCKS
          ? safeHead - INITIAL_SYNC_BLOCKS
          : 0n;

      if (fromBlock > safeHead) {
        return; // nada novo confirmado desde o checkpoint
      }

      if (safeHead - fromBlock > this.syncMaxLookbackBlocks) {
        const skippedTo = safeHead - this.syncMaxLookbackBlocks - 1n;
        logger.error(
          { event: 'web3_sync_gap', fromBlock: fromBlock.toString(), skippedTo: skippedTo.toString() },
          `[Web3Listener] 🚨 Serviço ficou fora além do limite de varredura (WEB3_SYNC_MAX_LOOKBACK_BLOCKS=${this.syncMaxLookbackBlocks}). ` +
            `Blocos ${fromBlock}–${skippedTo} NÃO foram varridos: mints de cBRL nesse intervalo podem ter ficado sem liquidar. ` +
            `Rode a conciliação on-chain: npm run reconcile -- --from-block ${fromBlock} --to-block ${skippedTo}`
        );
        fromBlock = skippedTo + 1n;
      }

      if (mode === 'startup') {
        logger.info(
          `[Web3Listener] Sincronizando mints de cBRL dos blocos ${fromBlock} até ${safeHead}` +
            (saved ? ` (a partir do checkpoint ${saved.lastBlock}).` : ' (sem checkpoint salvo: só a janela recente).')
        );
      }

      let found = 0;
      for (let chunkStart = fromBlock; chunkStart <= safeHead; chunkStart += this.syncChunkBlocks) {
        const chunkEnd =
          chunkStart + this.syncChunkBlocks - 1n < safeHead ? chunkStart + this.syncChunkBlocks - 1n : safeHead;
        const failuresBefore = this.processingFailures;

        const cbrlLogs = await client.getLogs({
          address: this.cbrlContractAddress,
          event: TRANSFER_EVENT_ABI,
          args: { from: ZERO_ADDRESS },
          fromBlock: chunkStart,
          toBlock: chunkEnd,
        });
        found += cbrlLogs.length;
        this.lastRpcOkAt = Date.now();

        for (const log of cbrlLogs) {
          await this.processCbrlMintLog(log);
        }

        if (this.processingFailures !== failuresBefore) {
          logger.warn(
            `[Web3Listener] Falha ao processar mint(s) nos blocos ${chunkStart}–${chunkEnd}; checkpoint mantido em ` +
              `${chunkStart - 1n} para refazer esse lote na próxima varredura.`
          );
          return;
        }

        await prisma.syncCheckpoint.upsert({
          where: { id: this.checkpointId },
          create: { id: this.checkpointId, lastBlock: chunkEnd },
          update: { lastBlock: chunkEnd },
        });
      }

      if (mode === 'startup') {
        logger.info(`[Web3Listener] Sincronização concluída: ${found} mint(s) de cBRL varrido(s); checkpoint em ${safeHead}.`);
      }

      if (mode === 'startup' && this.brlaReserveAddress) {
        // Diagnóstico apenas (nunca decide liquidação): só a janela recente, sem checkpoint.
        const brlaFrom = head > INITIAL_SYNC_BLOCKS ? head - INITIAL_SYNC_BLOCKS : 0n;
        const brlaLogs = await client.getLogs({
          address: this.brlaContractAddress,
          event: TRANSFER_EVENT_ABI,
          args: { to: this.brlaReserveAddress },
          fromBlock: brlaFrom,
          toBlock: head,
        });

        logger.info(`[Web3Listener] Encontradas ${brlaLogs.length} movimentações de reserva BRLA (diagnóstico).`);
        for (const log of brlaLogs) {
          await this.processTransferLog(log);
        }
      }
    } catch (err) {
      this.logError('[Web3Listener] Aviso ao sincronizar transferências recentes:', err, true);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Estado para o /health/ready: 'error' se o listener não está rodando,
   * 'stale' se o RPC não responde há mais de 3 varreduras (ou ainda não
   * respondeu nenhuma vez desde a subida), 'ok' caso contrário.
   */
  getHealth(now = Date.now()): 'ok' | 'stale' | 'error' {
    if (!this.isRunning) return 'error';
    if (this.lastRpcOkAt === null || now - this.lastRpcOkAt > 3 * this.syncIntervalMs) return 'stale';
    return 'ok';
  }

  /**
   * Horário do bloco que contém o mint — a referência para decidir se o
   * dinheiro chegou dentro do prazo da cobrança. Com cache por blockHash (o
   * mesmo bloco costuma ter vários eventos e é consultado de novo na
   * varredura). Devolve null se o RPC falhar: quem chama conta como falha e
   * NÃO liquida no chute.
   */
  private async getMintTime(blockHash: `0x${string}`): Promise<Date | null> {
    const cached = this.blockTimeCache.get(blockHash);
    if (cached) return cached;

    const client = this.client;
    if (!client) return null;

    try {
      const block = await client.getBlock({ blockHash });
      const time = new Date(Number(block.timestamp) * 1000);
      if (this.blockTimeCache.size >= 1000) {
        const oldest = this.blockTimeCache.keys().next().value;
        if (oldest !== undefined) this.blockTimeCache.delete(oldest);
      }
      this.blockTimeCache.set(blockHash, time);
      return time;
    } catch (err) {
      this.logError(`[Web3Listener] Não foi possível obter o horário do bloco ${blockHash}:`, err, true);
      return null;
    }
  }

  /**
   * Remove qualquer ocorrência literal da URL secreta do RPC de um texto antes
   * de logar. Cobre tanto erros do viem (que embutem a URL em .message/.stack)
   * quanto qualquer outra lib que eventualmente ecoe a URL de conexão.
   */
  private redact(text: string): string {
    return text.split(this.wssRpcUrl).join(this.safeWssRpcUrl);
  }

  /**
   * Loga um erro de forma segura: usa shortMessage (viem) quando disponível
   * — que nunca inclui a URL — e sempre passa o resultado por redact() como
   * segunda camada de defesa antes de logar.
   */
  private logError(prefix: string, error: unknown, warnOnly = false): void {
    const log = warnOnly ? logger.warn.bind(logger) : logger.error.bind(logger);
    if (error instanceof Error) {
      const shortMessage = (error as { shortMessage?: string }).shortMessage;
      log(`${prefix} ${this.redact(shortMessage || error.message)}`);
      return;
    }
    log(`${prefix} ${this.redact(String(error))}`);
  }

  /**
   * Diagnóstico apenas: BRLA é o lastro/reserva do wrapped token cBRL, sempre
   * indo para um endereço de reserva compartilhado — não prova que ESTA
   * cobrança específica liquidou na carteira certa. Nunca decide status de
   * pagamento (ver processCbrlMintLog para a liquidação de verdade).
   */
  private async processTransferLog(
    log: Log<bigint, number, boolean, typeof TRANSFER_EVENT_ABI, undefined, [typeof TRANSFER_EVENT_ABI], 'Transfer'>
  ): Promise<void> {
    const txHash = log.transactionHash as Hash | null;
    const { from, to, value } = log.args;

    if (!txHash || value === undefined || log.removed) {
      return;
    }

    const formattedAmount = Number(formatUnits(value, this.brlaDecimals)).toFixed(2);

    logger.info(
      `[Web3Listener] (diagnóstico, não decide liquidação) Movimento de reserva BRLA detectado.\n` +
      `  - TxHash: ${txHash}\n` +
      `  - De: ${from}\n` +
      `  - Para: ${to}\n` +
      `  - Valor: R$ ${formattedAmount} BRLA`
    );
  }

  /**
   * Liquidação oficial: processa um mint de cBRL. Se foi para a carteira
   * esperada, liquida o pagamento (settleTransfer). Se foi para qualquer
   * outra carteira, alerta e sinaliza o pagamento como MISROUTED em vez de
   * marcá-lo como pago — ver flagMisroutedCbrl.
   */
  private async processCbrlMintLog(
    log: Log<bigint, number, boolean, typeof TRANSFER_EVENT_ABI, undefined, [typeof TRANSFER_EVENT_ABI], 'Transfer'>
  ): Promise<void> {
    const txHash = log.transactionHash as Hash | null;
    const { to, value } = log.args;

    if (!txHash || value === undefined || !to) {
      logger.warn({ log }, '[Web3Listener] Log de mint de cBRL ignorado: dados insuficientes.');
      return;
    }

    // Reorg: o nó está avisando que este log foi removido da chain canônica.
    // Nunca liquidar com base em um log marcado como removido.
    if (log.removed) {
      logger.warn(`[Web3Listener] Log de mint de cBRL da Tx ${txHash} foi removido por reorg da chain. Ignorando.`);
      return;
    }

    const formattedAmount = Number(formatUnits(value, this.cbrlDecimals)).toFixed(2);

    logger.info(
      `[Web3Listener] Mint de cBRL detectado!\n` +
      `  - TxHash: ${txHash}\n` +
      `  - Para: ${to}\n` +
      `  - Valor: R$ ${formattedAmount} cBRL`
    );

    const blockHash = log.blockHash;
    await this.awaitConfirmations(txHash, log.blockNumber, blockHash, 'mint de cBRL', async () => {
      // O prazo da cobrança é comparado com QUANDO o mint aconteceu, não com
      // quando o processamos — senão um mint recuperado depois de uma queda
      // longa nunca casaria com a cobrança que ele de fato pagou no prazo.
      const mintTime = blockHash ? await this.getMintTime(blockHash) : null;
      if (!mintTime) {
        this.processingFailures++;
        logger.warn(`[Web3Listener] Mint ${txHash} sem horário de bloco; não liquidado agora, será refeito na próxima varredura.`);
        return;
      }

      if (to.toLowerCase() === this.expectedCbrlWalletAddress.toLowerCase()) {
        await this.settleTransfer(txHash, formattedAmount, mintTime);
      } else {
        await this.flagMisroutedCbrl(txHash, formattedAmount, to as Address, mintTime);
      }
    });
  }

  /**
   * Primeiro estágio de confirmação (usado só pela liquidação de cBRL): aguarda
   * o nº de blocos configurado antes de tratar a Tx como definitiva, mitigando
   * o risco de liquidar com base numa Tx que ainda pode ser revertida por reorg.
   */
  private async awaitConfirmations(
    txHash: Hash,
    blockNumber: bigint | null,
    blockHash: `0x${string}` | null,
    label: string,
    onConfirmed: () => Promise<void>
  ): Promise<void> {
    if (blockNumber === null || blockHash === null) {
      logger.warn(`[Web3Listener] ${label} ${txHash} ainda sem blockNumber/blockHash definitivos; aguardando próxima notificação.`);
      return;
    }

    const client = this.client;
    if (!client) {
      logger.warn(`[Web3Listener] Cliente RPC indisponível para checar confirmações de ${label} ${txHash}; será reavaliado na próxima sincronização.`);
      return;
    }

    try {
      const currentBlock = await client.getBlockNumber();
      const confirmations = currentBlock > blockNumber ? currentBlock - blockNumber : 0n;

      if (confirmations >= BigInt(this.requiredConfirmations)) {
        await onConfirmed();
        return;
      }

      const remainingBlocks = BigInt(this.requiredConfirmations) - confirmations;
      const delayMs = Number(remainingBlocks) * this.blockTimeMs;

      logger.info(
        `[Web3Listener] ${label} ${txHash} tem ${confirmations}/${this.requiredConfirmations} confirmações; ` +
        `aguardando ${delayMs}ms antes de reconfirmar.`
      );

      setTimeout(() => {
        void this.reconfirmThenRun(txHash, blockHash, label, onConfirmed);
      }, delayMs);
    } catch (err) {
      this.processingFailures++;
      this.logError(`[Web3Listener] Erro ao checar confirmações de ${label} ${txHash}:`, err);
    }
  }

  /**
   * Segundo estágio (após aguardar confirmações): reconfirma via
   * getTransactionReceipt que a transação ainda está incluída no MESMO bloco
   * original antes de prosseguir — se sumiu ou mudou de bloco, foi reorganizada.
   */
  private async reconfirmThenRun(
    txHash: Hash,
    expectedBlockHash: `0x${string}`,
    label: string,
    onConfirmed: () => Promise<void>
  ): Promise<void> {
    const client = this.client;
    if (!client) {
      logger.warn(`[Web3Listener] Cliente RPC indisponível para reconfirmar ${label} ${txHash}; será reavaliado na próxima sincronização.`);
      return;
    }

    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash });

      if (!receipt || receipt.status !== 'success' || receipt.blockHash !== expectedBlockHash) {
        logger.warn(
          `[Web3Listener] ${label} ${txHash} não confirmou no bloco original (possível reorg ou falha) — abortado.`
        );
        return;
      }
    } catch (err) {
      this.logError(`[Web3Listener] Não foi possível reconfirmar ${label} ${txHash} (provavelmente removida por reorg):`, err, true);
      return;
    }

    await onConfirmed();
  }

  /**
   * Um mint de cBRL não foi para a carteira esperada. Não liquida nada — só
   * alerta em nível crítico e, se houver exatamente UM candidato PENDING
   * inequívoco com esse valor, marca-o como MISROUTED para investigação
   * manual (guarda o txHash como evidência). Com múltiplos candidatos do
   * mesmo valor, marcar um às cegas poderia contaminar um pagamento que
   * ainda vai liquidar corretamente por outra Tx — nesse caso só alerta.
   */
  private async flagMisroutedCbrl(
    txHash: Hash,
    formattedAmount: string,
    actualWallet: Address,
    mintTime: Date
  ): Promise<void> {
    try {
      // Mesma janela da liquidação (settleTransfer), medida no bloco do mint:
      // só uma cobrança que já existia e estava no prazo (ou na carência)
      // quando o mint aconteceu pode ser a que ele pagou. Inclui EXPIRED
      // porque, recuperado depois de uma queda, o worker já terá expirado a
      // cobrança — e o desvio continua sendo desvio. Sem o createdAt, um mint
      // de terceiros recuperado depois podia marcar como MISROUTED uma
      // cobrança criada mais tarde.
      const graceThreshold = new Date(mintTime.getTime() - this.settlementGracePeriodMs);
      const candidates = await prisma.payment.findMany({
        where: {
          status: { in: ['PENDING', 'EXPIRED'] },
          amount: formattedAmount,
          createdAt: { lte: mintTime },
          expiresAt: { gt: graceThreshold },
        },
        orderBy: { createdAt: 'asc' },
      });

      // Sem nenhum candidato PENDING nosso, esse mint é só atividade de terceiros
      // não relacionada (a Base é mainnet real — qualquer conta.vc de qualquer
      // cliente pode mintar cBRL a qualquer momento). Não é um alerta acionável
      // para ESTA implantação, então não deve soar como um 🚨 crítico — evita
      // ruído/fadiga de alerta logo no primeiro boot ou em baixo volume.
      if (candidates.length === 0) {
        logger.info(
          `[Web3Listener] Mint de cBRL de terceiros não relacionado (nenhuma cobrança nossa em aberto com esse valor no horário do mint) — TxHash: ${txHash}, Valor: R$ ${formattedAmount}, Destino: ${actualWallet}.`
        );
        return;
      }

      logger.error(
        `[Web3Listener] 🚨 ALERTA: Mint de cBRL NÃO foi para a carteira esperada!\n` +
        `  - TxHash: ${txHash}\n` +
        `  - Valor: R$ ${formattedAmount} cBRL\n` +
        `  - Esperado: ${this.expectedCbrlWalletAddress}\n` +
        `  - Recebido por: ${actualWallet}\n` +
        `  - Candidatos nesse valor: ${candidates.map((c) => c.id).join(', ')}`
      );

      if (candidates.length === 1) {
        const result = await prisma.payment.updateMany({
          where: { id: candidates[0].id, status: candidates[0].status },
          data: { status: 'MISROUTED', transactionHash: txHash },
        });

        if (result.count > 0) {
          logger.error(`[Web3Listener] Pagamento ${candidates[0].id} marcado como MISROUTED para investigação manual.`);
        }
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        // Esse txHash já foi gravado em outra linha (ex: liquidação legítima
        // concorrente) — não é um erro real, só não marca o MISROUTED.
        return;
      }
      this.processingFailures++;
      this.logError('[Web3Listener] Erro ao processar mint de cBRL desviado:', err);
    }
  }

  /**
   * Liquidação idempotente e concorrente-segura: tenta reivindicar, em ordem de
   * preferência, cada candidato PENDING com o valor exato via updateMany
   * condicionado a status: 'PENDING'. Se o candidato preferido já tiver sido
   * tomado por outra execução concorrente, tenta o próximo da lista em vez de
   * desistir — isso fecha a corrida em que duas transferências reais e
   * simultâneas do mesmo valor podiam "disputar" o mesmo candidato e uma delas
   * ficar sem liquidação.
   */
  private async settleTransfer(txHash: Hash, formattedAmount: string, mintTime: Date): Promise<void> {
    try {
      // 1. Idempotência rápida: verifica se a Tx já foi processada anteriormente
      const existingTx = await prisma.payment.findUnique({
        where: { transactionHash: txHash },
      });

      if (existingTx) {
        logger.info(`[Web3Listener] Transação ${txHash} já processada para o pagamento ${existingTx.id}. Ignorando.`);
        return;
      }

      // 2. Busca candidatos com o valor exato da transferência: pagamentos
      // PENDING ainda dentro do prazo, OU já EXPIRED mas dentro da janela de
      // carência (a Tx pode chegar minutos depois do QR Code virar "expirado"
      // aos olhos do pagador — ver README "Grace period de liquidação").
      //
      // Casar por valor EXATO depende de uma suposição verificada contra a doc
      // oficial da conta.vc (docs.conta.vc/docs/dolares, 21/09/2026): a "taxa da
      // Conta" só é descontada do valor entregue quando está configurada pro
      // fluxo — e Pix→cBRL é confirmado grátis, então não há desconto e o mint
      // bate exato com o Pix pago. Se a conta.vc um dia configurar taxa nesse
      // fluxo específico, o sintoma visível é o warning "Nenhuma cobrança
      // PENDING/dentro da carência encontrada" abaixo disparando em volume —
      // não assumir que isso nunca pode acontecer, é dependência externa (ver
      // ARCHITECTURE.md seção 1).
      //
      // A referência de tempo é o bloco do mint (mintTime), não o relógio de
      // agora: a pergunta é "o dinheiro chegou dentro do prazo?". Com `now`,
      // um mint recuperado depois de uma queda maior que a carência nunca
      // casava. `createdAt <= mintTime` impede o inverso: casar um mint antigo
      // com uma cobrança do mesmo valor criada depois dele.
      const graceThreshold = new Date(mintTime.getTime() - this.settlementGracePeriodMs);
      const candidates = await prisma.payment.findMany({
        where: {
          amount: formattedAmount,
          status: { in: ['PENDING', 'EXPIRED'] },
          createdAt: { lte: mintTime },
          expiresAt: { gt: graceThreshold },
        },
        orderBy: { createdAt: 'asc' },
      });

      if (candidates.length === 0) {
        logger.warn(
          `[Web3Listener] ATENÇÃO: Nenhuma cobrança PENDING/dentro da carência encontrada no valor de R$ ${formattedAmount} para a Tx ${txHash}.`
        );
        return;
      }

      // Candidatos que estavam dentro do prazo normal quando o mint aconteceu
      // vêm antes dos que só cabem na carência — minimiza o risco de
      // "ressuscitar" um pagamento vencido quando existe um candidato ainda no
      // prazo para o mesmo valor.
      const onTime = (p: { expiresAt: Date }) => p.expiresAt.getTime() > mintTime.getTime();
      candidates.sort((a, b) => {
        const aPriority = onTime(a) ? 0 : 1;
        const bPriority = onTime(b) ? 0 : 1;
        if (aPriority !== bPriority) return aPriority - bPriority;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

      // 3. Determina a ORDEM de preferência dos candidatos (não uma escolha exclusiva).
      let tryOrder: Payment[];

      if (candidates.length === 1) {
        tryOrder = candidates;
      } else {
        logger.info(
          `[Web3Listener] ⚠️ Concorrência detectada: ${candidates.length} pagamentos PENDING encontrados com o valor R$ ${formattedAmount}. Iniciando Validação Híbrida...`
        );

        let preferred = await this.resolveAmbiguityWithProvider(candidates);

        if (!preferred) {
          logger.info('[Web3Listener] Nenhum candidato confirmado como "done" na 1ª tentativa. Aguardando 1.5s para retry...');
          await new Promise((resolve) => setTimeout(resolve, 1500));
          preferred = await this.resolveAmbiguityWithProvider(candidates);
        }

        if (preferred) {
          tryOrder = [preferred, ...candidates.filter((c) => c.id !== preferred!.id)];
        } else {
          logger.warn(
            `[Web3Listener] Validação com provedor inconclusiva para R$ ${formattedAmount}. Tentando candidatos por ordem de criação (FIFO), começando por: ${candidates[0].id}`
          );
          tryOrder = candidates;
        }
      }

      // 4. Tenta reivindicar cada candidato, em ordem, até um suceder.
      // Cada tentativa é um único updateMany condicionado a status: 'PENDING' —
      // já atômico por si só como statement isolado, sem precisar de um
      // $transaction interativo (que no Postgres soma overhead de lock/timeout
      // sem necessidade nenhuma aqui, já que não há múltiplas escritas a coordenar).
      // A idempotência entre linhas diferentes (mesma Tx em dois pagamentos) é
      // garantida pela constraint única de transactionHash: uma segunda tentativa
      // de gravá-la falha com P2002 em vez de silenciosamente duplicar.
      let settledPayment: Payment | null = null;
      let alreadyRecordedElsewhere = false;
      let transientFailure = false;

      for (const candidate of tryOrder) {
        const claim = await this.tryClaimCandidate(candidate, txHash, mintTime);

        if (claim.outcome === 'already-processed') {
          logger.info(`[Web3Listener] Transação ${txHash} já foi processada por outra execução concorrente. Ignorando.`);
          alreadyRecordedElsewhere = true;
          break;
        }

        if (claim.outcome === 'settled') {
          settledPayment = claim.payment;
          logger.info(
            `[Web3Listener] ✅ Pagamento liquidado com sucesso!\n` +
            `  - Payment ID: ${settledPayment.id}\n` +
            `  - Valor: R$ ${settledPayment.amount}\n` +
            `  - Status: ${settledPayment.status}\n` +
            `  - TxHash: ${settledPayment.transactionHash}`
          );
          break;
        }

        if (claim.outcome === 'taken') {
          // Candidato foi reivindicado por outra execução concorrente entre a
          // seleção e a tentativa de escrita — tenta o próximo da lista.
          logger.info(`[Web3Listener] Candidato ${candidate.id} não estava mais PENDING (disputado concorrentemente); tentando próximo candidato...`);
          continue;
        }

        // 'transient-failure': erro passageiro de banco (timeout/lock) mesmo após
        // retries — não aborta a liquidação inteira, tenta o próximo candidato.
        transientFailure = true;
        logger.warn(`[Web3Listener] Falha transitória de banco ao reivindicar candidato ${candidate.id}; tentando próximo candidato...`);
      }

      if (!settledPayment && !alreadyRecordedElsewhere && transientFailure) {
        // Não liquidou por falha de banco, não por falta de candidato: a
        // varredura precisa refazer este mint.
        this.processingFailures++;
      }

      if (!settledPayment && !alreadyRecordedElsewhere) {
        logger.warn(
          `[Web3Listener] Nenhum candidato PENDING disponível para reivindicar a Tx ${txHash} (todos foram tomados por liquidações concorrentes).`
        );
      }

      // 5. Se liquidou com sucesso e tem webhookUrl, dispara a notificação assíncrona
      if (settledPayment) {
        webhookService.notifyPaymentPaid(settledPayment);
      }
    } catch (dbError) {
      this.processingFailures++;
      this.logError(`[Web3Listener] Erro ao reconciliar pagamento no banco para a Tx ${txHash}:`, dbError);
    }
  }

  /**
   * Tenta reivindicar um único candidato para a Tx via updateMany condicionado
   * a status: 'PENDING'. Trata três desfechos possíveis:
   * - 'settled': reivindicou com sucesso.
   * - 'taken': o candidato não estava mais PENDING (perdeu a corrida) — quem
   *   chama deve tentar o próximo candidato da lista.
   * - 'already-processed': a Tx já foi gravada em OUTRA linha (violação da
   *   constraint única de transactionHash) — para o loop inteiro.
   * - 'transient-failure': erro passageiro de banco (timeout/lock) mesmo após
   *   alguns retries — quem chama deve tentar o próximo candidato em vez de
   *   abortar a liquidação inteira.
   */
  private async tryClaimCandidate(
    candidate: Payment,
    txHash: Hash,
    mintTime: Date
  ): Promise<
    | { outcome: 'settled'; payment: Payment }
    | { outcome: 'taken' | 'already-processed' | 'transient-failure' }
  > {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Guarda pelo status ATUAL do candidato (PENDING ou EXPIRED-em-carência)
        // em vez de sempre 'PENDING' — mesma atomicidade de antes (só reivindica
        // se ninguém mudou o status desde a leitura), agora também cobrindo o
        // caso de liquidação tardia dentro da janela de carência.
        const result = await prisma.payment.updateMany({
          where: { id: candidate.id, status: candidate.status },
          // paidAt = horário do bloco do mint (quando o dinheiro chegou), na
          // mesma escrita atômica do PAID — nunca um PAID sem paidAt.
          data: { status: 'PAID', transactionHash: txHash, paidAt: mintTime },
        });

        if (result.count === 0) {
          return { outcome: 'taken' };
        }

        if (candidate.status === 'EXPIRED') {
          logger.warn(
            `[Web3Listener] ⏳ Liquidação tardia (grace period): pagamento ${candidate.id} chegou EXPIRED mas foi liquidado dentro da janela de carência.`
          );
        }

        const updated = await prisma.payment.findUnique({ where: { id: candidate.id } });
        if (!updated) {
          // A linha sumiu entre o PAID e a releitura (apagada à mão?): não há
          // o que notificar; trata como candidato indisponível.
          return { outcome: 'taken' };
        }
        return { outcome: 'settled', payment: updated };
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          // Outra execução concorrente já gravou essa Tx em outra linha primeiro.
          return { outcome: 'already-processed' };
        }

        if (attempt < MAX_ATTEMPTS && this.isTransientDbError(err)) {
          await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
          continue;
        }

        this.logError(`[Web3Listener] Erro ao reivindicar candidato ${candidate.id}:`, err, true);
        return { outcome: 'transient-failure' };
      }
    }

    return { outcome: 'transient-failure' };
  }

  /**
   * Identifica erros passageiros de banco (timeout de conexão, lock contention)
   * que valem retry, em vez de erros de programação/dados que devem propagar.
   */
  private isTransientDbError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /timed? ?out|database is locked|deadlock|connection pool/i.test(message);
  }

  /**
   * Consulta o endpoint da conta.vc para cada candidato para identificar qual foi concluído ('done')
   */
  private async resolveAmbiguityWithProvider(candidates: Payment[]): Promise<Payment | null> {
    for (const candidate of candidates) {
      // Extrai o qrId diretamente da coluna ou do metadata como fallback
      let qrId: string | null = (candidate as { qrId?: string | null }).qrId ?? null;
      if (!qrId && candidate.metadata) {
        try {
          const meta = typeof candidate.metadata === 'string'
            ? JSON.parse(candidate.metadata)
            : (candidate.metadata as Record<string, unknown>);
          qrId = typeof meta?.contaVcQrId === 'string' ? meta.contaVcQrId : null;
        } catch {
          // ignora erro de parse
        }
      }

      if (!qrId) continue;

      const intent = await paymentService.getIntentStatus(qrId);
      if (intent?.status === 'done') {
        logger.info(
          `[Web3Listener] 🎯 Validação Híbrida bem-sucedida! Candidato ${candidate.id} confirmado com status "done" na conta.vc (qrId: ${qrId}).`
        );
        return candidate;
      }

      // Pequeno delay entre requisições na mesma batelada para evitar WAF rate limit (efeito rajada do oráculo)
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    return null;
  }
}

export const web3Listener = new Web3Listener();

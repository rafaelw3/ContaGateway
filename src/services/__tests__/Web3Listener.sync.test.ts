import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { Web3Listener } from '../Web3Listener.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

/**
 * Recuperação de mints depois de uma queda (checkpoint) e a referência de
 * tempo da liquidação (horário do bloco do mint, não o relógio de agora).
 *
 * Antes: a subida varria só os últimos 600 blocos (~20min) e o prazo da
 * cobrança era comparado com `now`. Um Pix pago durante uma queda de 2h nunca
 * liquidava — nem se o mint fosse reencontrado, porque "agora" já passava da
 * carência.
 */

const MIN = 60_000;
const createdIds: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  if (createdIds.length > 0) {
    await prisma.payment.deleteMany({ where: { id: { in: createdIds } } });
    createdIds.length = 0;
  }
});

async function createPayment(amount: string, opts: { status: string; createdAt: Date; expiresAt: Date }) {
  const payment = await prisma.payment.create({
    data: { amount, pixPayload: `sync-${amount}`, ...opts },
  });
  createdIds.push(payment.id);
  return payment;
}

const tx = (c: string) => ('0x' + c.repeat(64)) as `0x${string}`;

describe('liquidação medida no horário do bloco do mint', () => {
  const listener = new Web3Listener();

  it('liquida cobrança que expirou há 2h se o mint aconteceu dentro do prazo (o bug da queda longa)', async () => {
    const now = Date.now();
    const payment = await createPayment('301.00', {
      status: 'EXPIRED',
      createdAt: new Date(now - 135 * MIN),
      expiresAt: new Date(now - 120 * MIN),
    });
    const mintTime = new Date(now - 125 * MIN); // 5min antes de expirar

    await (listener as any).settleTransfer(tx('a'), '301.00', mintTime);

    const final = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(final!.status).toBe('PAID');
    // paidAt = quando o dinheiro chegou (bloco do mint), não quando processamos.
    expect(final!.paidAt?.toISOString()).toBe(mintTime.toISOString());
  });

  it('não liquida cobrança criada DEPOIS do mint (mint antigo não paga cobrança nova de mesmo valor)', async () => {
    const now = Date.now();
    const payment = await createPayment('302.00', {
      status: 'PENDING',
      createdAt: new Date(now - 1 * MIN),
      expiresAt: new Date(now + 14 * MIN),
    });
    const mintTime = new Date(now - 10 * MIN);

    await (listener as any).settleTransfer(tx('b'), '302.00', mintTime);

    const final = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(final!.status).toBe('PENDING');
    expect(final!.transactionHash).toBeNull();
  });

  it('não liquida se o mint aconteceu depois do prazo + carência', async () => {
    const now = Date.now();
    const payment = await createPayment('303.00', {
      status: 'EXPIRED',
      createdAt: new Date(now - 120 * MIN),
      expiresAt: new Date(now - 105 * MIN),
    });
    const mintTime = new Date(now - 60 * MIN); // 45min depois de expirar (carência: 30min)

    await (listener as any).settleTransfer(tx('c'), '303.00', mintTime);

    const final = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(final!.status).toBe('EXPIRED');
  });

  it('MISROUTED: ignora cobrança criada depois do mint e pega a já EXPIRED que estava no prazo', async () => {
    const now = Date.now();
    const nova = await createPayment('304.00', {
      status: 'PENDING',
      createdAt: new Date(now - 1 * MIN),
      expiresAt: new Date(now + 14 * MIN),
    });
    const vitima = await createPayment('304.00', {
      status: 'EXPIRED',
      createdAt: new Date(now - 135 * MIN),
      expiresAt: new Date(now - 120 * MIN),
    });
    const mintTime = new Date(now - 125 * MIN);

    await (listener as any).flagMisroutedCbrl(tx('d'), '304.00', '0x5555555555555555555555555555555555555555', mintTime);

    const [finalNova, finalVitima] = await Promise.all([
      prisma.payment.findUnique({ where: { id: nova.id } }),
      prisma.payment.findUnique({ where: { id: vitima.id } }),
    ]);
    expect(finalNova!.status).toBe('PENDING');
    expect(finalVitima!.status).toBe('MISROUTED');
    // Desvio não é pagamento: nada de paidAt.
    expect(finalVitima!.paidAt).toBeNull();
  });
});

describe('varredura a partir do checkpoint', () => {
  type FakeLog = { block: bigint; hash: `0x${string}`; to: string; value: bigint; time: Date };

  function fakeClient(head: bigint, logs: FakeLog[], opts: { failBlockTimeFor?: bigint } = {}) {
    const ranges: Array<[bigint, bigint]> = [];
    const blockHashOf = (n: bigint) => `0xb${n.toString(16).padStart(63, '0')}` as `0x${string}`;
    const client = {
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        ranges.push([fromBlock, toBlock]);
        return logs
          .filter((l) => l.block >= fromBlock && l.block <= toBlock)
          .map((l) => ({
            transactionHash: l.hash,
            removed: false,
            blockNumber: l.block,
            blockHash: blockHashOf(l.block),
            args: { from: '0x0000000000000000000000000000000000000000', to: l.to, value: l.value },
          }));
      },
      getBlock: async ({ blockHash }: { blockHash: `0x${string}` }) => {
        const log = logs.find((l) => blockHashOf(l.block) === blockHash);
        if (!log || log.block === opts.failBlockTimeFor) throw new Error('RPC indisponível');
        return { timestamp: BigInt(Math.floor(log.time.getTime() / 1000)) };
      },
    };
    return { client, ranges };
  }

  function makeListener(extra: Record<string, unknown> = {}) {
    const listener = new Web3Listener({
      requiredConfirmations: 3,
      syncChunkBlocks: 1000n,
      syncMaxLookbackBlocks: 100_000n,
      ...extra,
    });
    const checkpointId = (listener as any).checkpointId as string;
    return { listener, checkpointId };
  }

  async function run(listener: Web3Listener, client: unknown) {
    (listener as any).client = client;
    await (listener as any).syncPastTransfers(client, 'startup');
  }

  const checkpointIds = new Set<string>();
  beforeEach(() => checkpointIds.clear());
  afterEach(async () => {
    await prisma.syncCheckpoint.deleteMany({ where: { id: { in: [...checkpointIds] } } });
  });

  async function setCheckpoint(id: string, lastBlock: bigint) {
    checkpointIds.add(id);
    await prisma.syncCheckpoint.upsert({ where: { id }, create: { id, lastBlock }, update: { lastBlock } });
  }
  async function getCheckpoint(id: string) {
    checkpointIds.add(id);
    return (await prisma.syncCheckpoint.findUnique({ where: { id } }))?.lastBlock ?? null;
  }

  it('sem checkpoint: varre só a janela recente (600 blocos) até head - confirmações e salva o checkpoint', async () => {
    const { listener, checkpointId } = makeListener();
    await prisma.syncCheckpoint.deleteMany({ where: { id: checkpointId } });
    const { client, ranges } = fakeClient(5000n, []);

    await run(listener, client);

    expect(ranges).toEqual([[4397n, 4997n]]);
    expect(await getCheckpoint(checkpointId)).toBe(4997n);
  });

  it('com checkpoint antigo: varre do checkpoint em lotes e liquida o mint pago durante a queda', async () => {
    const { listener, checkpointId } = makeListener();
    await setCheckpoint(checkpointId, 1000n);
    const now = Date.now();
    const payment = await createPayment('311.00', {
      status: 'EXPIRED',
      createdAt: new Date(now - 135 * MIN),
      expiresAt: new Date(now - 120 * MIN),
    });
    const expected = (listener as any).expectedCbrlWalletAddress as string;
    const { client, ranges } = fakeClient(5000n, [
      { block: 1500n, hash: tx('e'), to: expected, value: 311n * 10n ** 18n, time: new Date(now - 125 * MIN) },
    ]);

    await run(listener, client);

    expect(ranges).toEqual([
      [1001n, 2000n],
      [2001n, 3000n],
      [3001n, 4000n],
      [4001n, 4997n],
    ]);
    const final = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(final!.status).toBe('PAID');
    expect(final!.transactionHash).toBe(tx('e'));
    expect(await getCheckpoint(checkpointId)).toBe(4997n);
  });

  it('falha ao processar um mint: checkpoint NÃO passa por cima do lote, que é refeito depois', async () => {
    const { listener, checkpointId } = makeListener();
    await setCheckpoint(checkpointId, 1000n);
    const now = Date.now();
    const payment = await createPayment('312.00', {
      status: 'EXPIRED',
      createdAt: new Date(now - 135 * MIN),
      expiresAt: new Date(now - 120 * MIN),
    });
    const expected = (listener as any).expectedCbrlWalletAddress as string;
    const logs = [{ block: 2500n, hash: tx('f'), to: expected, value: 312n * 10n ** 18n, time: new Date(now - 125 * MIN) }];

    const falha = fakeClient(5000n, logs, { failBlockTimeFor: 2500n });
    await run(listener, falha.client);

    // Primeiro lote ok (1001–2000), segundo falhou: para ali, checkpoint em 2000.
    expect(falha.ranges).toEqual([
      [1001n, 2000n],
      [2001n, 3000n],
    ]);
    expect(await getCheckpoint(checkpointId)).toBe(2000n);
    expect((await prisma.payment.findUnique({ where: { id: payment.id } }))!.status).toBe('EXPIRED');

    // Próxima varredura, RPC de volta: refaz o lote e liquida.
    const ok = fakeClient(5000n, logs);
    await run(listener, ok.client);
    expect(ok.ranges[0]).toEqual([2001n, 3000n]);
    expect((await prisma.payment.findUnique({ where: { id: payment.id } }))!.status).toBe('PAID');
    expect(await getCheckpoint(checkpointId)).toBe(4997n);
  });

  it('buraco maior que o limite: varre só o fim e alerta com o intervalo não varrido', async () => {
    const { listener, checkpointId } = makeListener({ syncMaxLookbackBlocks: 1000n });
    await setCheckpoint(checkpointId, 10n);
    const errorSpy = vi.spyOn(logger, 'error');
    const { client, ranges } = fakeClient(5000n, []);

    await run(listener, client);

    expect(ranges[0][0]).toBe(3997n);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'web3_sync_gap', fromBlock: '11', skippedTo: '3996' }),
      expect.stringContaining('NÃO foram varridos')
    );
    expect(await getCheckpoint(checkpointId)).toBe(4997n);
  });

  it('nada novo confirmado desde o checkpoint: não chama getLogs', async () => {
    const { listener, checkpointId } = makeListener();
    await setCheckpoint(checkpointId, 4997n);
    const { client, ranges } = fakeClient(5000n, []);

    await run(listener, client);

    expect(ranges).toEqual([]);
  });
});

describe('getHealth — sinal do RPC para o /health/ready', () => {
  it('error se o listener não está rodando; stale até o RPC responder; ok depois; stale se parar de responder', async () => {
    const listener = new Web3Listener({ requiredConfirmations: 3, syncIntervalMs: 60_000 });
    expect(listener.getHealth()).toBe('error');

    (listener as any).isRunning = true;
    expect(listener.getHealth()).toBe('stale');

    const checkpointId = (listener as any).checkpointId as string;
    await prisma.syncCheckpoint.upsert({
      where: { id: checkpointId },
      create: { id: checkpointId, lastBlock: 997n },
      update: { lastBlock: 997n },
    });
    const client = { getBlockNumber: async () => 1000n, getLogs: async () => [], getBlock: async () => ({ timestamp: 0n }) };
    (listener as any).client = client;
    try {
      await (listener as any).syncPastTransfers(client, 'periodic');
      expect(listener.getHealth()).toBe('ok');
      // 3 varreduras sem resposta do RPC → stale.
      expect(listener.getHealth(Date.now() + 3 * 60_000 + 1)).toBe('stale');
    } finally {
      await prisma.syncCheckpoint.deleteMany({ where: { id: checkpointId } });
      (listener as any).isRunning = false;
    }
  });
});


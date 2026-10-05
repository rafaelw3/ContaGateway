import { describe, it, expect, afterEach } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem, type Address, type Hash } from 'viem';
import { prisma } from '../../src/lib/prisma.js';
import { reconcile, parseArgs, type ReconcileClient } from '../reconcile.js';

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const CONTRACT = '0x37422aE25c0f54442381eEA8406812cbe1Ab8A62' as Address;
const WALLET = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x2222222222222222222222222222222222222222' as Address;
const E18 = 10n ** 18n;

const tx = (c: string) => ('0x' + c.repeat(64)) as Hash;
const blockHash = (n: bigint) => `0xb${n.toString(16).padStart(63, '0')}` as Hash;

interface ChainTx {
  hash: Hash;
  block: bigint;
  to: Address;
  value: bigint;
  status?: 'success' | 'reverted';
}

/** Base falsa: mints de cBRL com eventos Transfer codificados de verdade. */
function fakeChain(txs: ChainTx[], head = 10_000n) {
  const ranges: Array<[bigint, bigint]> = [];
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const timeOf = (n: bigint) => nowSec - (head - n) * 2n;
  const encodeLog = (t: ChainTx) => ({
    address: CONTRACT,
    topics: encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from: ZERO, to: t.to } }) as Hash[],
    data: encodeAbiParameters([{ type: 'uint256' }], [t.value]),
  });

  const client: ReconcileClient = {
    getBlockNumber: async () => head,
    getLogs: async ({ args, fromBlock, toBlock }) => {
      ranges.push([fromBlock, toBlock]);
      return txs
        .filter((t) => t.block >= fromBlock && t.block <= toBlock && t.to === args.to)
        .map((t) => ({ transactionHash: t.hash, blockNumber: t.block, blockHash: blockHash(t.block), args: { value: t.value } }));
    },
    getBlock: async (a) => {
      const n = 'blockNumber' in a ? a.blockNumber : BigInt('0x' + a.blockHash.slice(3));
      return { timestamp: timeOf(n) };
    },
    getTransactionReceipt: async ({ hash }) => {
      const t = txs.find((x) => x.hash === hash);
      if (!t) throw new Error('transaction not found');
      return { status: t.status ?? 'success', logs: [encodeLog(t)] };
    },
  };
  return { client, ranges, timeOf };
}

const createdIds: string[] = [];
afterEach(async () => {
  await prisma.payment.deleteMany({ where: { id: { in: createdIds } } });
  createdIds.length = 0;
});

async function seed(data: { amount: string; status: string; transactionHash?: string; minutesAgo?: number }) {
  const createdAt = new Date(Date.now() - (data.minutesAgo ?? 60) * 60_000);
  const p = await prisma.payment.create({
    data: {
      amount: data.amount,
      status: data.status,
      transactionHash: data.transactionHash ?? null,
      pixPayload: 'reconcile',
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 15 * 60_000),
    },
  });
  createdIds.push(p.id);
  return p;
}

const cfg = (fromBlock: bigint, toBlock: bigint) => ({ wallet: WALLET, contract: CONTRACT, decimals: 18, fromBlock, toBlock });

describe('reconcile — só leitura', () => {
  it('mint ligado a um PAID com prova on-chain: nenhuma divergência', async () => {
    const paid = await seed({ amount: '50.00', status: 'PAID', transactionHash: tx('a') });
    const { client } = fakeChain([{ hash: tx('a'), block: 9_900n, to: WALLET, value: 50n * E18 }]);

    const r = await reconcile(client, cfg(9_000n, 10_000n));

    expect(r.unmatchedMints).toEqual([]);
    expect(r.unprovenPaid.filter((u) => u.paymentId === paid.id)).toEqual([]);
  });

  it('mint na wallet sem pagamento ligado: aponta, com a cobrança candidata', async () => {
    const candidata = await seed({ amount: '61.00', status: 'EXPIRED', minutesAgo: 60 });
    const { client } = fakeChain([{ hash: tx('b'), block: 9_900n, to: WALLET, value: 61n * E18 }]);

    const r = await reconcile(client, cfg(9_000n, 10_000n));

    expect(r.unmatchedMints).toHaveLength(1);
    expect(r.unmatchedMints[0]).toMatchObject({ txHash: tx('b'), amount: '61.00' });
    expect(r.unmatchedMints[0].candidates.map((c) => c.id)).toContain(candidata.id);
  });

  it('não sugere como candidata cobrança criada depois do mint', async () => {
    const depois = await seed({ amount: '62.00', status: 'PENDING', minutesAgo: 1 });
    // bloco 9_000 com head 10_000 → ~33min atrás
    const { client } = fakeChain([{ hash: tx('c'), block: 9_000n, to: WALLET, value: 62n * E18 }]);

    const r = await reconcile(client, cfg(8_000n, 10_000n));

    expect(r.unmatchedMints[0].candidates.map((c) => c.id)).not.toContain(depois.id);
  });

  it.each([
    ['mint foi para outra wallet', { to: OTHER, value: 70n * E18 }, /não contém mint/],
    ['valor do mint difere da cobrança', { to: WALLET, value: 7n * E18 }, /mint de 7.00 cBRL, cobrança de 70.00/],
    ['transação revertida', { to: WALLET, value: 70n * E18, status: 'reverted' as const }, /revertida/],
  ])('PAID sem prova: %s', async (_nome, chainTx, reason) => {
    const paid = await seed({ amount: '70.00', status: 'PAID', transactionHash: tx('d') });
    const { client } = fakeChain([{ hash: tx('d'), block: 9_900n, ...chainTx }]);

    const r = await reconcile(client, cfg(9_000n, 10_000n));

    const found = r.unprovenPaid.find((u) => u.paymentId === paid.id);
    expect(found?.reason).toMatch(reason);
  });

  it('PAID cuja transação não existe na chain', async () => {
    const paid = await seed({ amount: '71.00', status: 'PAID', transactionHash: tx('e') });
    const { client } = fakeChain([]);

    const r = await reconcile(client, cfg(9_000n, 10_000n));

    expect(r.unprovenPaid.find((u) => u.paymentId === paid.id)?.reason).toMatch(/não encontrada/);
  });

  it('varre em lotes de 2.000 blocos e nunca altera o banco', async () => {
    const p = await seed({ amount: '80.00', status: 'EXPIRED' });
    const { client, ranges } = fakeChain([{ hash: tx('f'), block: 5_000n, to: WALLET, value: 80n * E18 }]);

    await reconcile(client, cfg(1n, 5_500n));

    expect(ranges).toEqual([
      [1n, 2_000n],
      [2_001n, 4_000n],
      [4_001n, 5_500n],
    ]);
    const after = await prisma.payment.findUnique({ where: { id: p.id } });
    expect(after!.status).toBe('EXPIRED');
    expect(after!.transactionHash).toBeNull();
  });
});

describe('parseArgs', () => {
  it('padrão: últimos 7 dias até o head', () => {
    expect(parseArgs([], 1_000_000n)).toEqual({ fromBlock: 1_000_000n - 7n * 43_200n, toBlock: 1_000_000n });
  });
  it('--days e --from-block/--to-block', () => {
    expect(parseArgs(['--days', '1'], 100_000n)).toEqual({ fromBlock: 56_800n, toBlock: 100_000n });
    expect(parseArgs(['--from-block', '10', '--to-block', '20'], 100_000n)).toEqual({ fromBlock: 10n, toBlock: 20n });
  });
});

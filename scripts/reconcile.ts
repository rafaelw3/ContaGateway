#!/usr/bin/env -S npx tsx
/**
 * Conciliação on-chain, SÓ LEITURA: confronta os mints de cBRL que chegaram na
 * wallet de liquidação com os pagamentos do banco. Roda localmente, com o
 * `.env` do ambiente que se quer auditar:
 *
 *   npm run reconcile                         # últimos 7 dias
 *   npm run reconcile -- --days 30
 *   npm run reconcile -- --from-block 123 --to-block 456
 *
 * Dois achados:
 *   1. Mint na nossa wallet sem pagamento ligado a ele (transactionHash) —
 *      dinheiro que chegou e nenhuma cobrança liquidou. Lista as cobranças
 *      candidatas (mesmo valor, já existentes no horário do mint).
 *   2. Pagamento PAID cujo transactionHash não é um mint de cBRL para a nossa
 *      wallet com o valor da cobrança — PAID sem prova on-chain.
 *
 * Nunca escreve no banco: marcar PAID exige confirmação humana de que o valor
 * chegou na wallet certa. O relatório é a evidência para essa
 * decisão, não a decisão.
 */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import {
  createPublicClient,
  webSocket,
  http,
  parseAbiItem,
  formatUnits,
  getAddress,
  decodeEventLog,
  type Address,
  type Hash,
} from 'viem';
import { base } from 'viem/chains';
import { prisma } from '../src/lib/prisma.js';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const DEFAULT_CBRL_CONTRACT = '0x37422aE25c0f54442381eEA8406812cbe1Ab8A62';
const BLOCKS_PER_DAY = 43_200n; // Base: ~2s por bloco
const CHUNK_BLOCKS = 2_000n;

/** O mínimo de um cliente viem que a conciliação usa — permite testar com um falso. */
export interface ReconcileClient {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    address: Address;
    event: typeof TRANSFER_EVENT;
    args: { from: Address; to: Address };
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<Array<{ transactionHash: Hash | null; blockNumber: bigint | null; blockHash: Hash | null; args: { value?: bigint } }>>;
  getBlock(args: { blockHash: Hash } | { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  getTransactionReceipt(args: { hash: Hash }): Promise<{
    status: 'success' | 'reverted';
    logs: Array<{ address: Address; topics: readonly Hash[] | Hash[]; data: Hash }>;
  }>;
}

export interface ReconcileConfig {
  wallet: Address;
  contract: Address;
  decimals: number;
  fromBlock: bigint;
  toBlock: bigint;
}

export interface UnmatchedMint {
  txHash: Hash;
  block: bigint;
  time: Date;
  amount: string;
  candidates: Array<{ id: string; status: string; createdAt: Date; expiresAt: Date }>;
}

export interface UnprovenPaid {
  paymentId: string;
  amount: string;
  txHash: string | null;
  reason: string;
}

export interface ReconcileReport {
  fromBlock: bigint;
  toBlock: bigint;
  mintsToWallet: number;
  matched: number;
  unmatchedMints: UnmatchedMint[];
  paidChecked: number;
  unprovenPaid: UnprovenPaid[];
}

const toBrl = (value: bigint, decimals: number) => Number(formatUnits(value, decimals)).toFixed(2);

export async function reconcile(client: ReconcileClient, cfg: ReconcileConfig): Promise<ReconcileReport> {
  const wallet = getAddress(cfg.wallet);
  const contract = getAddress(cfg.contract);

  // 1. Mints de cBRL para a nossa wallet no intervalo (em lotes: RPCs limitam o getLogs).
  const mints: Array<{ txHash: Hash; block: bigint; blockHash: Hash; amount: string }> = [];
  for (let start = cfg.fromBlock; start <= cfg.toBlock; start += CHUNK_BLOCKS) {
    const end = start + CHUNK_BLOCKS - 1n < cfg.toBlock ? start + CHUNK_BLOCKS - 1n : cfg.toBlock;
    const logs = await client.getLogs({
      address: contract,
      event: TRANSFER_EVENT,
      args: { from: ZERO_ADDRESS, to: wallet },
      fromBlock: start,
      toBlock: end,
    });
    for (const log of logs) {
      if (!log.transactionHash || log.blockNumber === null || !log.blockHash || log.args.value === undefined) continue;
      mints.push({
        txHash: log.transactionHash,
        block: log.blockNumber,
        blockHash: log.blockHash,
        amount: toBrl(log.args.value, cfg.decimals),
      });
    }
  }

  const linked = await prisma.payment.findMany({
    where: { transactionHash: { in: mints.map((m) => m.txHash) } },
    select: { transactionHash: true },
  });
  const linkedHashes = new Set(linked.map((p) => p.transactionHash?.toLowerCase()));

  const unmatchedMints: UnmatchedMint[] = [];
  for (const mint of mints) {
    if (linkedHashes.has(mint.txHash.toLowerCase())) continue;
    const block = await client.getBlock({ blockHash: mint.blockHash });
    const time = new Date(Number(block.timestamp) * 1000);
    const candidates = await prisma.payment.findMany({
      where: { amount: mint.amount, status: { not: 'PAID' }, createdAt: { lte: time } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, status: true, createdAt: true, expiresAt: true },
    });
    unmatchedMints.push({ txHash: mint.txHash, block: mint.block, time, amount: mint.amount, candidates });
  }

  // 2. Todo PAID criado no período do intervalo precisa apontar para um mint
  // real de cBRL, para a nossa wallet, no valor da cobrança. O período vem dos
  // blocos das pontas, com 1 dia de folga antes (cobrança criada pouco antes
  // do intervalo e paga dentro dele).
  const blockTime = async (blockNumber: bigint) =>
    new Date(Number((await client.getBlock({ blockNumber })).timestamp) * 1000);
  const periodStart = new Date((await blockTime(cfg.fromBlock)).getTime() - 24 * 3600 * 1000);
  const periodEnd = await blockTime(cfg.toBlock);
  const paid = await prisma.payment.findMany({
    where: { status: 'PAID', createdAt: { gte: periodStart, lte: periodEnd } },
    select: { id: true, amount: true, transactionHash: true },
  });

  const unprovenPaid: UnprovenPaid[] = [];
  for (const p of paid) {
    const amount = p.amount.toString();
    const expected = Number(amount).toFixed(2);
    if (!p.transactionHash) {
      unprovenPaid.push({ paymentId: p.id, amount, txHash: null, reason: 'PAID sem transactionHash' });
      continue;
    }
    let receipt;
    try {
      receipt = await client.getTransactionReceipt({ hash: p.transactionHash as Hash });
    } catch {
      unprovenPaid.push({ paymentId: p.id, amount, txHash: p.transactionHash, reason: 'transação não encontrada na Base' });
      continue;
    }
    if (receipt.status !== 'success') {
      unprovenPaid.push({ paymentId: p.id, amount, txHash: p.transactionHash, reason: 'transação revertida' });
      continue;
    }
    const mintValues = receipt.logs
      .filter((l) => getAddress(l.address) === contract)
      .map((l) => {
        try {
          const ev = decodeEventLog({ abi: [TRANSFER_EVENT], data: l.data, topics: l.topics as [Hash, ...Hash[]] });
          return ev.args;
        } catch {
          return null;
        }
      })
      .filter((a): a is { from: Address; to: Address; value: bigint } => a !== null)
      .filter((a) => getAddress(a.from) === ZERO_ADDRESS && getAddress(a.to) === wallet)
      .map((a) => toBrl(a.value, cfg.decimals));

    if (mintValues.length === 0) {
      unprovenPaid.push({
        paymentId: p.id,
        amount,
        txHash: p.transactionHash,
        reason: 'a transação não contém mint de cBRL para a wallet de liquidação',
      });
    } else if (!mintValues.includes(expected)) {
      unprovenPaid.push({
        paymentId: p.id,
        amount,
        txHash: p.transactionHash,
        reason: `mint de ${mintValues.join(', ')} cBRL, cobrança de ${expected}`,
      });
    }
  }

  return {
    fromBlock: cfg.fromBlock,
    toBlock: cfg.toBlock,
    mintsToWallet: mints.length,
    matched: mints.length - unmatchedMints.length,
    unmatchedMints,
    paidChecked: paid.length,
    unprovenPaid,
  };
}

export function parseArgs(argv: string[], head: bigint): { fromBlock: bigint; toBlock: bigint } {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const toBlock = value('--to-block') ? BigInt(value('--to-block')!) : head;
  if (value('--from-block')) {
    return { fromBlock: BigInt(value('--from-block')!), toBlock };
  }
  const days = BigInt(Number(value('--days') ?? 7));
  const span = days * BLOCKS_PER_DAY;
  return { fromBlock: toBlock > span ? toBlock - span : 0n, toBlock };
}

function printReport(r: ReconcileReport): void {
  console.log(`\nConciliação on-chain — blocos ${r.fromBlock} a ${r.toBlock} (só leitura, nada foi alterado)\n`);
  console.log(`  Mints de cBRL para a wallet: ${r.mintsToWallet} (${r.matched} ligados a um pagamento)`);
  console.log(`  Pagamentos PAID conferidos:  ${r.paidChecked}\n`);

  if (r.unmatchedMints.length > 0) {
    console.log(`⚠️  ${r.unmatchedMints.length} mint(s) na wallet SEM pagamento ligado (dinheiro recebido, nenhuma cobrança liquidou):\n`);
    for (const m of r.unmatchedMints) {
      console.log(`  ${m.txHash}  bloco ${m.block}  ${m.time.toISOString()}  R$ ${m.amount}`);
      if (m.candidates.length === 0) {
        console.log('     nenhuma cobrança com esse valor existia nesse horário');
      }
      for (const c of m.candidates) {
        console.log(`     candidata: ${c.id}  ${c.status}  criada ${c.createdAt.toISOString()}  expira ${c.expiresAt.toISOString()}`);
      }
    }
    console.log('\n  Marcar PAID exige confirmação humana: confira a transação no BaseScan antes.\n');
  }

  if (r.unprovenPaid.length > 0) {
    console.log(`🚨 ${r.unprovenPaid.length} pagamento(s) PAID sem prova on-chain:\n`);
    for (const u of r.unprovenPaid) {
      console.log(`  ${u.paymentId}  R$ ${u.amount}  tx ${u.txHash ?? '—'}  → ${u.reason}`);
    }
    console.log('');
  }

  if (r.unmatchedMints.length === 0 && r.unprovenPaid.length === 0) {
    console.log('✅ Nenhuma divergência no intervalo.\n');
  }
}

async function main(): Promise<number> {
  const wallet = process.env.EXPECTED_CBRL_WALLET_ADDRESS || process.env.RECIPIENT_WALLET_ADDRESS;
  const rpcUrl = process.env.BASE_WSS_RPC_URL || 'wss://base-rpc.publicnode.com';
  if (!wallet || getAddress(wallet) === ZERO_ADDRESS) {
    console.error('RECIPIENT_WALLET_ADDRESS (ou EXPECTED_CBRL_WALLET_ADDRESS) não configurado no .env.');
    return 2;
  }

  const client = createPublicClient({
    chain: base,
    transport: rpcUrl.startsWith('ws') ? webSocket(rpcUrl) : http(rpcUrl),
  });

  try {
    const head = await client.getBlockNumber();
    const { fromBlock, toBlock } = parseArgs(process.argv.slice(2), head);
    const report = await reconcile(client as unknown as ReconcileClient, {
      wallet: wallet as Address,
      contract: (process.env.CBRL_CONTRACT_ADDRESS || DEFAULT_CBRL_CONTRACT) as Address,
      decimals: Number(process.env.CBRL_DECIMALS || 18),
      fromBlock,
      toBlock,
    });
    printReport(report);
    return report.unmatchedMints.length > 0 || report.unprovenPaid.length > 0 ? 1 : 0;
  } catch (err) {
    // Erro do viem pode embutir a URL do RPC (com chave): só a mensagem curta, e redigida.
    const e = err as { shortMessage?: string; message?: string };
    console.error(`Falha na conciliação: ${(e.shortMessage ?? e.message ?? String(err)).split(rpcUrl).join('<rpc>')}`);
    return 2;
  }
}

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isDirectRun) {
  main()
    .then(async (code) => {
      await prisma.$disconnect();
      // O transporte WebSocket do viem mantém o processo vivo; sai explicitamente.
      process.exit(code);
    })
    .catch(async (err) => {
      console.error('Erro inesperado na conciliação:', (err as Error).message);
      await prisma.$disconnect();
      process.exit(2);
    });
}

import { describe, it, expect, afterEach } from 'vitest';
import { Web3Listener } from '../Web3Listener.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

const listener = new Web3Listener();
const createdIds: string[] = [];

afterEach(async () => {
  if (createdIds.length > 0) {
    await prisma.payment.deleteMany({ where: { id: { in: createdIds } } });
    createdIds.length = 0;
  }
});

async function createPending(amount: string, pixPayload: string) {
  const future = new Date(Date.now() + 15 * 60 * 1000);
  const payment = await prisma.payment.create({
    data: { amount, status: 'PENDING', pixPayload, expiresAt: future },
  });
  createdIds.push(payment.id);
  return payment;
}

async function createExpired(amount: string, pixPayload: string, minutesAgo: number) {
  const past = new Date(Date.now() - minutesAgo * 60 * 1000);
  const payment = await prisma.payment.create({
    data: { amount, status: 'EXPIRED', pixPayload, expiresAt: past },
  });
  createdIds.push(payment.id);
  return payment;
}

describe('Web3Listener.settleTransfer — race conditions e idempotência', () => {
  it('duas transferências reais e concorrentes do mesmo valor liquidam cada uma o seu próprio pagamento', async () => {
    const amount = '77.00';
    const p1 = await createPending(amount, 'race-1');
    const p2 = await createPending(amount, 'race-2');

    const txA = ('0x' + 'a'.repeat(64)) as `0x${string}`;
    const txB = ('0x' + 'b'.repeat(64)) as `0x${string}`;

    await Promise.all([
      (listener as any).settleTransfer(txA, amount, new Date()),
      (listener as any).settleTransfer(txB, amount, new Date()),
    ]);

    const [final1, final2] = await Promise.all([
      prisma.payment.findUnique({ where: { id: p1.id } }),
      prisma.payment.findUnique({ where: { id: p2.id } }),
    ]);

    expect(final1!.status).toBe('PAID');
    expect(final2!.status).toBe('PAID');
    // Cada pagamento deve ter ficado com um hash diferente do outro (nenhum
    // ficou "roubado" pela mesma transferência, e nenhum ficou sem liquidar).
    expect(final1!.transactionHash).not.toBe(final2!.transactionHash);
    expect([final1!.transactionHash, final2!.transactionHash].sort()).toEqual([txA, txB].sort());
  });

  it('processar a mesma Tx duas vezes concorrentemente liquida só uma vez (idempotência)', async () => {
    const amount = '88.00';
    const payment = await createPending(amount, 'idem-onchain-1');
    const tx = ('0x' + 'c'.repeat(64)) as `0x${string}`;

    await Promise.all([
      (listener as any).settleTransfer(tx, amount, new Date()),
      (listener as any).settleTransfer(tx, amount, new Date()),
    ]);

    const final = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(final!.status).toBe('PAID');
    expect(final!.transactionHash).toBe(tx);

    // Nenhuma segunda linha deve ter sido afetada/criada com o mesmo hash.
    const count = await prisma.payment.count({ where: { transactionHash: tx } });
    expect(count).toBe(1);
  });

  it('não liquida nada quando não há candidato PENDING com o valor exato', async () => {
    const tx = ('0x' + 'd'.repeat(64)) as `0x${string}`;
    // Não deve lançar mesmo sem nenhum candidato encontrado.
    await expect((listener as any).settleTransfer(tx, '999999.00', new Date())).resolves.toBeUndefined();

    const count = await prisma.payment.count({ where: { transactionHash: tx } });
    expect(count).toBe(0);
  });

  it('sob rajada (15 transferências distintas, mesmo valor), todas liquidam sem erro e sem duplicar', async () => {
    const amount = '33.00';
    const N = 15;
    const payments = await Promise.all(
      Array.from({ length: N }, (_, i) => createPending(amount, `burst-${i}-${Date.now()}`))
    );

    const txs = Array.from({ length: N }, (_, i) => ('0x' + i.toString().padStart(64, '0')) as `0x${string}`);

    await Promise.all(txs.map((tx) => (listener as any).settleTransfer(tx, amount, new Date())));

    const finals = await prisma.payment.findMany({ where: { id: { in: payments.map((p) => p.id) } } });
    expect(finals.every((p) => p.status === 'PAID')).toBe(true);

    const distinctHashes = new Set(finals.map((p) => p.transactionHash));
    expect(distinctHashes.size).toBe(N);
  });
});

describe('Web3Listener.settleTransfer — grace period de liquidação tardia', () => {
  it('liquida um pagamento EXPIRED se a Tx chegar dentro da janela de carência (padrão: 30min)', async () => {
    const amount = '44.00';
    const payment = await createExpired(amount, 'grace-within', 5);
    const tx = ('0x' + '4'.repeat(64)) as `0x${string}`;

    await (listener as any).settleTransfer(tx, amount, new Date());

    const final = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(final!.status).toBe('PAID');
    expect(final!.transactionHash).toBe(tx);
  });

  it('não liquida um pagamento EXPIRED há mais tempo que a janela de carência', async () => {
    const amount = '45.00';
    const payment = await createExpired(amount, 'grace-outside', 40);
    const tx = ('0x' + '5'.repeat(64)) as `0x${string}`;

    await (listener as any).settleTransfer(tx, amount, new Date());

    const final = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(final!.status).toBe('EXPIRED');
    expect(final!.transactionHash).toBeNull();
  });

  it('prioriza um candidato PENDING sobre um EXPIRED-em-carência do mesmo valor', async () => {
    const amount = '46.00';
    const pending = await createPending(amount, 'grace-priority-pending');
    const expired = await createExpired(amount, 'grace-priority-expired', 5);
    const tx = ('0x' + '6'.repeat(64)) as `0x${string}`;

    await (listener as any).settleTransfer(tx, amount, new Date());

    const [finalPending, finalExpired] = await Promise.all([
      prisma.payment.findUnique({ where: { id: pending.id } }),
      prisma.payment.findUnique({ where: { id: expired.id } }),
    ]);
    expect(finalPending!.status).toBe('PAID');
    expect(finalExpired!.status).toBe('EXPIRED');
  });
});

describe('Web3Listener.flagMisroutedCbrl — sinaliza desvio sem marcar como pago', () => {
  it('marca como MISROUTED quando há exatamente um candidato PENDING inequívoco', async () => {
    const amount = '55.00';
    const payment = await createPending(amount, 'misrouted-1');
    const tx = ('0x' + 'e'.repeat(64)) as `0x${string}`;
    const wrongWallet = '0x1111111111111111111111111111111111111111' as `0x${string}`;

    await (listener as any).flagMisroutedCbrl(tx, amount, wrongWallet, new Date());

    const final = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(final!.status).toBe('MISROUTED');
    expect(final!.transactionHash).toBe(tx);
  });

  it('não marca nada quando há candidatos ambíguos do mesmo valor (evita contaminar um pagamento que ainda pode liquidar certo)', async () => {
    const amount = '66.00';
    const p1 = await createPending(amount, 'misrouted-amb-1');
    const p2 = await createPending(amount, 'misrouted-amb-2');
    const tx = ('0x' + 'f'.repeat(64)) as `0x${string}`;
    const wrongWallet = '0x2222222222222222222222222222222222222222' as `0x${string}`;

    await (listener as any).flagMisroutedCbrl(tx, amount, wrongWallet, new Date());

    const [f1, f2] = await Promise.all([
      prisma.payment.findUnique({ where: { id: p1.id } }),
      prisma.payment.findUnique({ where: { id: p2.id } }),
    ]);
    expect(f1!.status).toBe('PENDING');
    expect(f2!.status).toBe('PENDING');
  });

  it('não faz nada (sem erro) quando não há candidato PENDING nesse valor', async () => {
    const tx = ('0x' + '9'.repeat(64)) as `0x${string}`;
    await expect(
      (listener as any).flagMisroutedCbrl(tx, '777777.00', '0x3333333333333333333333333333333333333333', new Date())
    ).resolves.toBeUndefined();
  });

  it('sem candidato PENDING, loga como info (não como alerta crítico) — é atividade de terceiros irrelevante pra esta implantação', async () => {
    const errorCalls: unknown[][] = [];
    const infoCalls: unknown[][] = [];
    const originalError = logger.error;
    const originalInfo = logger.info;
    logger.error = (...args: unknown[]) => { errorCalls.push(args); };
    logger.info = (...args: unknown[]) => { infoCalls.push(args); };

    try {
      const tx = ('0x' + '8'.repeat(64)) as `0x${string}`;
      await (listener as any).flagMisroutedCbrl(tx, '888888.00', '0x4444444444444444444444444444444444444444', new Date());
    } finally {
      logger.error = originalError;
      logger.info = originalInfo;
    }

    expect(errorCalls).toHaveLength(0);
    expect(infoCalls.length).toBeGreaterThan(0);
  });
});

describe('Web3Listener.processCbrlMintLog — dispatcha para liquidação ou desvio', () => {
  it('liquida (settleTransfer) quando o mint vai para a carteira esperada, sem precisar de client/RPC (0 confirmações exigidas)', async () => {
    const amount = '88.50';
    const payment = await createPending(amount, 'dispatch-correct');
    const localListener = new Web3Listener({ requiredConfirmations: 0 });
    // awaitConfirmations() sempre consulta o client (mesmo com 0 confirmações
    // exigidas) para calcular quantos blocos já se passaram; injeta um stub
    // mínimo já que este listener nunca foi .start()ado.
    (localListener as any).client = {
      getBlockNumber: async () => 1n,
      // Horário do bloco do mint: agora (a cobrança acabou de ser criada).
      getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000) + 1) }),
    };
    const tx = ('0x' + '1'.repeat(64)) as `0x${string}`;

    await (localListener as any).processCbrlMintLog({
      transactionHash: tx,
      removed: false,
      blockNumber: 1n,
      blockHash: '0xblock',
      args: {
        from: '0x0000000000000000000000000000000000000000',
        to: (localListener as any).expectedCbrlWalletAddress,
        value: 88500000000000000000n,
      },
    });

    const final = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(final!.status).toBe('PAID');
    expect(final!.transactionHash).toBe(tx);
  });

  it('sinaliza MISROUTED quando o mint vai para outra carteira, sem precisar de client/RPC (0 confirmações exigidas)', async () => {
    const amount = '99.50';
    const payment = await createPending(amount, 'dispatch-wrong');
    const localListener = new Web3Listener({ requiredConfirmations: 0 });
    (localListener as any).client = {
      getBlockNumber: async () => 1n,
      // Horário do bloco do mint: agora (a cobrança acabou de ser criada).
      getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000) + 1) }),
    };
    const tx = ('0x' + '2'.repeat(64)) as `0x${string}`;

    await (localListener as any).processCbrlMintLog({
      transactionHash: tx,
      removed: false,
      blockNumber: 1n,
      blockHash: '0xblock',
      args: {
        from: '0x0000000000000000000000000000000000000000',
        to: '0x4444444444444444444444444444444444444444',
        value: 99500000000000000000n,
      },
    });

    const final = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(final!.status).toBe('MISROUTED');
    expect(final!.transactionHash).toBe(tx);
  });
});

describe('Web3Listener.processTransferLog (BRLA) — diagnóstico apenas, nunca decide liquidação', () => {
  it('não altera nenhum pagamento mesmo com um candidato PENDING do mesmo valor', async () => {
    const amount = '123.00';
    const payment = await createPending(amount, 'brla-diagnostic-only');
    const tx = ('0x' + '3'.repeat(64)) as `0x${string}`;

    await (listener as any).processTransferLog({
      transactionHash: tx,
      removed: false,
      blockNumber: 1n,
      blockHash: '0xblock',
      args: {
        from: '0x0F57811146e6A7d1A25Be14219EC6dC563f58518',
        to: '0x1234567890123456789012345678901234567890',
        value: 123000000000000000000n,
      },
    });

    const final = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(final!.status).toBe('PENDING');
    expect(final!.transactionHash).toBeNull();
  });
});

describe('Web3Listener — sanitização de logs (não vaza a URL do RPC)', () => {
  it('redact() remove a URL configurada de qualquer texto', () => {
    const secretUrl = 'wss://base-mainnet.g.alchemy.com/v2/CHAVE_SECRETA_DE_TESTE';
    const withSecret = new Web3Listener({ wssRpcUrl: secretUrl });
    const redacted = (withSecret as any).redact(`erro ao conectar em ${secretUrl}`);
    expect(redacted).not.toContain('CHAVE_SECRETA_DE_TESTE');
    expect(redacted).toContain('wss://base-mainnet.g.alchemy.com/v2/***');
  });

  it('logError usa shortMessage (viem) quando disponível, sem vazar a URL', () => {
    const secretUrl = 'wss://base-mainnet.g.alchemy.com/v2/OUTRA_CHAVE_SECRETA';
    const withSecret = new Web3Listener({ wssRpcUrl: secretUrl });

    const err = new Error('erro genérico') as Error & { shortMessage?: string };
    err.shortMessage = 'mensagem curta sem segredo';

    const calls: unknown[][] = [];
    const original = logger.error;
    // Substituição direta em vez de vi.spyOn: o pino, com o logger desabilitado
    // (NODE_ENV=test), usa um noop interno compartilhado que o spy não intercepta.
    logger.error = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      (withSecret as any).logError('[teste]', err);
    } finally {
      logger.error = original;
    }

    expect(calls).toHaveLength(1);
    const loggedText = calls[0]!.join(' ');
    expect(loggedText).not.toContain('OUTRA_CHAVE_SECRETA');
    expect(loggedText).toContain('mensagem curta sem segredo');
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { checkDatabase, clearReadinessChecks, registerReadinessCheck, runReadinessChecks } from '../readiness.js';
import { prisma } from '../prisma.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkDatabase', () => {
  it('ok quando o banco responde', async () => {
    expect(await checkDatabase()).toBe('ok');
  });

  it('error quando a consulta falha, sem lançar', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error("Can't reach database server at `db.interno:5432`"));
    expect(await checkDatabase()).toBe('error');
  });

  it('timeout quando o banco não responde no prazo (conexão pendurada não rejeita)', async () => {
    vi.spyOn(prisma, '$queryRaw').mockReturnValue(new Promise(() => {}) as never);
    const started = Date.now();
    expect(await checkDatabase(50)).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('runReadinessChecks — checagens registradas além do banco', () => {
  afterEach(() => {
    clearReadinessChecks();
  });

  it('sem nada registrado (app sem servidor completo): só o banco', async () => {
    expect(await runReadinessChecks()).toEqual({ database: 'ok' });
  });

  it('inclui as registradas; uma que lança vira error sem derrubar as outras', async () => {
    registerReadinessCheck('web3', () => 'stale');
    registerReadinessCheck('quebrada', () => {
      throw new Error('segredo no erro');
    });

    expect(await runReadinessChecks()).toEqual({ database: 'ok', web3: 'stale', quebrada: 'error' });
  });
});


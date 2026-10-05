import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('reportContractDrift', () => {
  const originalWebhookUrl = process.env.OPS_ALERT_WEBHOOK_URL;

  afterEach(() => {
    process.env.OPS_ALERT_WEBHOOK_URL = originalWebhookUrl;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('nunca lança exceção, mesmo sem Sentry/webhook configurados', async () => {
    delete process.env.OPS_ALERT_WEBHOOK_URL;
    vi.resetModules();
    const { reportContractDrift } = await import('../contractGuard.js');

    expect(() => reportContractDrift('teste', { foo: 'bar' })).not.toThrow();
  });

  it('sempre loga estruturado, independente de Sentry/webhook (canal universal)', async () => {
    delete process.env.OPS_ALERT_WEBHOOK_URL;
    vi.resetModules();
    const { logger } = await import('../logger.js');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);

    const { reportContractDrift } = await import('../contractGuard.js');
    reportContractDrift('createPayment', { receivedKeys: ['x'] });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'contavc_contract_drift', context: 'createPayment' }),
      expect.stringContaining('createPayment')
    );
  });

  it('dispara o webhook genérico só quando OPS_ALERT_WEBHOOK_URL está configurada', async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = 'https://hooks.example.com/alert';
    vi.resetModules();

    const axios = (await import('axios')).default;
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200 } as any);

    const { reportContractDrift } = await import('../contractGuard.js');
    reportContractDrift('createPayment', { foo: 'bar' });

    expect(postSpy).toHaveBeenCalledWith(
      'https://hooks.example.com/alert',
      expect.objectContaining({ text: expect.any(String), content: expect.any(String) }),
      expect.any(Object)
    );
  });

  it('dispara em todas as URLs quando OPS_ALERT_WEBHOOK_URL tem várias separadas por vírgula', async () => {
    process.env.OPS_ALERT_WEBHOOK_URL =
      'https://hooks.example.com/slack, https://meu-n8n.example.com/webhook/abc ';
    vi.resetModules();

    const axios = (await import('axios')).default;
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200 } as any);

    const { reportContractDrift } = await import('../contractGuard.js');
    reportContractDrift('createPayment', { foo: 'bar' });

    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(postSpy).toHaveBeenCalledWith(
      'https://hooks.example.com/slack',
      expect.objectContaining({ text: expect.any(String), content: expect.any(String) }),
      expect.any(Object)
    );
    expect(postSpy).toHaveBeenCalledWith(
      'https://meu-n8n.example.com/webhook/abc',
      expect.objectContaining({ text: expect.any(String), content: expect.any(String) }),
      expect.any(Object)
    );
  });

  it('não dispara nenhum webhook quando OPS_ALERT_WEBHOOK_URL está vazia', async () => {
    delete process.env.OPS_ALERT_WEBHOOK_URL;
    vi.resetModules();

    const axios = (await import('axios')).default;
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200 } as any);

    const { reportContractDrift } = await import('../contractGuard.js');
    reportContractDrift('createPayment', { foo: 'bar' });

    expect(postSpy).not.toHaveBeenCalled();
  });
});

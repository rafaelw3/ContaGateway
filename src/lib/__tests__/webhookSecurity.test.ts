import { describe, it, expect } from 'vitest';
import { assertPublicWebhookUrl } from '../webhookSecurity.js';

describe('assertPublicWebhookUrl (guard de SSRF)', () => {
  it('bloqueia IPs de metadata de nuvem (169.254.169.254)', async () => {
    await expect(assertPublicWebhookUrl('https://169.254.169.254/latest/meta-data')).rejects.toThrow();
  });

  it('bloqueia loopback', async () => {
    await expect(assertPublicWebhookUrl('https://127.0.0.1:8080/hook')).rejects.toThrow();
  });

  it('bloqueia hostname localhost', async () => {
    await expect(assertPublicWebhookUrl('https://localhost/hook')).rejects.toThrow();
  });

  it('bloqueia faixas privadas RFC1918', async () => {
    await expect(assertPublicWebhookUrl('https://192.168.1.5/hook')).rejects.toThrow();
    await expect(assertPublicWebhookUrl('https://10.0.0.1/hook')).rejects.toThrow();
    await expect(assertPublicWebhookUrl('https://172.16.0.1/hook')).rejects.toThrow();
  });

  it('bloqueia protocolos diferentes de https', async () => {
    await expect(assertPublicWebhookUrl('ftp://example.com/hook')).rejects.toThrow();
  });

  it('bloqueia http mesmo para host público (o despacho só entrega em https)', async () => {
    // Antes era aceito na criação e só falhava no despacho, depois do pagamento
    // já confirmado: o integrador nunca recebia a notificação.
    await expect(assertPublicWebhookUrl('http://8.8.8.8/hook')).rejects.toThrow(/https/);
  });

  it('bloqueia URL malformada', async () => {
    await expect(assertPublicWebhookUrl('not-a-url')).rejects.toThrow();
  });

  it('permite host público com IP literal', async () => {
    await expect(assertPublicWebhookUrl('https://8.8.8.8/hook')).resolves.not.toThrow();
  });

  // Depende de DNS de saída (resolve um domínio público real).
  it('permite host público via DNS', async () => {
    await expect(assertPublicWebhookUrl('https://example.com/hook')).resolves.not.toThrow();
  });
});

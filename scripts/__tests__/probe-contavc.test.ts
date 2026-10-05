import { describe, it, expect } from 'vitest';
import {
  extractScriptUrls,
  scanForContract,
  runProbe,
  exitCodeFor,
  maskHandle,
  type GetResponse,
  type HttpGet,
} from '../probe-contavc.js';

const INTENT_URL = 'https://app.exemplo.invalid/api/pay/intent';

const BUNDLE_OK =
  'const r=await fetch("/api/pay/intent",{method:"POST",body:JSON.stringify({handle:h,amountCents:c,message:m})});' +
  'const {qrId:q,emv:e,expiresAt:x}=await r.json();';

/** Rede falsa em memória: responde por URL e grava tudo que foi pedido. */
function fakeNet(routes: Record<string, Partial<GetResponse>>) {
  const calls: string[] = [];
  const get: HttpGet = async (url) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([pattern]) => url.startsWith(pattern));
    if (!hit) return { status: 404, contentType: 'text/plain', body: 'not found' };
    return { status: 200, contentType: 'text/html', body: '', ...hit[1] };
  };
  return { get, calls };
}

describe('extractScriptUrls', () => {
  it('pega scripts e modulepreload da mesma origem, ignora terceiros', () => {
    const html = `
      <script src="/_next/static/chunks/main.js"></script>
      <script defer src="https://app.exemplo.invalid/app.js"></script>
      <link rel="modulepreload" href="/assets/pay.js">
      <script src="https://cdn.terceiro.invalid/analytics.js"></script>`;
    expect(extractScriptUrls(html, 'https://app.exemplo.invalid/pay/fulano')).toEqual([
      'https://app.exemplo.invalid/_next/static/chunks/main.js',
      'https://app.exemplo.invalid/app.js',
      'https://app.exemplo.invalid/assets/pay.js',
    ]);
  });
});

describe('scanForContract', () => {
  it('acha o caminho e todos os campos num bundle minificado', () => {
    const r = scanForContract(BUNDLE_OK, '/api/pay/intent');
    expect(r.pathFound).toBe(true);
    expect(Object.values(r.fields).every(Boolean)).toBe(true);
  });

  it('não confunde /api/pay/intents com /api/pay/intent', () => {
    expect(scanForContract('fetch("/api/pay/intents")', '/api/pay/intent').pathFound).toBe(false);
    expect(scanForContract('fetch(`/api/pay/intent/${id}`)', '/api/pay/intent').pathFound).toBe(true);
  });

  it('não conta "emv" dentro de outra palavra (ex: remove)', () => {
    expect(scanForContract('el.remove()', '/x').fields.emv).toBe(false);
  });
});

describe('runProbe', () => {
  it('tudo presente → OK e código de saída 0', async () => {
    const net = fakeNet({
      'https://app.exemplo.invalid/pay/': { body: '<script src="/pay.js"></script>' },
      'https://app.exemplo.invalid/pay.js': { body: BUNDLE_OK, contentType: 'application/javascript' },
      [`${INTENT_URL}/`]: { status: 404, contentType: 'application/json', body: '{"error":"not found"}' },
    });

    const results = await runProbe({ intentUrl: INTENT_URL, handle: 'fulano', get: net.get });

    expect(results.map((r) => [r.check, r.status])).toEqual([
      ['pagina_checkout', 'OK'],
      ['bundle_checkout', 'OK'],
      ['consulta_intent', 'INFO'],
    ]);
    expect(results[2].data).toMatchObject({ httpStatus: 404, jsonKeys: ['error'] });
    expect(exitCodeFor(results)).toBe(0);
  });

  it('campo renomeado no bundle (emv → pixCode) → DRIFT e código 1', async () => {
    const net = fakeNet({
      'https://app.exemplo.invalid/pay/': { body: '<script src="/pay.js"></script>' },
      'https://app.exemplo.invalid/pay.js': { body: BUNDLE_OK.replace('emv:', 'pixCode:') },
    });

    const results = await runProbe({ intentUrl: INTENT_URL, handle: 'fulano', get: net.get });
    const bundle = results.find((r) => r.check === 'bundle_checkout')!;

    expect(bundle.status).toBe('DRIFT');
    expect(bundle.detail).toMatch(/emv/);
    expect(exitCodeFor(results)).toBe(1);
  });

  it('página de checkout sumiu → DRIFT', async () => {
    const net = fakeNet({});
    const results = await runProbe({ intentUrl: INTENT_URL, handle: 'fulano', get: net.get });
    expect(results.find((r) => r.check === 'pagina_checkout')?.status).toBe('DRIFT');
  });

  it('caminho do intent ausente do bundle → INCONCLUSIVO (não afirma drift sem prova)', async () => {
    const net = fakeNet({
      'https://app.exemplo.invalid/pay/': { body: '<script src="/pay.js"></script>' },
      'https://app.exemplo.invalid/pay.js': { body: 'console.log("lazy")' },
    });
    const results = await runProbe({ intentUrl: INTENT_URL, handle: 'fulano', get: net.get });
    expect(results.find((r) => r.check === 'bundle_checkout')?.status).toBe('INCONCLUSIVO');
    expect(exitCodeFor(results)).toBe(3);
  });

  it('só acessa a origem do intent e nunca expõe o handle inteiro no relatório', async () => {
    const net = fakeNet({
      'https://app.exemplo.invalid/pay/': {
        body: '<script src="/pay.js"></script><script src="https://cdn.terceiro.invalid/x.js"></script>',
      },
      'https://app.exemplo.invalid/pay.js': { body: BUNDLE_OK },
    });

    const results = await runProbe({ intentUrl: INTENT_URL, handle: 'handle_secreto', get: net.get });

    expect(net.calls.every((u) => u.startsWith('https://app.exemplo.invalid/'))).toBe(true);
    expect(JSON.stringify(results)).not.toContain('handle_secreto');
  });

  it('403/429 (WAF, rate limit, proxy) → ERRO, nunca DRIFT, e não analisa bundle', async () => {
    for (const status of [403, 429]) {
      const net = fakeNet({ 'https://app.exemplo.invalid/': { status, contentType: 'text/plain', body: 'blocked' } });
      const results = await runProbe({ intentUrl: INTENT_URL, handle: 'fulano', get: net.get });

      expect(results.find((r) => r.check === 'pagina_checkout')?.status).toBe('ERRO');
      expect(results.some((r) => r.check === 'bundle_checkout')).toBe(false);
      expect(exitCodeFor(results)).toBe(2);
    }
  });

  it('erro de rede → ERRO e código 2', async () => {
    const get: HttpGet = async () => {
      throw new Error('ECONNREFUSED');
    };
    const results = await runProbe({ intentUrl: INTENT_URL, handle: 'fulano', get });
    expect(results.every((r) => r.status === 'ERRO')).toBe(true);
    expect(exitCodeFor(results)).toBe(2);
  });
});

describe('maskHandle', () => {
  it('mostra só os dois primeiros caracteres', () => {
    expect(maskHandle('fulano')).toBe('fu***');
    expect(maskHandle('ab')).toBe('***');
  });
});

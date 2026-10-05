#!/usr/bin/env -S npx tsx
/**
 * Sonda manual, SÓ LEITURA, para responder "o endpoint interno da conta.vc
 * mudou?" sem criar cobrança. Roda localmente, sob demanda:
 *
 *   npm run probe:contavc            # relatório legível
 *   npm run probe:contavc -- --json  # relatório em JSON (para comparar execuções)
 *
 * Por que não um POST de teste: o canário sintético foi rejeitado de propósito
 * (DECISIONS.md, 2026-09-17) — POST em /api/pay/intent cria cobrança Pix real
 * e exige confirmação explícita a cada vez (regra do projeto: nunca criar cobrança real sem decisão humana). Esta sonda só faz
 * GET, em três lugares que a própria página pública de checkout já expõe a
 * qualquer navegador:
 *
 *   1. a página `/pay/<handle>` ainda existe;
 *   2. o JavaScript dessa página ainda chama o caminho do intent e ainda usa
 *      os nomes de campo que o PaymentService envia/lê (handle, amountCents,
 *      qrId, emv, expiresAt) — se o checkout deles mudou o contrato, o bundle
 *      mudou junto;
 *   3. a consulta `GET <intent>/<qrId-inexistente>` (a mesma que o
 *      getIntentStatus usa) — só registra status e tipo de conteúdo.
 *
 * Nunca roda em CI nem agendada: é tráfego para um terceiro, gerado só quando
 * alguém decide investigar. O número de requisições é limitado (página + até
 * MAX_SCRIPTS arquivos JS + 1 consulta).
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const DEFAULT_INTENT_URL = 'https://app.conta.vc/api/pay/intent';
export const CONTRACT_FIELDS = ['handle', 'amountCents', 'qrId', 'emv', 'expiresAt'] as const;
export const MAX_SCRIPTS = 40;

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
};

// Respostas que dizem "você foi barrado", não "a rota mudou": WAF/desafio
// anti-bot, rate limit, proxy corporativo. Não dá para concluir nada delas.
const BLOCKED_STATUSES = new Set([401, 403, 429, 503]);

export type CheckStatus = 'OK' | 'DRIFT' | 'INCONCLUSIVO' | 'INFO' | 'ERRO';

export interface CheckResult {
  check: string;
  status: CheckStatus;
  detail: string;
  data?: Record<string, unknown>;
}

export interface GetResponse {
  status: number;
  contentType: string;
  body: string;
}

/** Único meio de acesso à rede da sonda: GET e nada mais, por construção. */
export type HttpGet = (url: string) => Promise<GetResponse>;

export const fetchGet: HttpGet = async (url) => {
  const res = await fetch(url, { method: 'GET', headers: BROWSER_HEADERS, signal: AbortSignal.timeout(15_000) });
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: await res.text() };
};

/** Mascara o handle para o relatório poder ser colado em issue/chat sem expô-lo inteiro. */
export function maskHandle(handle: string): string {
  return handle.length <= 2 ? '***' : `${handle.slice(0, 2)}***`;
}

/** URLs de `<script src>` e `<link rel=modulepreload>` da mesma origem da página. */
export function extractScriptUrls(html: string, pageUrl: string): string[] {
  const origin = new URL(pageUrl).origin;
  const found = new Set<string>();
  const patterns = [
    /<script\b[^>]*\bsrc=["']([^"']+)["']/gi,
    /<link\b[^>]*\brel=["']modulepreload["'][^>]*\bhref=["']([^"']+)["']/gi,
    /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']modulepreload["']/gi,
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      try {
        const url = new URL(match[1], pageUrl);
        if (url.origin === origin) found.add(url.href);
      } catch {
        // src malformado: ignora
      }
    }
  }

  return [...found].slice(0, MAX_SCRIPTS);
}

/** Procura o caminho do intent e os nomes de campo do contrato num texto JS. */
export function scanForContract(js: string, intentPath: string) {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Aceita "/api/pay/intent" seguido de fim de string, barra ou template —
  // mas não "/api/pay/intents" (outro endpoint).
  const pathFound = new RegExp(`${escape(intentPath)}(?![\\w-])`).test(js);
  const fields = Object.fromEntries(
    CONTRACT_FIELDS.map((field) => [field, new RegExp(`(?<![\\w$])${field}(?![\\w$])`).test(js)])
  ) as Record<(typeof CONTRACT_FIELDS)[number], boolean>;
  return { pathFound, fields };
}

export async function runProbe(opts: { intentUrl: string; handle: string; get: HttpGet }): Promise<CheckResult[]> {
  const { intentUrl, handle, get } = opts;
  const intent = new URL(intentUrl);
  const intentPath = intent.pathname.replace(/\/+$/, '');
  const pageUrl = `${intent.origin}/pay/${encodeURIComponent(handle)}`;
  const results: CheckResult[] = [];

  // 1. Página pública de checkout
  let html = '';
  try {
    const page = await get(pageUrl);
    const ok = page.status === 200 && page.contentType.includes('text/html');
    if (ok) html = page.body;
    if (BLOCKED_STATUSES.has(page.status)) {
      results.push({
        check: 'pagina_checkout',
        status: 'ERRO',
        detail: `GET /pay/${maskHandle(handle)} → ${page.status}: acesso bloqueado (WAF, rate limit ou proxy de rede) — nada a concluir; tente de outra rede ou mais tarde`,
        data: { httpStatus: page.status, contentType: page.contentType },
      });
    } else {
      results.push({
        check: 'pagina_checkout',
        status: ok ? 'OK' : 'DRIFT',
        detail: ok
          ? `GET /pay/${maskHandle(handle)} → 200 HTML`
          : `GET /pay/${maskHandle(handle)} → ${page.status} (${page.contentType || 'sem content-type'}); esperado 200 HTML — rota de checkout mudou, ou o link público do handle está desativado`,
        data: { httpStatus: page.status, contentType: page.contentType },
      });
    }
  } catch (err) {
    results.push({ check: 'pagina_checkout', status: 'ERRO', detail: `falha de rede: ${(err as Error).message}` });
  }

  // 2. Bundle JS do checkout
  if (html) {
    const scriptUrls = extractScriptUrls(html, pageUrl);
    let combined = html; // scripts inline também contam
    let fetched = 0;
    for (const url of scriptUrls) {
      try {
        const res = await get(url);
        if (res.status === 200) {
          combined += '\n' + res.body;
          fetched++;
        }
      } catch {
        // um chunk que falha não invalida os outros
      }
    }

    const { pathFound, fields } = scanForContract(combined, intentPath);
    const missing = CONTRACT_FIELDS.filter((f) => !fields[f]);
    const data = { scriptsFound: scriptUrls.length, scriptsFetched: fetched, intentPathFound: pathFound, fields };

    if (!pathFound) {
      results.push({
        check: 'bundle_checkout',
        status: 'INCONCLUSIVO',
        detail: `"${intentPath}" não aparece nos ${fetched} scripts carregados pela página — pode estar num chunk carregado sob demanda, ou o checkout passou a usar outro endpoint. Investigar no DevTools (aba Network) ao gerar um QR manualmente.`,
        data,
      });
    } else if (missing.length > 0) {
      results.push({
        check: 'bundle_checkout',
        status: 'DRIFT',
        detail: `"${intentPath}" continua no bundle, mas estes campos do contrato sumiram: ${missing.join(', ')}`,
        data,
      });
    } else {
      results.push({
        check: 'bundle_checkout',
        status: 'OK',
        detail: `"${intentPath}" e todos os campos do contrato (${CONTRACT_FIELDS.join(', ')}) presentes no bundle`,
        data,
      });
    }
  }

  // 3. Consulta de status com qrId inexistente (mesma forma do getIntentStatus)
  const fakeQrId = `probe-${randomBytes(8).toString('hex')}`;
  try {
    const res = await get(`${intentUrl.replace(/\/+$/, '')}/${fakeQrId}`);
    let jsonKeys: string[] | null = null;
    try {
      const parsed = JSON.parse(res.body);
      jsonKeys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : [];
    } catch {
      jsonKeys = null;
    }
    results.push({
      check: 'consulta_intent',
      status: 'INFO',
      detail: `GET ${intentPath}/<qrId inexistente> → ${res.status} ${jsonKeys ? `JSON com chaves [${jsonKeys.join(', ')}]` : `não-JSON (${res.contentType || 'sem content-type'})`}. Compare com a execução anterior: mudança aqui sugere mudança no endpoint.`,
      data: { httpStatus: res.status, contentType: res.contentType, jsonKeys },
    });
  } catch (err) {
    results.push({ check: 'consulta_intent', status: 'ERRO', detail: `falha de rede: ${(err as Error).message}` });
  }

  return results;
}

/** 0 = nada mudou; 1 = drift; 2 = erro de rede; 3 = só inconclusivo. */
export function exitCodeFor(results: CheckResult[]): number {
  if (results.some((r) => r.status === 'DRIFT')) return 1;
  if (results.some((r) => r.status === 'ERRO')) return 2;
  if (results.some((r) => r.status === 'INCONCLUSIVO')) return 3;
  return 0;
}

async function main() {
  const handle = process.env.CONTA_VC_USERNAME?.trim();
  if (!handle) {
    console.error('CONTA_VC_USERNAME não está definido no .env — a sonda precisa do handle para achar a página de checkout.');
    process.exitCode = 2;
    return;
  }
  const intentUrl = process.env.CONTA_VC_INTENT_URL || DEFAULT_INTENT_URL;

  const results = await runProbe({ intentUrl, handle, get: fetchGet });
  const exitCode = exitCodeFor(results);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ at: new Date().toISOString(), intentUrl, results, exitCode }, null, 2));
  } else {
    console.log(`\nSonda da conta.vc (só GET) — ${intentUrl}\n`);
    for (const r of results) {
      console.log(`  [${r.status}] ${r.check}: ${r.detail}`);
    }
    console.log(
      exitCode === 0
        ? '\nNenhum sinal de mudança. Isso não prova que o POST continua igual — só que o checkout público continua falando o mesmo contrato.\n'
        : '\nHá sinal de mudança ou resultado inconclusivo. Confirme gerando um QR manualmente pela página da conta.vc (DevTools → Network) antes de qualquer POST pelo ContaGateway.\n'
    );
  }

  process.exitCode = exitCode;
}

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error('Erro inesperado na sonda:', err);
    process.exitCode = 2;
  });
}

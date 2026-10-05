import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc16Ccitt } from '../../../lib/pixEmv.js';

/**
 * Monta um BR Code Pix válido (com CRC correto) para usar como resposta
 * falsa da conta.vc. Sem `amountCents`, gera um QR sem o campo 54 (valor em
 * aberto), como um QR dinâmico pode vir.
 */
export function buildPixEmv(amountCents?: number): string {
  const tlv = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;
  const account = tlv('00', 'br.gov.bcb.pix') + tlv('25', 'qr.exemplo.invalid/v2/cobv/abc123');
  const body =
    tlv('00', '01') +
    tlv('01', '12') +
    tlv('26', account) +
    tlv('52', '0000') +
    tlv('53', '986') +
    (amountCents !== undefined ? tlv('54', (amountCents / 100).toFixed(2)) : '') +
    tlv('58', 'BR') +
    tlv('59', 'TESTE') +
    tlv('60', 'SAO PAULO') +
    tlv('62', tlv('05', '***')) +
    '6304';
  return body + crc16Ccitt(body);
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

type FakeResponse = { status: number; body: unknown; contentType?: string };

export type FakeHandler = (req: RecordedRequest) => FakeResponse | Promise<FakeResponse>;

/**
 * Servidor HTTP local que se passa pelo endpoint interno da conta.vc. Grava
 * toda requisição recebida (para testar o formato do que ENVIAMOS) e responde
 * com o que o teste mandar (para testar como reagimos a uma mudança no que
 * RECEBEMOS). Nunca sai de 127.0.0.1.
 */
export async function startContaVcFake(): Promise<{
  intentUrl: string;
  requests: RecordedRequest[];
  respondWith: (handler: FakeHandler) => void;
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  let handler: FakeHandler = () => ({ status: 500, body: { error: 'handler não configurado' } });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      const recorded: RecordedRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      requests.push(recorded);
      const out = await handler(recorded);
      const payload = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
      res.writeHead(out.status, { 'Content-Type': out.contentType ?? 'application/json' });
      res.end(payload);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    intentUrl: `http://127.0.0.1:${port}/api/pay/intent`,
    requests,
    respondWith: (h) => {
      handler = h;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

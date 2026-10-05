import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * `as any` nos dados de escrita do Prisma desliga a checagem de campos: um
 * `webhookStatuss: 'FAILED'` compilava calado e só estourava em runtime — no
 * ramo de falha do webhook, isso é nunca registrar a falha de entrega, o
 * estado de que o reenvio manual (`npm run webhook:resend`) depende.
 */
const servicesDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serviceFiles = readdirSync(servicesDir).filter((f) => f.endsWith('.ts'));

describe('services — sem `as any` (a checagem de tipos do Prisma fica ligada)', () => {
  it('lista os arquivos de service (o teste não pode passar vazio)', () => {
    expect(serviceFiles).toEqual(expect.arrayContaining(['PaymentService.ts', 'WebhookService.ts', 'Web3Listener.ts']));
  });

  it.each(serviceFiles)('%s não usa `as any`', (file) => {
    const source = readFileSync(path.join(servicesDir, file), 'utf8');
    expect(source).not.toMatch(/\bas any\b/);
  });
});

describe('Payment vem do tipo gerado pelo Prisma', () => {
  const prismaLib = readFileSync(path.join(servicesDir, '..', 'lib', 'prisma.ts'), 'utf8');

  it('lib/prisma.ts reexporta o tipo gerado, sem interface escrita à mão', () => {
    // Uma interface manual sai de sincronia com o schema em silêncio (ela não
    // tinha paidAt até alguém lembrar de acrescentar) e obrigava casts.
    expect(prismaLib).not.toMatch(/^\s*(export\s+)?interface\s+Payment\b/m);
    expect(prismaLib).toMatch(/export type \{ Payment \} from '[^']*\.prisma\/client/);
  });

  it.each(serviceFiles)('%s não força o tipo com `as unknown as Payment`', (file) => {
    const source = readFileSync(path.join(servicesDir, file), 'utf8');
    expect(source).not.toMatch(/as unknown as Payment\b/);
  });
});


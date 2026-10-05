import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const BLOCKED_HOSTNAME_SUFFIXES = ['.local', '.internal', '.localhost'];
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

/**
 * Checa se um IPv4/IPv6 pertence a uma faixa privada, loopback, link-local
 * (inclui 169.254.169.254, usado por metadata services de nuvem) ou reservada.
 */
function isPrivateOrReservedIp(ip: string): boolean {
  const version = isIP(ip);

  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast/reservado
    return false;
  }

  if (version === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice('::ffff:'.length);
      return isIP(mapped) === 4 ? isPrivateOrReservedIp(mapped) : true;
    }
    if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7 (unique local)
    if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // fe80::/10 (link-local)
    return false;
  }

  return true; // valor não reconhecido como IP: trata como suspeito
}

/**
 * Garante que webhookUrl aponta para um host público, mitigando SSRF via
 * endpoints internos, loopback ou de metadata de nuvem (ex: 169.254.169.254).
 * Resolve o DNS para também bloquear hostnames que apontam para IPs privados.
 */
export async function assertPublicWebhookUrl(rawUrl: string): Promise<void> {
  const parsed = new URL(rawUrl);

  // Só https: o WebhookService recusa despachar para http (ver dispatch), então
  // aceitar http aqui criava uma cobrança cujo webhook falharia sempre, em
  // silêncio, só depois de o pagador já ter pago.
  if (parsed.protocol !== 'https:') {
    throw new Error('webhookUrl deve ser uma URL válida com protocolo https.');
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new Error('webhookUrl aponta para um host não permitido.');
  }

  if (isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new Error('webhookUrl não pode apontar para um endereço IP privado ou reservado.');
    }
    return;
  }

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Não foi possível resolver o host informado em webhookUrl.');
  }

  if (addresses.length === 0 || addresses.some((addr) => isPrivateOrReservedIp(addr.address))) {
    throw new Error('webhookUrl resolve para um endereço IP privado ou reservado.');
  }
}

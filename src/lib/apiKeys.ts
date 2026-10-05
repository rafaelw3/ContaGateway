import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * `API_KEY` aceita uma ou mais chaves separadas por vírgula, para trocar a
 * chave sem downtime: `API_KEY="nova,antiga"` → integradores migram para a
 * nova → remove a antiga. Espaços em volta e entradas vazias são ignorados.
 */
export function parseApiKeys(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Compara a chave recebida com cada chave válida em tempo constante. `!==` em
 * string retorna no primeiro caractere diferente, e o tempo de resposta vaza
 * quantos caracteres do prefixo estão certos. Os dois lados passam por
 * SHA-256 antes para ter o mesmo tamanho (timingSafeEqual exige isso) sem
 * vazar o tamanho da chave real. Compara contra todas, sem parar na primeira
 * que bate, para o tempo não revelar qual posição da lista casou. Lista vazia
 * nunca casa: falha fechada.
 */
export function apiKeyMatches(provided: string, validKeys: string[]): boolean {
  const providedDigest = digest(provided);
  let matched = false;
  for (const key of validKeys) {
    matched = timingSafeEqual(providedDigest, digest(key)) || matched;
  }
  return matched;
}

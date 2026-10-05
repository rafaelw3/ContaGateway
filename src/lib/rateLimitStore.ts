import { Redis } from 'ioredis';
import { logger } from './logger.js';

/**
 * Retorna uma instância de Redis para uso no rate-limiter se REDIS_URL
 * estiver configurado; caso contrário retorna undefined e o rate-limiter
 * usa armazenamento em memória (comportamento padrão, adequado para
 * instância única). Ver ARCHITECTURE_AUDIT.md item 3.
 *
 * O Redis nunca é obrigatório — ausência de REDIS_URL não é erro de boot,
 * só uma limitação documentada ao escalar além de 1 réplica.
 */
export function createRedisClient(): Redis | undefined {
  const url = process.env.REDIS_URL;
  if (!url) return undefined;

  const client = new Redis(url, {
    // Falha rápido se o Redis estiver inacessível no boot em vez de
    // travar indefinidamente — a app sobe degradada (memória) em vez de
    // não subir.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    lazyConnect: true,
  });

  client.on('error', (err) => {
    logger.warn({ err }, '[RateLimit] Erro na conexão Redis — rate limit operando em memória (instância local).');
  });

  return client;
}

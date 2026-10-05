import QRCode from 'qrcode';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

/**
 * Cache TTL simples com eviction FIFO. O payload Pix (pixPayload) de um
 * pagamento é imutável, então o QR Code gerado a partir dele pode ser
 * reaproveitado entre requisições — evita regenerar a imagem (CPU-bound)
 * a cada hit em /qrcode ou /pay/:id.
 */
class SimpleTtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return entry.value;
  }

  set(key: string, value: T): void {
    if (!this.store.has(key) && this.store.size >= CACHE_MAX_ENTRIES) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }

    this.store.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}

export class QRCodeService {
  private readonly dataUrlCache = new SimpleTtlCache<string>();
  private readonly pngCache = new SimpleTtlCache<Buffer>();

  /**
   * Gera o QR Code em formato Data URL (base64) pronto para uso em tags <img src="...">
   */
  async generateDataURL(text: string): Promise<string> {
    if (!text) {
      throw new Error('Texto para geração do QR Code não fornecido.');
    }

    const cached = this.dataUrlCache.get(text);
    if (cached) return cached;

    const dataUrl = await QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 2,
      scale: 8,
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
    });

    this.dataUrlCache.set(text, dataUrl);
    return dataUrl;
  }

  /**
   * Gera o QR Code como um Buffer binário de imagem PNG em alta resolução
   */
  async generatePNG(text: string): Promise<Buffer> {
    if (!text) {
      throw new Error('Texto para geração do QR Code não fornecido.');
    }

    const cached = this.pngCache.get(text);
    if (cached) return cached;

    const png = await QRCode.toBuffer(text, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 2,
      scale: 10,
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
    });

    this.pngCache.set(text, png);
    return png;
  }
}

export const qrCodeService = new QRCodeService();

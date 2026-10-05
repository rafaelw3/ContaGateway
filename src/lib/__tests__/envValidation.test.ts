import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertRequiredEnv } from '../envValidation.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('assertRequiredEnv', () => {
  it('não lança quando tudo está configurado corretamente', () => {
    process.env.RECIPIENT_WALLET_ADDRESS = '0x1234567890123456789012345678901234567890';
    process.env.API_KEY = 'alguma-chave';
    process.env.DATABASE_URL = 'postgresql://localhost/db';
    process.env.NODE_ENV = 'production';

    expect(() => assertRequiredEnv()).not.toThrow();
  });

  it('sempre lança se DATABASE_URL estiver ausente, mesmo fora de produção', () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'development';

    expect(() => assertRequiredEnv()).toThrow(/DATABASE_URL/);
  });

  it('fora de produção, só avisa (não lança) se RECIPIENT_WALLET_ADDRESS estiver no endereço zero', () => {
    process.env.RECIPIENT_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
    process.env.DATABASE_URL = 'postgresql://localhost/db';
    process.env.NODE_ENV = 'development';
    delete process.env.API_KEY;

    expect(() => assertRequiredEnv()).not.toThrow();
  });

  it('em produção, lança se RECIPIENT_WALLET_ADDRESS estiver ausente ou no endereço zero', () => {
    process.env.RECIPIENT_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
    process.env.API_KEY = 'alguma-chave';
    process.env.DATABASE_URL = 'postgresql://localhost/db';
    process.env.NODE_ENV = 'production';

    expect(() => assertRequiredEnv()).toThrow(/RECIPIENT_WALLET_ADDRESS/);
  });

  it('em produção, lança se API_KEY estiver ausente', () => {
    process.env.RECIPIENT_WALLET_ADDRESS = '0x1234567890123456789012345678901234567890';
    process.env.DATABASE_URL = 'postgresql://localhost/db';
    process.env.NODE_ENV = 'production';
    delete process.env.API_KEY;

    expect(() => assertRequiredEnv()).toThrow(/API_KEY/);
  });

  it('em produção, lança se API_KEY só tiver vírgulas (nenhuma chave útil)', () => {
    process.env.RECIPIENT_WALLET_ADDRESS = '0x1234567890123456789012345678901234567890';
    process.env.DATABASE_URL = 'postgresql://localhost/db';
    process.env.NODE_ENV = 'production';
    process.env.API_KEY = ' , ';

    expect(() => assertRequiredEnv()).toThrow(/API_KEY/);
  });

  it('em produção, aceita API_KEY com duas chaves (troca em andamento)', () => {
    process.env.RECIPIENT_WALLET_ADDRESS = '0x1234567890123456789012345678901234567890';
    process.env.DATABASE_URL = 'postgresql://localhost/db';
    process.env.NODE_ENV = 'production';
    process.env.API_KEY = 'chave-nova,chave-antiga';

    expect(() => assertRequiredEnv()).not.toThrow();
  });
});

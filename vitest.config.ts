import { defineConfig } from 'vitest/config';

export default defineConfig({
  // O Vite/Vitest carrega automaticamente os arquivos .env do diretório raiz
  // para process.env. Sem isto, o `.env` de desenvolvimento (com conta.vc,
  // carteira e BRLA_RESERVE_ADDRESS reais) vazava para os testes e mudava o
  // comportamento deles. Apontando o envDir para `test/` (que não tem .env),
  // o único ambiente da suíte é o `.env.test` carregado em test/setup.ts.
  envDir: './test',
  test: {
    globals: false,
    environment: 'node',
    // Só os testes-fonte. Sem isto, o Vitest 5 também roda as cópias
    // compiladas em dist/ (vindas do `npm run build`), duplicando a suíte.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
    // Testes de concorrência disputam as mesmas linhas/tabela; rodar em série
    // evita falsos positivos por dois arquivos de teste colidindo entre si.
    fileParallelism: false,
  },
});

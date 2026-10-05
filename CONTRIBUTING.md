# Contributing

Small, focused contributions (fixes, docs, tests) are welcome.

1. Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) first. The layering is strict:
   thin routes → services (business logic + Prisma) → `lib/` (no business logic).
2. Set up: `npm ci && npm run prisma:generate && npm run db:up && npm run test:migrate`.
3. Before opening a PR: `npm run typecheck && npm test`. Tests use `.env.test` with fake
   endpoints, so they never call conta.vc or a real RPC.
4. Changing a route, env var or architectural decision? Update `README.md`,
   `ARCHITECTURE.md` and/or `DECISIONS.md` in the same PR.
5. Touching `Web3Listener.ts`? Understand why **only the cBRL mint decides settlement**
   (README, "How it works") — using BRLA as the signal reintroduces the original bug.

Never create real Pix charges from tests or scripts — the upstream endpoint has no sandbox.

Discussion and code may be in Portuguese or English.

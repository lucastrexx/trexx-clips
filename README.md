# Trexx Clips — MVP (Stellar Testnet + Soroban + x402)

Flow: sponsor creates a campaign in the API → `create_campaign` + `approve` + `fund` on **campaign-escrow** (20% platform / 80% pool in the contract) → creator registers a clip with **x402** (`POST /api/clips`) → simulated views → `POST /api/campaigns/:id/settle` calls `payout` on Soroban.

## Requirements

- Node 20+
- Rust + `wasm32-unknown-unknown` (to compile the contract)
- [Stellar CLI](https://developers.stellar.org/docs/tools/cli/install) for deploy
- [Freighter](https://www.freighter.app/) extension in Brave/Chrome, **Testnet**

## Soroban contract

```bash
cd contracts/campaign-escrow
cargo build --target wasm32-unknown-unknown --release
# WASM: target/wasm32-unknown-unknown/release/campaign_escrow.wasm
```

Deploy and `ESCROW_CONTRACT_ID`: see [contracts/README.md](contracts/README.md).

Initialize **once** after deploy (operator = same account that signs `payout` in the backend):

```bash
cd apps/api
cp .env.example .env
# fill ESCROW_CONTRACT_ID, OPERATOR_SECRET, PLATFORM_PUBLIC_KEY, X402_PAY_TO
npm run init-escrow
```

## API

```bash
cd apps/api
npm install
npm run dev
# http://localhost:8787 — Vite proxy points here
```

Main routes: `GET /api/config`, `POST /api/campaigns`, `POST /api/clips` (x402), `PATCH /api/clips/:id/views`, `POST /api/campaigns/:id/settle`.

## Frontend

```bash
cd apps/web
npm install
npm run dev
```

Open http://localhost:5173 and connect Freighter. The sponsor needs **testnet USDC** on the SEP-41 contract (same issuer as Stellar/x402 docs).

## Monorepo (root)

```bash
npm install
npm run dev:api    # terminal 1
npm run dev:web    # terminal 2
```

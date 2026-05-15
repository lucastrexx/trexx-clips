# campaign-escrow (Soroban)

Escrow contract for the **Trexx Clips** MVP:

- `initialize(operator, platform, token)` — once after deploy.
- `create_campaign(sponsor, campaign_id, payout_per_milestone)` — creates the campaign slot (`campaign_id` should match the `id` returned by the API).
- `fund(sponsor, campaign_id, amount)` — sponsor must first `approve` on the SEP-41 token for **this contract address** as `spender`. 20% goes to `platform`, 80% enters the `pool` held by the contract.
- `payout(operator, campaign_id, creator, amount)` — `operator` only; moves tokens from the contract to the creator.
- `get_campaign(campaign_id)` — read state.

## Build (recommended — Soroban VM–compatible)

`cargo build --target wasm32-unknown-unknown` may produce WASM with features Soroban rejects (e.g. `reference-types`). Use the **Stellar CLI**:

```bash
rustup target add wasm32v1-none
cd contracts/campaign-escrow
stellar network use testnet
stellar contract build
```

Typical output: `target/wasm32v1-none/release/campaign_escrow.wasm`.

`Cargo.toml` includes `[profile.release]` with `overflow-checks = true` (required by `stellar contract build`).

## Deploy on Testnet

Create / fund an identity (example):

```bash
stellar keys generate my-deploy --fund --network testnet
```

Deploy:

```bash
cd contracts/campaign-escrow
stellar contract deploy \
  --wasm target/wasm32v1-none/release/campaign_escrow.wasm \
  --source my-deploy \
  --network testnet \
  --alias campaign-escrow
```

The CLI prints the **Contract ID** (`C…`). Set `ESCROW_CONTRACT_ID` in `apps/api/.env`.

## Initialization

With the contract deployed, run:

```bash
cd apps/api
npm run init-escrow
```

This calls `initialize` with `OPERATOR_SECRET`, `PLATFORM_PUBLIC_KEY`, and `USDC_CONTRACT_ID` (testnet USDC per Stellar/x402 docs).

**Important:** the address from `OPERATOR_SECRET` must be the **`operator`** the contract expects (only one `initialize` per deploy).

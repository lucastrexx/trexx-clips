#!/usr/bin/env node
/**
 * Single call after WASM deploy:
 * initialize(operator, platform, token_contract_address)
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  rpc,
  TransactionBuilder,
  Address,
} from '@stellar/stellar-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const contractId = process.env.ESCROW_CONTRACT_ID;
const operatorSecret = process.env.OPERATOR_SECRET;
const platform = process.env.PLATFORM_PUBLIC_KEY;
const token = process.env.USDC_CONTRACT_ID || 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

if (!contractId || !operatorSecret || !platform) {
  console.error('Set ESCROW_CONTRACT_ID, OPERATOR_SECRET, and PLATFORM_PUBLIC_KEY.');
  process.exit(1);
}

const server = new rpc.Server(rpcUrl);
const kp = Keypair.fromSecret(operatorSecret);
const account = await server.getAccount(kp.publicKey());
const contract = new Contract(contractId);

const op = contract.call(
  'initialize',
  new Address(kp.publicKey()).toScVal(),
  new Address(platform).toScVal(),
  new Address(token).toScVal(),
);

let tx = new TransactionBuilder(account, {
  fee: BASE_FEE,
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(op)
  .setTimeout(30)
  .build();

const sim = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(sim)) {
  console.error('Simulation failed:', JSON.stringify(sim.error, null, 2));
  process.exit(1);
}

const assembled = rpc.assembleTransaction(tx, sim);
const signedTx = assembled.build();
signedTx.sign(kp);
const sent = await server.sendTransaction(signedTx);
console.log('Status:', sent.status, 'hash:', sent.hash);
if (sent.status !== 'PENDING' && sent.status !== 'SUCCESS') {
  process.exit(1);
}

import {
  BASE_FEE,
  Contract,
  Networks,
  rpc,
  TransactionBuilder,
  Address,
  nativeToScVal,
  Keypair,
} from '@stellar/stellar-sdk';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForSuccessfulRpcTx(server, hash, { timeoutMs = 90_000, intervalMs = 750 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await server.getTransaction(hash);
    if (res.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      await sleep(intervalMs);
      continue;
    }
    if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`transaction failed: ${hash}`);
    }
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return res;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for tx ${hash}`);
}

/**
 * Submit Soroban escrow payout to the creator wallet (must match campaign-escrow contract).
 */
export async function submitPayout({
  rpcUrl,
  contractId,
  operatorSecret,
  campaignId,
  creatorPublicKey,
  amountStroops,
}) {
  const server = new rpc.Server(rpcUrl || 'https://soroban-testnet.stellar.org');
  const keypair = Keypair.fromSecret(operatorSecret);
  const account = await server.getAccount(keypair.publicKey());
  const contract = new Contract(contractId);

  const op = contract.call(
    'payout',
    new Address(keypair.publicKey()).toScVal(),
    nativeToScVal(Number(campaignId), { type: 'u32' }),
    new Address(creatorPublicKey).toScVal(),
    nativeToScVal(String(amountStroops), { type: 'i128' }),
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
    throw new Error(`simulation error: ${JSON.stringify(sim.error)}`);
  }

  const assembled = rpc.assembleTransaction(tx, sim);
  const signedTx = assembled.build();
  signedTx.sign(keypair);
  const sent = await server.sendTransaction(signedTx);

  if (sent.status !== 'PENDING' && sent.status !== 'SUCCESS') {
    throw new Error(`sendTransaction: ${sent.status} ${JSON.stringify(sent)}`);
  }
  if (sent.hash) {
    await waitForSuccessfulRpcTx(server, sent.hash);
  }
  return { hash: sent.hash, status: sent.status };
}

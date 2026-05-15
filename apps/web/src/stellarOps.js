import {
  BASE_FEE,
  Contract,
  Networks,
  rpc,
  TransactionBuilder,
  Transaction,
  Address,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { signTransaction } from '@stellar/freighter-api';
import { convertToTokenAmount } from '@x402/stellar';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Soroban: the next tx needs the account sequence reflected on ledger.
 * Without this, chaining create_campaign → approve → fund hits txBadSeq.
 */
export async function waitForSuccessfulRpcTx(server, hash, { timeoutMs = 90_000, intervalMs = 750 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await server.getTransaction(hash);
    if (res.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      await sleep(intervalMs);
      continue;
    }
    if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(
        `Transaction failed on-chain: ${hash}. Check the testnet explorer.`,
      );
    }
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return res;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for transaction confirmation ${hash}`);
}

/** USDC testnet → stroops (7 decimais) */
export function usdcToStroops(decimalString) {
  return convertToTokenAmount(String(decimalString), 7);
}

export async function runSorobanTx({ rpcUrl, publicKey, buildOperation }) {
  const server = new rpc.Server(rpcUrl);
  const account = await server.getAccount(publicKey);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(buildOperation())
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulation: ${JSON.stringify(sim.error)}`);
  }
  const tb = rpc.assembleTransaction(tx, sim);
  const built = tb.build();
  const signed = await signTransaction(built.toXDR(), {
    networkPassphrase: Networks.TESTNET,
    address: publicKey,
  });
  if (signed.error) {
    throw new Error(signed.error?.message || String(signed.error));
  }
  const finalized = new Transaction(signed.signedTxXdr, Networks.TESTNET);
  const sent = await server.sendTransaction(finalized);
  if (sent.status !== 'PENDING' && sent.status !== 'SUCCESS') {
    throw new Error(`submit: ${sent.status} ${JSON.stringify(sent)}`);
  }
  if (sent.hash) {
    await waitForSuccessfulRpcTx(server, sent.hash);
  }
  return sent;
}

export function opCreateCampaign({ escrowId, sponsor, campaignId, payoutStroops }) {
  const c = new Contract(escrowId);
  return () =>
    c.call(
      'create_campaign',
      new Address(sponsor).toScVal(),
      nativeToScVal(Number(campaignId), { type: 'u32' }),
      nativeToScVal(String(payoutStroops), { type: 'i128' }),
    );
}

export function opApproveUsdc({ usdcId, sponsor, spender, amountStroops, expirationLedger }) {
  const t = new Contract(usdcId);
  return () =>
    t.call(
      'approve',
      new Address(sponsor).toScVal(),
      new Address(spender).toScVal(),
      nativeToScVal(String(amountStroops), { type: 'i128' }),
      nativeToScVal(Number(expirationLedger), { type: 'u32' }),
    );
}

export function opFund({ escrowId, sponsor, campaignId, amountStroops }) {
  const c = new Contract(escrowId);
  return () =>
    c.call(
      'fund',
      new Address(sponsor).toScVal(),
      nativeToScVal(Number(campaignId), { type: 'u32' }),
      nativeToScVal(String(amountStroops), { type: 'i128' }),
    );
}

export async function getLatestLedgerSequence(rpcUrl) {
  const server = new rpc.Server(rpcUrl);
  const cur = await server.getLatestLedger();
  return cur.sequence;
}

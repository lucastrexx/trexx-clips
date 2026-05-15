import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { paymentMiddlewareFromConfig } from '@x402/express';
import { ExactStellarScheme } from '@x402/stellar/exact/server';
import { STELLAR_TESTNET_CAIP2 } from '@x402/stellar';
import { createDb, campaignQueries } from './db.js';
import { submitPayout } from './soroban.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const databasePath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'trexx.db');

const db = createDb(databasePath);
const q = campaignQueries(db);

const app = express();
/** Behind ngrok/Vite proxy, set TRUST_PROXY=1 so req.protocol/https matches the browser for x402. */
const trustProxy = Math.max(0, Number(process.env.TRUST_PROXY ?? '0') || 0);
if (trustProxy > 0) {
  app.set('trust proxy', trustProxy);
}
app.use(
  cors({
    origin: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim()),
    credentials: true,
    // x402 verification/settlement details are in PAYMENT-*; otherwise browser fetch only sees empty body.
    exposedHeaders: [
      'PAYMENT-REQUIRED',
      'PAYMENT-RESPONSE',
      'PAYMENT-SIGNATURE',
      'X-PAYMENT',
      'X-PAYMENT-RESPONSE',
    ],
  }),
);
app.use(express.json({ limit: '1mb' }));

const x402Price = process.env.X402_CLIP_PRICE || '0.01';
const x402PayTo = process.env.X402_PAY_TO || process.env.PLATFORM_PUBLIC_KEY;
/** Absolute paid-resource URL (same path the client calls). Public facilitators cannot reach localhost — use a tunnel (ngrok, etc.). */
const x402ResourceUrl = process.env.X402_RESOURCE_URL?.trim() || '';
try {
  if (x402ResourceUrl && /ngrok-free\.(app|dev)\b/i.test(x402ResourceUrl)) {
    console.warn(
      '[trexx-api] X402: ngrok-free hosts often fail facilitator verify (resource GET without ngrok-skip-browser-warning). Prefer hosting the API (Render, Fly, etc.), Cloudflare Tunnel, or paid ngrok. Run: npm run x402-probe',
    );
  }
} catch {
  /* ignore */
}
if (!x402PayTo) {
  console.warn('[trexx-api] Set X402_PAY_TO or PLATFORM_PUBLIC_KEY for x402 on POST /api/clips.');
}
if (process.env.X402_DISABLED !== 'true' && !x402ResourceUrl) {
  console.warn(
    '[trexx-api] X402: set X402_RESOURCE_URL to the public HTTPS URL of this endpoint (e.g. https://YOUR_TUNNEL/api/clips). Without it, facilitator verify often fails with "fetch failed" (localhost resource).',
  );
}

const x402Routes = {
  'POST /api/clips': {
    ...(x402ResourceUrl ? { resource: x402ResourceUrl } : {}),
    accepts: {
      scheme: 'exact',
      network: STELLAR_TESTNET_CAIP2,
      payTo: x402PayTo || 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      price: x402Price,
      maxTimeoutSeconds: 300,
    },
    description: 'Register campaign clip (x402)',
    mimeType: 'application/json',
    /** Middleware default is 402 + {}; this surfaces facilitator / on-chain failure details. */
    settlementFailedResponseBody: async (_ctx, failure) => ({
      contentType: 'application/json',
      body: {
        error: 'x402_settlement_failed',
        reason: failure.errorReason ?? null,
        message: failure.errorMessage || failure.errorReason || 'Settlement failed',
        payer: failure.payer ?? null,
        network: failure.network ?? null,
        transaction: failure.transaction ?? null,
      },
    }),
  },
};

/**
 * POST to https://x402.org/facilitator/* returns 308 → www.x402.org; Node native fetch (undici)
 * may fail replaying the body ("content-length" / "fetch failed"). Always use the www host.
 */
function normalizeX402FacilitatorBase(url) {
  const raw = (url?.trim() || 'https://www.x402.org/facilitator');
  return raw.replace(/^https:\/\/x402\.org(?=\/|$)/i, 'https://www.x402.org');
}

const x402FacilitatorBaseResolved = normalizeX402FacilitatorBase(process.env.X402_FACILITATOR_URL);
const x402FacilitatorClient = new HTTPFacilitatorClient({ url: x402FacilitatorBaseResolved });

const x402Middleware = paymentMiddlewareFromConfig(
  x402Routes,
  x402FacilitatorClient,
  [{ network: STELLAR_TESTNET_CAIP2, server: new ExactStellarScheme() }],
  { appName: 'Trexx Clips', testnet: true },
  undefined,
  true,
);

if (process.env.X402_DISABLED !== 'true') {
  app.use(x402Middleware);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/config', (req, res) => {
  res_json(res, {
    network: 'TESTNET',
    rpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    escrowContractId: process.env.ESCROW_CONTRACT_ID || '',
    usdcContractId: process.env.USDC_CONTRACT_ID || 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    platformPublicKey: process.env.PLATFORM_PUBLIC_KEY || '',
    tokenDecimals: Number(process.env.TOKEN_DECIMALS || 7),
    x402: {
      enabled: process.env.X402_DISABLED !== 'true',
      clipPrice: x402Price,
      payTo: x402PayTo || null,
      resourceUrl: x402ResourceUrl || null,
      facilitatorUrl: x402FacilitatorBaseResolved,
    },
  });
});

app.get('/api/campaigns', (req, res) => {
  res_json(res, q.listCampaigns());
});

/** Some facilitators GET the resource URL; payment is still POST + x402. */
app.get('/api/clips', (_req, res) => {
  res_json(res, { ok: true, method: 'POST', hint: 'Clip registration: JSON body and x402 payment header.' });
});

app.post('/api/campaigns', (req, res) => {
  const { title, description, payoutPerMilestoneStroops, sponsorPubkey } = req.body || {};
  if (!title || !payoutPerMilestoneStroops) {
    return res.status(400).json({ error: 'title and payoutPerMilestoneStroops are required' });
  }
  const id = Number(q.createCampaign({ title, description, payoutPerMilestoneStroops, sponsorPubkey }));
  res_json(res, { id, ...q.getCampaign(id) });
});

app.post('/api/clips', (req, res) => {
  const { campaignId, url, platform, creatorPublicKey } = req.body || {};
  if (!campaignId || !url || !platform || !creatorPublicKey) {
    return res.status(400).json({ error: 'campaignId, url, platform, and creatorPublicKey are required' });
  }
  const camp = q.getCampaign(campaignId);
  if (!camp) return res.status(404).json({ error: 'campaign not found' });
  const clipId = Number(q.addClip({ campaignId, url, platform, creatorPubkey: creatorPublicKey }));
  res_json(res, { id: clipId, campaignId, url, platform, creatorPublicKey });
});

app.patch('/api/clips/:id/views', (req, res) => {
  const id = Number(req.params.id);
  const views = Number(req.body?.views);
  if (!Number.isFinite(views) || views < 0) {
    return res.status(400).json({ error: 'invalid views' });
  }
  q.updateClipViews(id, views);
  const row = db.prepare(`SELECT * FROM clips WHERE id = ?`).get(id);
  res_json(res, row);
});

app.post('/api/campaigns/:id/mark-funded', (req, res) => {
  const id = Number(req.params.id);
  if (!q.getCampaign(id)) return res.status(404).json({ error: 'not found' });
  q.markFunded(id);
  res_json(res, { ok: true });
});

function parseStroops(s) {
  try {
    return BigInt(String(s));
  } catch {
    return null;
  }
}

/** Settle milestones (1000 views) and Soroban payout per clip. */
app.post('/api/campaigns/:id/settle', async (req, res) => {
  const campaignId = Number(req.params.id);
  const camp = q.getCampaign(campaignId);
  if (!camp) return res.status(404).json({ error: 'campaign not found' });

  const escrowId = process.env.ESCROW_CONTRACT_ID;
  const operatorSecret = process.env.OPERATOR_SECRET;
  if (!escrowId || !operatorSecret) {
    return res.status(503).json({ error: 'ESCROW_CONTRACT_ID and OPERATOR_SECRET are not configured on the server' });
  }

  const payoutPer = parseStroops(camp.payout_per_milestone_stroops);
  if (payoutPer === null || payoutPer <= 0n) {
    return res.status(400).json({ error: 'invalid payout_per_milestone on campaign' });
  }

  const clips = q.clipsForSettle(campaignId);
  const txs = [];

  for (const clip of clips) {
    const totalMilestones = Math.floor((clip.views || 0) / 1000);
    const owe = totalMilestones - (clip.milestones_paid || 0);
    if (owe <= 0) continue;

    const amount = BigInt(owe) * payoutPer;
    try {
      const out = await submitPayout({
        rpcUrl: process.env.SOROBAN_RPC_URL,
        contractId: escrowId,
        operatorSecret,
        campaignId,
        creatorPublicKey: clip.creator_pubkey,
        amountStroops: amount.toString(),
      });
      txs.push({ clipId: clip.id, hash: out.hash, amount: amount.toString() });
      q.addMilestonesPaid(clip.id, owe);
    } catch (e) {
      console.error(e);
      return res.status(500).json({
        error: e instanceof Error ? e.message : 'payout failed',
        partial: txs,
      });
    }
  }

  res_json(res, { settled: txs.length, txs });
});

app.get('/api/campaigns/:id/clips', (req, res) => {
  const id = Number(req.params.id);
  res_json(res, q.listClips(id));
});

function res_json(res, body) {
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

app.listen(PORT, () => {
  console.log(`Trexx API at http://localhost:${PORT}`);
});

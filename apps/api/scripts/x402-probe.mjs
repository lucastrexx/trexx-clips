#!/usr/bin/env node
/**
 * x402 / facilitator diagnostics:
 * - GET to X402_RESOURCE_URL (with and without ngrok header).
 * - GET/POST to facilitator at www.x402.org (the API must be able to POST /verify).
 *
 * Note: facilitator verify also GETs your resource from Coinbase servers; 200 here does not guarantee
 * their datacenter can reach the same URL.
 */
import 'dotenv/config';

const url = process.argv[2]?.trim() || process.env.X402_RESOURCE_URL?.trim();
if (!url) {
  console.error('Set X402_RESOURCE_URL in .env or pass URL: node scripts/x402-probe.mjs https://.../api/clips');
  process.exit(1);
}

function formatErr(e) {
  if (!(e instanceof Error)) return String(e);
  const parts = [e.message];
  let c = /** @type {unknown} */ (e.cause);
  let depth = 0;
  while (c != null && depth < 6) {
    if (c instanceof Error) {
      parts.push(`cause: ${c.message}`);
      c = c.cause;
    } else if (typeof c === 'object' && c !== null && 'code' in c) {
      parts.push(`cause: ${JSON.stringify(c)}`);
      break;
    } else {
      parts.push(`cause: ${String(c)}`);
      break;
    }
    depth++;
  }
  return parts.join(' | ');
}

async function tryGet(label, init = {}) {
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow', ...init });
    const text = await r.text();
    console.log(`\n${label}`);
    console.log(`  status: ${r.status}`);
    console.log(`  body (200 chars): ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
  } catch (e) {
    console.log(`\n${label}`);
    console.log(`  ERROR: ${formatErr(e)}`);
  }
}

console.log('Resource:', url);

await tryGet('GET without extra headers (closest to facilitator)');
await tryGet('GET with ngrok-skip-browser-warning (reference — facilitator does not send)', {
  headers: { 'ngrok-skip-browser-warning': 'true' },
});
await tryGet("GET with User-Agent 'Go-http-client/1.1'", {
  headers: { 'User-Agent': 'Go-http-client/1.1' },
});

let supportedOk = false;
const FACILITATOR_WWW = 'https://www.x402.org/facilitator';

try {
  const r = await fetch(`${FACILITATOR_WWW}/supported`, { method: 'GET' });
  supportedOk = r.ok;
  console.log(`\nFacilitator GET ${FACILITATOR_WWW}/supported → ${r.status}`);
} catch (e) {
  console.log(`\nFacilitator GET ${FACILITATOR_WWW}/supported network ERROR: ${formatErr(e)}`);
}

/** Typical app failure: HTTPFacilitatorClient POSTs /verify. Use www base (avoids 308 x402.org→www with POST body). */
let verifyPostError = null;
try {
  const r = await fetch(`${FACILITATOR_WWW}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({}),
  });
  const t = await r.text();
  console.log(`\nFacilitator POST /verify invalid body {} → ${r.status} (4xx is OK — proves POST works)`);
  console.log(`  body (160 chars): ${t.replace(/\s+/g, ' ').slice(0, 160)}`);
} catch (e) {
  verifyPostError = e;
  console.log(`\nFacilitator POST /verify network ERROR: ${formatErr(e)}`);
}

if (verifyPostError) {
  console.log(`
--- Diagnosis: POST ${FACILITATOR_WWW}/verify failed on this machine.
The Trexx API uses this endpoint. Until this works from the network where the API runs,
PAYMENT-REQUIRED may show error="fetch failed".

This Trexx build forces the www facilitator host to avoid Node fetch breaking on 308 redirects.

Checklist:
  • curl -v -X POST ${FACILITATOR_WWW}/verify -H 'Content-Type: application/json' -d '{}'
  • Compare with POST to https://x402.org/facilitator/verify (308 without -L; Node fetch often breaks)
  • Other network, HTTPS_PROXY, NODE_OPTIONS=--dns-result-order=ipv4first
`);
} else {
  console.log(`
--- If POST /verify returned a response (even 4xx), this machine reaches the facilitator.
If the app still shows fetch failed for your public resource, then investigate facilitator fetching your URL from the cloud
(ngrok, etc.). Stable path: host the API (Render, Fly, Railway, …).
`);
}

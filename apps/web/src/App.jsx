import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getAddress,
  isConnected,
  requestAccess,
  setAllowed,
  signAuthEntry,
  signTransaction,
} from "@stellar/freighter-api";
import { Networks } from "@stellar/stellar-sdk";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from "@x402/core/http";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { STELLAR_TESTNET_CAIP2 } from "@x402/stellar";
import {
  getLatestLedgerSequence,
  opApproveUsdc,
  opCreateCampaign,
  opFund,
  runSorobanTx,
  usdcToStroops,
} from "./stellarOps";

const API_BASE = import.meta.env.VITE_API_URL || "";

/** When API_BASE is set, return absolute API URL so x402's internal `new Request(url)` keeps the Render (etc.) host instead of the Vercel origin. */
function resolveApiPath(path) {
  if (!path.startsWith("/")) return path;
  const base = API_BASE.replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

/**
 * Fetch to the API. Relative `/api` strings use API_BASE when set (production).
 * @x402/fetch wraps calls as `new Request(input, init)`, which resolves relative URLs
 * against the page origin — so we must rewrite same-origin `/api` Request URLs
 * to API_BASE or x402 POSTs hit the static host (404) while loadJson still works.
 */
function apiFetch(input, init) {
  if (typeof input === "string" && input.startsWith("/")) {
    return fetch(`${API_BASE}${input}`, init);
  }
  if (
    API_BASE &&
    typeof globalThis.location !== "undefined" &&
    input instanceof Request
  ) {
    let u;
    try {
      u = new URL(input.url);
    } catch {
      return fetch(input, init);
    }
    if (
      u.pathname.startsWith("/api") &&
      u.origin === globalThis.location.origin
    ) {
      const base = API_BASE.replace(/\/$/, "");
      const path = `${u.pathname}${u.search}${u.hash}`;
      const hasBody =
        input.method !== "GET" && input.method !== "HEAD" && input.body != null;
      return fetch(
        new Request(`${base}${path}`, {
          method: input.method,
          headers: input.headers,
          ...(hasBody ? { body: input.body, duplex: "half" } : {}),
          redirect: input.redirect,
          credentials: input.credentials,
          mode: input.mode,
          cache: input.cache,
          signal: input.signal,
        }),
      );
    }
  }
  return fetch(input, init);
}

/** Static hosting (e.g. Vercel) has no /api — production builds must set VITE_API_URL to the public API origin. */
function ApiConfigBanner() {
  if (!import.meta.env.PROD || API_BASE) return null;
  return (
    <div className="alert warn" role="status">
      <strong>Backend URL missing.</strong> Set{" "}
      <code className="mono">VITE_API_URL</code> in Vercel to your API HTTPS
      origin (no trailing slash), e.g.{" "}
      <code className="mono">https://your-app.onrender.com</code>, then
      redeploy. Otherwise requests go to this site and{" "}
      <code className="mono">/api/*</code> returns 404.
    </div>
  );
}

const TABS_SPONSOR = [
  { id: "campaign", label: "New campaign" },
  { id: "sponsor", label: "Approve & settle" },
];

const TABS_CREATOR = [{ id: "video", label: "Submit video" }];

const SESSION_KEY = "trexx_session";

/** x402 v2: API 402 responses often have an empty JSON body; details are in PAYMENT-* headers (CORS exposedHeaders). */
function describeX402402Response(r, bodyText) {
  try {
    const o = JSON.parse(bodyText);
    if (o && typeof o === "object" && Object.keys(o).length > 0) {
      return JSON.stringify(o);
    }
  } catch {
    /* ignore */
  }
  try {
    const payRes = r.headers.get("PAYMENT-RESPONSE");
    if (payRes) {
      const d = decodePaymentResponseHeader(payRes);
      return `PAYMENT-RESPONSE: ${JSON.stringify(d)}`;
    }
  } catch (e) {
    return `PAYMENT-RESPONSE (decode failed): ${e instanceof Error ? e.message : e}`;
  }
  try {
    const payReq = r.headers.get("PAYMENT-REQUIRED");
    if (payReq) {
      const d = decodePaymentRequiredHeader(payReq);
      let s = `PAYMENT-REQUIRED: error=${JSON.stringify(d.error)} · resource=${d.resource?.url ?? "—"}`;
      const resUrl = d.resource?.url ?? "";
      const errLow = String(d.error ?? "").toLowerCase();
      if (
        errLow.includes("fetch failed") &&
        /ngrok-free\.(app|dev)\b/i.test(resUrl)
      ) {
        s +=
          " — ngrok-free: even if npm run x402-probe returns 200 here, the facilitator may fail fetching from another network. Host the API elsewhere or use another tunnel.";
      } else if (
        errLow.includes("fetch failed") &&
        /^https?:\/\//i.test(resUrl) &&
        !/localhost|127\.0\.0\.1/i.test(resUrl)
      ) {
        s +=
          " — facilitator may be failing to fetch this URL from the cloud (not only from your machine). See npm run x402-probe; consider a stable public host.";
      }
      return s;
    }
  } catch (e) {
    return `PAYMENT-REQUIRED (decode failed): ${e instanceof Error ? e.message : e}`;
  }
  return bodyText?.trim() || "{}";
}

async function loadJson(path, init) {
  const r = await apiFetch(path, init);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`${r.status}: ${t}`);
  }
  return r.json();
}

export function App() {
  const [config, setConfig] = useState(null);
  const [addr, setAddr] = useState(null);
  /** @type {null | 'creator' | 'sponsor'} */
  const [role, setRole] = useState(null);
  const [err, setErr] = useState(null);
  const [log, setLog] = useState([]);
  const [tab, setTab] = useState("campaign");
  const [isWorking, setIsWorking] = useState(false);

  const pushLog = useCallback((line) => {
    setLog((prev) =>
      [...prev, `${new Date().toISOString().slice(11, 19)} — ${line}`].slice(
        -40,
      ),
    );
  }, []);

  const [campaignForm, setCampaignForm] = useState({
    title: "",
    payoutPerMilestoneUsdc: "0.25",
    budgetUsdc: "10",
  });
  const [clipForm, setClipForm] = useState({
    campaignId: "",
    url: "",
    platform: "youtube",
  });
  const [campaigns, setCampaigns] = useState([]);
  const [sponsorCampaignId, setSponsorCampaignId] = useState("");
  const [clips, setClips] = useState([]);
  const [clipViewsDraft, setClipViewsDraft] = useState({});

  useEffect(() => {
    loadJson("/api/config")
      .then(setConfig)
      .catch((e) => setErr(String(e.message)));
    loadJson("/api/campaigns")
      .then(setCampaigns)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const conn = await isConnected();
        if (!conn || cancelled) return;
        const { address, error } = await getAddress();
        if (error || !address || cancelled) return;
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (!raw) return;
        const s = JSON.parse(raw);
        if (
          s.addr === address &&
          (s.role === "creator" || s.role === "sponsor")
        ) {
          setAddr(address);
          setRole(s.role);
          setTab(s.role === "creator" ? "video" : "campaign");
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const paidFetch = useMemo(() => {
    if (!addr) return null;
    const signer = {
      address: addr,
      signAuthEntry: (entry, opts) =>
        signAuthEntry(entry, {
          networkPassphrase: Networks.TESTNET,
          address: addr,
          ...opts,
        }).then((r) => {
          if (r.error) return { signedAuthEntry: "", error: r.error };
          if (!r.signedAuthEntry)
            return { signedAuthEntry: "", error: { message: "cancelled" } };
          return {
            signedAuthEntry: r.signedAuthEntry,
            signerAddress: r.signerAddress,
          };
        }),
      signTransaction: (xdr, opts) =>
        signTransaction(xdr, {
          networkPassphrase: Networks.TESTNET,
          address: addr,
          ...opts,
        }),
    };
    const client = new x402Client().register(
      STELLAR_TESTNET_CAIP2,
      new ExactStellarScheme(signer),
    );
    return wrapFetchWithPayment(apiFetch, client);
  }, [addr]);

  const myCampaigns = useMemo(() => {
    if (!addr) return [];
    return campaigns.filter((c) => c.sponsor_pubkey === addr);
  }, [campaigns, addr]);

  const fundedCampaigns = useMemo(
    () => campaigns.filter((c) => c.escrow_funded),
    [campaigns],
  );

  function persistSession(nextAddr, nextRole) {
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ addr: nextAddr, role: nextRole }),
    );
  }

  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
    setAddr(null);
    setRole(null);
    setTab("campaign");
  }

  async function connect() {
    setErr(null);
    try {
      await setAllowed();
      const ok = await isConnected();
      if (!ok) throw new Error("Install or enable the Freighter extension");
      const { address, error } = await requestAccess();
      if (error) throw new Error(error.message || String(error));
      setAddr(address);
      setRole(null);
      pushLog(`Wallet: ${address.slice(0, 6)}…`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  function chooseRole(nextRole) {
    if (!addr) return;
    setRole(nextRole);
    persistSession(addr, nextRole);
    setTab(nextRole === "creator" ? "video" : "campaign");
    pushLog(`Role: ${nextRole === "creator" ? "creator" : "sponsor"}`);
  }

  function changeRoleOnly() {
    setRole(null);
    sessionStorage.removeItem(SESSION_KEY);
  }

  const tabsForRole = role === "creator" ? TABS_CREATOR : TABS_SPONSOR;
  const inApp = Boolean(addr && role);

  useEffect(() => {
    if (role === "creator") setTab("video");
  }, [role]);

  async function refreshCampaigns() {
    const list = await loadJson("/api/campaigns");
    setCampaigns(list);
    return list;
  }

  async function loadClipsForCampaign(cid) {
    if (!cid) {
      setClips([]);
      setClipViewsDraft({});
      return;
    }
    try {
      const list = await loadJson(`/api/campaigns/${cid}/clips`);
      setClips(list);
      const draft = {};
      for (const c of list) draft[c.id] = String(c.views ?? 0);
      setClipViewsDraft(draft);
    } catch {
      setClips([]);
      setClipViewsDraft({});
    }
  }

  useEffect(() => {
    loadClipsForCampaign(sponsorCampaignId);
  }, [sponsorCampaignId]);

  useEffect(() => {
    if (tab !== "sponsor" || sponsorCampaignId) return;
    if (myCampaigns.length === 1)
      setSponsorCampaignId(String(myCampaigns[0].id));
  }, [tab, sponsorCampaignId, myCampaigns]);

  async function runOnchainSequence({
    campaignId,
    payoutStroops,
    fundTotalStroops,
  }) {
    if (!config?.escrowContractId) {
      throw new Error("Set ESCROW_CONTRACT_ID in the backend (.env).");
    }
    if (!addr) throw new Error("Connect Freighter.");
    const rpcUrl = config.rpcUrl;
    const exp = (await getLatestLedgerSequence(rpcUrl)) + 1_000_000;

    pushLog(`On-chain 1/3 create_campaign #${campaignId}`);
    await runSorobanTx({
      rpcUrl,
      publicKey: addr,
      buildOperation: opCreateCampaign({
        escrowId: config.escrowContractId,
        sponsor: addr,
        campaignId,
        payoutStroops,
      }),
    });

    pushLog(`On-chain 2/3 approve USDC`);
    await runSorobanTx({
      rpcUrl,
      publicKey: addr,
      buildOperation: opApproveUsdc({
        usdcId: config.usdcContractId,
        sponsor: addr,
        spender: config.escrowContractId,
        amountStroops: fundTotalStroops,
        expirationLedger: exp,
      }),
    });

    pushLog(`On-chain 3/3 fund`);
    const fundR = await runSorobanTx({
      rpcUrl,
      publicKey: addr,
      buildOperation: opFund({
        escrowId: config.escrowContractId,
        sponsor: addr,
        campaignId,
        amountStroops: fundTotalStroops,
      }),
    });
    pushLog(`Fund submitted: ${fundR.hash ?? fundR.status}`);

    await loadJson(`/api/campaigns/${campaignId}/mark-funded`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  }

  /** Create DB row then Soroban (single flow). */
  async function createCampaignFull() {
    setErr(null);
    if (!addr) {
      setErr("Connect Freighter as a sponsor before creating a campaign.");
      return;
    }
    setIsWorking(true);
    try {
      const payoutPerMilestoneStroops = usdcToStroops(
        campaignForm.payoutPerMilestoneUsdc,
      );
      const fundTotalStroops = usdcToStroops(campaignForm.budgetUsdc);

      const body = await loadJson("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: campaignForm.title || "Untitled campaign",
          payoutPerMilestoneStroops,
          sponsorPubkey: addr,
        }),
      });

      const id = Number(body.id);
      pushLog(`Campaign #${id} created in app; starting on-chain…`);

      await runOnchainSequence({
        campaignId: id,
        payoutStroops:
          body.payout_per_milestone_stroops || payoutPerMilestoneStroops,
        fundTotalStroops,
      });

      pushLog(`Campaign #${id} funded on-chain.`);
      await refreshCampaigns();
      setClipForm((f) => ({ ...f, campaignId: String(id) }));
      setSponsorCampaignId(String(id));
      setTab("sponsor");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setIsWorking(false);
    }
  }

  async function registerClip() {
    setErr(null);
    if (!paidFetch) {
      setErr("Connect your wallet to register a clip (x402).");
      return;
    }
    try {
      const campaignId = Number(clipForm.campaignId);
      const r = await paidFetch(resolveApiPath("/api/clips"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaignId,
          url: clipForm.url,
          platform: clipForm.platform,
          creatorPublicKey: addr,
        }),
      });
      const bodyText = await r.text();
      if (r.status === 402) {
        const hint = describeX402402Response(r, bodyText);
        throw new Error(
          `x402: still 402 after payment. In v2 the body may be {} — see the error field below. USDC testnet + trustline (~${config?.x402?.clipPrice ?? "?"} USDC), X402_PAY_TO, and Freighter on Testnet. ${hint.slice(0, 900)}`,
        );
      }
      if (!r.ok) {
        throw new Error(`${r.status}: ${bodyText}`);
      }
      const j = JSON.parse(bodyText);
      pushLog(`Clip #${j.id} registered (x402)`);
      setClipForm((f) => ({ ...f, url: "" }));
      if (String(campaignId) === sponsorCampaignId)
        await loadClipsForCampaign(sponsorCampaignId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveClipViews(clipId) {
    setErr(null);
    try {
      const views = Number(clipViewsDraft[clipId]);
      if (!Number.isFinite(views) || views < 0)
        throw new Error("Invalid view count");
      await loadJson(`/api/clips/${clipId}/views`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ views }),
      });
      pushLog(`Clip #${clipId}: views -> ${views}`);
      await loadClipsForCampaign(sponsorCampaignId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function settleSponsor() {
    setErr(null);
    const id = Number(sponsorCampaignId);
    if (!id) {
      setErr("Select a campaign.");
      return;
    }
    try {
      const res = await loadJson(`/api/campaigns/${id}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      pushLog(`Settlement: ${JSON.stringify(res)}`);
      await loadClipsForCampaign(sponsorCampaignId);
      await refreshCampaigns();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  if (!inApp) {
    return (
      <div className="home">
        <div className="home-bg" aria-hidden />
        <div className="home-inner">
          <header className="home-header">
            <span className="brand-mark solo">T</span>
            <div>
              <h1 className="home-title">Trexx Clips</h1>
              <p className="home-sub">
                Stellar Testnet · Soroban · x402 — connect your wallet and
                choose how you want to use the app.
              </p>
            </div>
          </header>
          {err && <div className="alert error">{err}</div>}

          {!addr && (
            <section className="home-card">
              <h2>Step 1 — Wallet</h2>
              <p className="hint">
                Freighter is required to sign transactions and x402 payments
                (test network).
              </p>
              <button
                type="button"
                className="primary lg block"
                onClick={connect}
              >
                Connect Freighter
              </button>
            </section>
          )}

          {addr && (
            <section className="home-card">
              <h2>Step 2 — How do you join?</h2>
              <p className="home-wallet mono">{addr}</p>
              <div className="role-grid">
                <button
                  type="button"
                  className="role-card"
                  onClick={() => chooseRole("creator")}
                >
                  <span className="role-icon" aria-hidden>
                    ▶
                  </span>
                  <strong>I'm a creator</strong>
                  <span>
                    I submit clips to open campaigns and pay x402 to register my
                    video.
                  </span>
                </button>
                <button
                  type="button"
                  className="role-card"
                  onClick={() => chooseRole("sponsor")}
                >
                  <span className="role-icon" aria-hidden>
                    ◈
                  </span>
                  <strong>I'm a sponsor</strong>
                  <span>
                    I create and fund campaigns on-chain, approve simulated
                    views, and settle payouts.
                  </span>
                </button>
              </div>
              <button
                type="button"
                className="ghost block"
                onClick={clearSession}
              >
                Disconnect and choose another wallet
              </button>
            </section>
          )}

          <footer className="home-footer">
            <a
              href="https://stellar.expert/explorer/testnet"
              target="_blank"
              rel="noreferrer"
            >
              Explorer
            </a>
            ·{" "}
            <a
              href="https://developers.stellar.org/docs/build/agentic-payments/x402"
              target="_blank"
              rel="noreferrer"
            >
              x402
            </a>
          </footer>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">T</span>
          <div>
            <strong>Trexx Clips</strong>
            <div className="brand-sub">Soroban · x402 · Testnet</div>
          </div>
        </div>

        <nav className="nav" aria-label="Sections">
          {tabsForRole.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`nav-item${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="role-pill">
            {role === "creator" ? "Role: creator" : "Role: sponsor"}
          </div>
          <button
            type="button"
            className="sidebar-link"
            onClick={changeRoleOnly}
          >
            Change role
          </button>
          <button
            type="button"
            className="sidebar-link danger"
            onClick={clearSession}
          >
            Disconnect wallet
          </button>
          <div className="mono address-pill" title={addr}>
            {addr.slice(0, 6)}…{addr.slice(-4)}
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="main-header">
          <div>
            <h1>{tabsForRole.find((x) => x.id === tab)?.label}</h1>
          </div>
        </header>

        {err && <div className="alert error">{err}</div>}

        {tab === "campaign" && (
          <section className="card panel">
            <h2 className="sr-only">Form</h2>
            <label>
              Campaign title
              <input
                value={campaignForm.title}
                onChange={(e) =>
                  setCampaignForm({ ...campaignForm, title: e.target.value })
                }
                placeholder="e.g. Launch day shorts"
              />
            </label>
            <div className="grid-2">
              <label>
                Payout per 1k views (USDC)
                <input
                  value={campaignForm.payoutPerMilestoneUsdc}
                  onChange={(e) =>
                    setCampaignForm({
                      ...campaignForm,
                      payoutPerMilestoneUsdc: e.target.value,
                    })
                  }
                />
              </label>
              <label>
                Total deposit (testnet USDC)
                <input
                  value={campaignForm.budgetUsdc}
                  onChange={(e) =>
                    setCampaignForm({
                      ...campaignForm,
                      budgetUsdc: e.target.value,
                    })
                  }
                />
              </label>
            </div>
            <p className="hint">
              The connected wallet is stored as sponsor. Requires a deployed
              escrow contract and USDC on the account.
            </p>
            <button
              type="button"
              className="primary lg"
              onClick={createCampaignFull}
              disabled={isWorking || !addr}
            >
              {isWorking ? "Processing…" : "Create campaign (app + on-chain)"}
            </button>
          </section>
        )}

        {tab === "video" && (
          <section className="card panel">
            <label>
              Campaign
              <select
                value={clipForm.campaignId}
                onChange={(e) =>
                  setClipForm({ ...clipForm, campaignId: e.target.value })
                }
              >
                <option value="">— choose —</option>
                {fundedCampaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.id} — {c.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Video / post URL
              <input
                value={clipForm.url}
                onChange={(e) =>
                  setClipForm({ ...clipForm, url: e.target.value })
                }
                placeholder="https://…"
              />
            </label>
            <label>
              Platform
              <select
                value={clipForm.platform}
                onChange={(e) =>
                  setClipForm({ ...clipForm, platform: e.target.value })
                }
              >
                <option value="youtube">YouTube</option>
                <option value="tiktok">TikTok</option>
                <option value="instagram">Instagram</option>
              </select>
            </label>
            <button
              type="button"
              className="primary"
              onClick={registerClip}
              disabled={!paidFetch || !clipForm.campaignId}
            >
              Register clip (x402)
            </button>
            {fundedCampaigns.length === 0 && (
              <p className="hint">
                No funded campaigns yet. Ask a sponsor to open one.
              </p>
            )}
          </section>
        )}

        {tab === "sponsor" && (
          <section className="card panel">
            {!addr ? (
              <p className="hint">
                Connect the same wallet that created the campaign.
              </p>
            ) : myCampaigns.length === 0 ? (
              <p className="hint">
                You have no sponsor campaigns yet (or you created one without a
                connected wallet).
              </p>
            ) : (
              <>
                <label>
                  Your campaign
                  <select
                    value={sponsorCampaignId}
                    onChange={(e) => setSponsorCampaignId(e.target.value)}
                  >
                    <option value="">— choose —</option>
                    {myCampaigns.map((c) => (
                      <option key={c.id} value={c.id}>
                        #{c.id} — {c.title} {c.escrow_funded ? "✓" : "· draft"}
                      </option>
                    ))}
                  </select>
                </label>

                {sponsorCampaignId && (
                  <>
                    <h3 className="subhead">Clips & views (simulated)</h3>
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>Platform</th>
                            <th>Link</th>
                            <th>Creator</th>
                            <th>Views</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {clips.length === 0 ? (
                            <tr>
                              <td colSpan={6} className="muted center">
                                No clips in this campaign.
                              </td>
                            </tr>
                          ) : (
                            clips.map((row) => (
                              <tr key={row.id}>
                                <td className="mono">{row.id}</td>
                                <td>{row.platform}</td>
                                <td>
                                  <a
                                    href={row.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="link-cell"
                                  >
                                    open
                                  </a>
                                </td>
                                <td
                                  className="mono truncate"
                                  title={row.creator_pubkey}
                                >
                                  {row.creator_pubkey.slice(0, 8)}…
                                </td>
                                <td>
                                  <input
                                    className="table-input"
                                    value={clipViewsDraft[row.id] ?? ""}
                                    onChange={(e) =>
                                      setClipViewsDraft((d) => ({
                                        ...d,
                                        [row.id]: e.target.value,
                                      }))
                                    }
                                  />
                                </td>
                                <td>
                                  <button
                                    type="button"
                                    className="small"
                                    onClick={() => saveClipViews(row.id)}
                                  >
                                    Save
                                  </button>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>

                    <div className="row actions-row">
                      <button
                        type="button"
                        className="primary"
                        onClick={settleSponsor}
                      >
                        Settle milestones (Soroban payout)
                      </button>
                      <span className="hint inline">
                        Uses saved views; pays{" "}
                        <code>floor(views/1000) × payout</code> per clip, up to
                        the pool.
                      </span>
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        )}

        <section className="card panel muted-panel">
          <h2>Network &amp; log</h2>
          {!config ? (
            <p>Loading /api/config…</p>
          ) : (
            <ul className="kv compact">
              <li>
                <span>Escrow</span>
                <code>{config.escrowContractId || "—"}</code>
              </li>
              <li>
                <span>USDC</span>
                <code>{config.usdcContractId}</code>
              </li>
              <li>
                <span>x402</span>
                <code>
                  {config.x402?.enabled
                    ? `${config.x402.clipPrice} USDC`
                    : "off"}
                </code>
              </li>
              {config.x402?.enabled ? (
                <li>
                  <span>x402 public URL</span>
                  <code title="Cloud facilitator cannot reach localhost">
                    {config.x402.resourceUrl ||
                      "— (set X402_RESOURCE_URL on the API + tunnel)"}
                  </code>
                </li>
              ) : null}
            </ul>
          )}
          <pre className="log">{log.join("\n") || "—"}</pre>
        </section>

        <footer className="footer">
          <a
            href="https://stellar.expert/explorer/testnet"
            target="_blank"
            rel="noreferrer"
          >
            Stellar Expert
          </a>
          ·{" "}
          <a
            href="https://developers.stellar.org/docs/build/agentic-payments/x402"
            target="_blank"
            rel="noreferrer"
          >
            x402
          </a>
        </footer>
      </main>
    </div>
  );
}

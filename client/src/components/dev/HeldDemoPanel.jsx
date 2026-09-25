/**
 * HeldDemoPanel — clickable Held-mode demo for the x402 page.
 *
 * Flow: Start ($0.50 by default) → USDC settles INTO the ArbiterManager escrow
 * on Arbitrum Sepolia → the deliverable returns immediately (read it) → the
 * buyer decides: Approve (seller paid) / Reject (refunded) / do nothing and the
 * contract auto-resolves at the deadline. Every step shows its real tx hash.
 *
 * Inspired by Held (ETHOnline 2026) — escrow-by-substitution: the 402 names the
 * escrow contract as payTo, not the seller.
 */
import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import {
  FiPlay, FiLock, FiCheckCircle, FiXCircle, FiClock, FiFileText, FiExternalLink,
} from 'react-icons/fi';
import developerApi from '../../utils/developerApi';
import useApi from '../../hooks/useApi';

const short = (a) => (a ? `${a.slice(0, 10)}…${a.slice(-8)}` : '—');
const DEFAULT_USD = 0.5;

const HeldDemoPanel = () => {
  const servicesState = useApi({ fetcher: () => developerApi.marketplace({ perPage: 100 }), deps: [] });
  const agentsState = useApi({ fetcher: () => developerApi.agents({ perPage: 100 }), deps: [] });
  const marketplaceServices = (servicesState.data?.services || []).filter((service) => service.isActive && service.provider?.wallet);
  const buyerAgents = (agentsState.data?.agents || []).filter((agent) => agent.status !== 'suspended' && agent.wallet);
  const [serviceId, setServiceId] = useState('');
  const [buyerAgentId, setBuyerAgentId] = useState('');
  const [settlementToken, setSettlementToken] = useState('USDC'); // 'USDC' | 'USDG'
  const selectedService = marketplaceServices.find((service) => service.serviceId === serviceId);
  const servicePrice = Number(selectedService?.x402Price || selectedService?.unitPrice || DEFAULT_USD);
  const displayPrice = Number.isFinite(servicePrice) && servicePrice > 0 ? servicePrice : DEFAULT_USD;
  const priceCents = Math.max(1, Math.round(displayPrice * 100));
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [held, setHeld] = useState(null);   // escrow proof + deliverable returned by the demo
  const [onchain, setOnchain] = useState(null); // status from /x402/held/:id

  const refreshStatus = async (escrowId) => {
    try {
      const s = await developerApi.arbiterHeldStatus(escrowId);
      setOnchain(s?.onChain ? s : null);
    } catch { /* resolved jobs keep their last state */ }
  };

  useEffect(() => {
    if (held?.escrowId && !onchain) refreshStatus(held.escrowId);
  }, [held, onchain]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setBusy(true);
    setHeld(null);
    setOnchain(null);
    try {
      const r = await developerApi.arbiterHeldDemo(priceCents, serviceId || null, buyerAgentId || null, settlementToken);
      setHeld(r);
      toast.success(`Escrowed ${r.amountUsdc} ${r.settlementToken || 'USDC'} — deliverable released for review`);
    } catch (err) {
      toast.error(err.message || 'Held demo failed');
    } finally {
      setBusy(false);
    }
  };

  const decide = async (action) => {
    if (!held?.escrowId) return;
    setDeciding(true);
    try {
      const r = await developerApi.arbiterHeldDecide(held.escrowId, action);
      toast.success(`${action} executed — ${short(r.txHash)}`);
      setOnchain((s) => (s ? { ...s, onChain: { ...s.onChain, status: action === 'approve' ? 'RELEASED' : 'CANCELLED' } } : s));
      setHeld((h) => ({ ...h, decision: { action, txHash: r.txHash } }));
    } catch (err) {
      toast.error(err.message || `${action} failed`);
    } finally {
      setDeciding(false);
    }
  };

  const statusLabel = held?.decision
    ? (held.decision.action === 'approve' ? 'RELEASED — seller paid' : 'CANCELLED — buyer refunded')
    : onchain?.onChain?.status === 'RELEASED' ? 'RELEASED — seller paid'
    : onchain?.onChain?.status === 'CANCELLED' ? 'CANCELLED — buyer refunded'
    : held ? 'HELD — awaiting your decision' : null;

  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 flex flex-col">
      <h2 className="text-sm font-semibold text-zinc-200 mb-1 flex items-center gap-2">
        <FiLock size={13} className="text-amber-400" /> Held mode — pay, read, then decide
      </h2>
      <p className="text-[11px] text-zinc-500 mb-4">
         Escrow-by-substitution: your ${displayPrice.toFixed(2)} settles into the <span className="text-zinc-300">ArbiterManager contract</span> (not the seller).
        The deliverable returns immediately. Approve pays the seller. Reject refunds only while the work is <span className="text-zinc-300">undelivered</span> — once delivery is proven on-chain the contract refuses every refund. Silence auto-resolves at the deadline.
      </p>

      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="w-full bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl inline-flex items-center justify-center gap-2 text-sm transition-colors"
      >
        {busy ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <FiPlay size={14} />}
         {busy ? 'Settling into escrow…' : `Start held purchase — $${displayPrice.toFixed(2)}`}
      </button>

      <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
        <label htmlFor="held-settlement-token" className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Settlement token</label>
        <select id="held-settlement-token" value={settlementToken} onChange={(event) => setSettlementToken(event.target.value)} disabled={busy} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-300">
          <option value="USDC">USDC — Circle USD Coin</option>
          <option value="USDG">USDG — Paxos Global Dollar (bonus-criterion asset)</option>
        </select>
        <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">USDG is Paxos' regulated Global Dollar stablecoin. The token's on-chain symbol is verified before any funds move.</p>
      </div>

      <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
        <label htmlFor="held-marketplace-service" className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Buy a marketplace service</label>
        <select id="held-marketplace-service" value={serviceId} onChange={(event) => setServiceId(event.target.value)} disabled={busy || servicesState.loading} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-300">
          <option value="">Demo service (default provider)</option>
          {marketplaceServices.map((service) => <option key={service.serviceId} value={service.serviceId}>{service.title} · {service.provider?.name || service.provider?.wallet} · {service.unitPrice} USDC</option>)}
        </select>
        <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">Selecting a listing settles straight into its published provider wallet — that provider's own managed wallet signs the on-chain delivery, so the escrow pays exactly who the listing says.</p>
      </div>

      <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
        <label htmlFor="held-buyer-agent" className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Pay from buyer agent wallet</label>
        <select id="held-buyer-agent" value={buyerAgentId} onChange={(event) => setBuyerAgentId(event.target.value)} disabled={busy || agentsState.loading} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-300">
          <option value="">Select an agent wallet</option>
          {buyerAgents.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.name || agent.agentId} · {agent.wallet}</option>)}
        </select>
        <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">The selected agent signs the {settlementToken} approval and escrow funding transaction. Fund it with Arbitrum Sepolia {settlementToken} and ETH first.</p>
      </div>

      {held && (
        <div className="mt-4 space-y-3 flex-1">
          {/* Status line */}
          <div className={`rounded-xl border p-3 text-[11px] ${held.decision ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-amber-500/25 bg-amber-500/5'}`}>
            <div className="flex items-center gap-1.5 font-semibold mb-1.5">
              {held.decision
                ? <FiCheckCircle size={11} className="text-emerald-400" />
                : <FiClock size={11} className="text-amber-400 animate-pulse" />}
              <span className={held.decision ? 'text-emerald-300' : 'text-amber-300'}>{statusLabel}</span>
            </div>
            <div className="mt-2 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/50">
              {held.serviceTitle && <div className="flex justify-between gap-3 border-b border-zinc-800 px-2.5 py-2"><span className="text-zinc-500">Marketplace service</span><span className="max-w-[68%] truncate text-right text-zinc-300">{held.serviceTitle}</span></div>}
              <div className="flex justify-between gap-3 border-b border-zinc-800 px-2.5 py-2"><span className="text-zinc-500">Buyer wallet</span><span className="max-w-[68%] truncate text-right font-mono text-zinc-300" title={held.buyer}>{short(held.buyer)}</span></div>
              <div className="flex justify-between gap-3 border-b border-zinc-800 px-2.5 py-2"><span className="text-zinc-500">Provider wallet</span><span className="max-w-[68%] truncate text-right font-mono text-zinc-300" title={held.provider}>{short(held.provider)}</span></div>
              <div className="flex justify-between gap-3 border-b border-zinc-800 px-2.5 py-2"><span className="text-zinc-500">Escrow contract</span><span className="max-w-[68%] truncate text-right font-mono text-amber-300" title={held.contract}>{short(held.contract)}</span></div>
              <div className="flex justify-between gap-3 border-b border-zinc-800 px-2.5 py-2"><span className="text-zinc-500">Amount</span><span className="font-mono text-white">{held.amountUsdc} {held.settlementToken || 'USDC'}</span></div>
              <div className="flex justify-between gap-3 px-2.5 py-2"><span className="text-zinc-500">Network</span><span className="text-zinc-300">{held.network} · {held.chainId}</span></div>
            </div>
            <div className="mt-2 space-y-1.5 border-t border-zinc-800 pt-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">On-chain proof</p>
              {[['Escrow ID', held.escrowIdShort, null], ['Settle tx', short(held.settleTx), held.settleTx], ['Delivery tx', short(held.deliveryTx), held.deliveryTx]].map(([label, value, hash]) => hash ? (
                <a key={label} href={`https://sepolia.arbiscan.io/tx/${hash}`} target="_blank" rel="noreferrer" className="flex justify-between items-center group"><span className="text-zinc-500">{label}</span><span className="font-mono text-cyan-400 group-hover:text-cyan-300 inline-flex items-center gap-1">{value} <FiExternalLink size={9} /></span></a>
              ) : <div key={label} className="flex justify-between"><span className="text-zinc-500">{label}</span><span className="font-mono text-zinc-300">{value}</span></div>)}
            </div>
            {held.decision && (
              <a href={`https://sepolia.arbiscan.io/tx/${held.decision.txHash}`} target="_blank" rel="noreferrer" className="flex justify-between items-center group">
                <span className="text-zinc-500">{held.decision.action} tx</span>
                <span className="font-mono text-cyan-400 group-hover:text-cyan-300 inline-flex items-center gap-1">{short(held.decision.txHash)} <FiExternalLink size={9} /></span>
              </a>
            )}
          </div>

          {/* Deliverable — read it before deciding */}
          {held.deliverable && !held.decision && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1.5 flex items-center gap-1.5">
                <FiFileText size={10} /> Deliverable — read before deciding
              </p>
              <p className="text-[11px] text-zinc-300 leading-relaxed">{held.deliverable.answer}</p>
              <p className="text-[10px] text-zinc-600 mt-1.5">
                confidence {Math.round((held.deliverable.confidence || 0) * 100)}% · {held.deliverable.provider}
              </p>
            </div>
          )}

          {/* Decision buttons */}
          {!held.decision && (
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => decide('approve')} disabled={deciding}
                className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold py-2 rounded-xl text-xs inline-flex items-center justify-center gap-1.5">
                <FiCheckCircle size={12} /> {deciding ? 'Sending…' : 'Approve — pay seller'}
              </button>
              <button type="button" onClick={() => decide('reject')} disabled={deciding}
                className="border border-red-500/40 text-red-300 hover:bg-red-500/10 disabled:opacity-50 font-semibold py-2 rounded-xl text-xs inline-flex items-center justify-center gap-1.5">
                <FiXCircle size={12} /> {deciding ? 'Sending…' : 'Reject — refund me'}
              </button>
            </div>
          )}
          {!held.decision && (
            <p className="text-[10px] text-zinc-600 text-center">
              Reject refunds only <span className="text-zinc-500">undelivered</span> work — delivery is already proven in this demo, so the contract will refuse the refund (that's the on-chain use-then-refund guard).
              Do nothing and the contract auto-resolves at the deadline ({Math.round((held.reviewSeconds || 3600) / 60)} min): delivered work is paid.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default HeldDemoPanel;

import React, { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  FiShield, FiCheckCircle, FiXCircle, FiActivity, FiUsers, FiDollarSign,
  FiTrendingUp, FiAlertTriangle, FiClock, FiCpu, FiRefreshCw, FiZap,
  FiGlobe, FiBookOpen, FiAward, FiLink, FiArrowLeft, FiBarChart2, FiExternalLink
} from 'react-icons/fi';
import Card from '../../components/dev/Card';
import Skeleton from '../../components/dev/Skeleton';
import ErrorBanner from '../../components/dev/ErrorBanner';
import Pill from '../../components/dev/Pill';
import useApi from '../../hooks/useApi';
import developerApi from '../../utils/developerApi';

const fmtUsd = (v, d = 4) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '0.0000');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

const RISK_TONE = { low: 'emerald', medium: 'amber', high: 'red', unknown: 'zinc' };
const TRUST_TONE = (t) => (t == null ? 'zinc' : t >= 75 ? 'emerald' : t >= 45 ? 'amber' : 'red');
const PRICING_LABELS = {
  per_unit: 'Per Unit',
  per_request: 'Per Request',
  per_hour: 'Per Hour',
  per_char: 'Per Character',
  per_mb_day: 'Per MB / Day',
  flat: 'Flat Fee',
  subscription: 'Subscription'
};

/* ─────────────── Identity badge row ─────────────── */
const IdentityBadges = ({ passport }) => (
  <div className="flex flex-wrap gap-2">
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${passport.onChainRegistered
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
      : 'border-zinc-700 bg-zinc-900 text-zinc-500'}`}>
      {passport.onChainRegistered ? <FiCheckCircle size={12} /> : <FiXCircle size={12} />}
      On-chain {passport.onChainRegistered ? 'Reputation' : 'New Provider'}
    </span>
    {passport.continuity?.active && (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/40 bg-sky-500/10 px-3 py-1 text-xs font-semibold text-sky-300"
        title={passport.continuity.explanation}>
        <FiLink size={12} /> Publisher continuity
      </span>
    )}
  </div>
);

/* ─────────────── Trust metric tile ─────────────── */
const TrustTile = ({ icon, label, value, sub, tone = 'text-white' }) => (
  <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 px-3 py-2.5">
    <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
      {icon} {label}
    </div>
    <p className={`mt-1.5 text-lg font-black ${tone}`}>{value}</p>
    {sub && <p className="text-[10px] text-zinc-600">{sub}</p>}
  </div>
);

const GraphTrustPanel = ({ passport }) => {
  const intelligence = passport.intelligence || {};
  const confidence = passport.confidence != null ? `${Math.round(Number(passport.confidence) * 100)}%` : '—';
  const risk = passport.riskLevel || 'unknown';
  const riskClass = risk === 'high' ? 'text-rose-300 bg-rose-500/10 border-rose-500/20' : risk === 'medium' ? 'text-amber-300 bg-amber-500/10 border-amber-500/20' : 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20';
  const successful = Number(intelligence.successfulPayments || 0);
  const total = Number(intelligence.paymentCount || 0);
  const uniqueBuyers = Number(intelligence.uniqueBuyers || 0);

  return (
    <Card dense title={<span className="flex items-center gap-2"><FiShield size={14} className="text-violet-400" /> Provider Passport Evidence <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-normal text-violet-300">The Graph</span></span>} subtitle="The selected provider's on-chain settlement record">
      <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-violet-300">Selected provider</p>
            <p className="mt-1 font-mono text-xs text-zinc-300">{passport.walletAddress}</p>
          </div>
          <a href={`https://sepolia.arbiscan.io/address/${passport.walletAddress}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] font-medium text-violet-300 hover:text-violet-200">View wallet <FiExternalLink size={11} /></a>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"><p className="text-[10px] uppercase tracking-wider text-zinc-600">Trust score</p><p className={`mt-1 text-xl font-black ${TRUST_TONE(passport.trustScore) === 'emerald' ? 'text-emerald-400' : TRUST_TONE(passport.trustScore) === 'amber' ? 'text-amber-400' : 'text-white'}`}>{passport.trustScore}/100</p><p className="text-[10px] text-zinc-600">computed from Graph data</p></div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"><p className="text-[10px] uppercase tracking-wider text-zinc-600">Success rate</p><p className="mt-1 text-sm font-bold text-white">{passport.successRate != null ? `${(Number(passport.successRate) * 100).toFixed(1)}%` : '—'}</p><p className="text-[10px] text-zinc-600">{successful}/{total} settlements</p></div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"><p className="text-[10px] uppercase tracking-wider text-zinc-600">Buyer diversity</p><p className="mt-1 text-sm font-bold text-white">{uniqueBuyers}</p><p className="text-[10px] text-zinc-600">unique buyers</p></div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"><p className="text-[10px] uppercase tracking-wider text-zinc-600">Confidence</p><p className="mt-1 text-sm font-bold text-white">{confidence}</p><p className="text-[10px] text-zinc-600">evidence depth</p></div>
          <div className={`rounded-lg border p-3 ${riskClass}`}><p className="text-[10px] uppercase tracking-wider opacity-70">Risk level</p><p className="mt-1 text-sm font-bold capitalize">{risk}</p><p className="text-[10px] opacity-70">Graph signals</p></div>
        </div>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
        <div>
          <p className="mb-2 text-xs font-semibold text-zinc-300">Score evidence</p>
          <div className="overflow-hidden rounded-lg border border-zinc-800">
            {(passport.trustReasoning || []).map((reason, index) => <div key={index} className="border-b border-zinc-800/70 px-3 py-2 text-xs leading-relaxed text-zinc-400 last:border-0"><span className="mr-2 text-violet-400">{index + 1}.</span>{reason}</div>)}
          </div>
        </div>
        <div>
          <p className="mb-2 text-xs font-semibold text-zinc-300">Risk signals</p>
          {(passport.riskFlags || []).length ? <div className="space-y-2">{passport.riskFlags.map((flag, index) => <div key={index} className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs"><p className="font-semibold capitalize text-amber-300">{flag.code.replaceAll('_', ' ')}</p><p className="mt-0.5 text-zinc-400">{flag.detail}</p></div>)}</div> : <p className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-400"><FiCheckCircle size={13} />No risk signals detected.</p>}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 pt-3 text-[10px] text-zinc-600"><span>Source: {passport.trustSource || 'The Graph'} · wallet-specific evidence only</span><Link to="/developer/graph-intelligence" className="inline-flex items-center gap-1 text-violet-400 hover:text-violet-300">View scoring methodology <FiExternalLink size={10} /></Link></div>
    </Card>
  );
};

/* ─────────────── Main page ─────────────── */
const DevAgentProfile = () => {
  const [params] = useSearchParams();
  const agentId = params.get('agentId');
  const serviceId = params.get('serviceId');

  const { data, loading, error, refresh, refreshing } = useApi({
    fetcher: () => developerApi.agentPassportProfile({ agentId, serviceId }),
    deps: [agentId, serviceId]
  });

  const passport = data?.passport || null;
  const overview = data?.trustOverview || null;

  const riskTone = RISK_TONE[passport?.riskLevel] || 'zinc';

  if (loading && !passport) {
    return (
      <div className="space-y-4">
        <Skeleton lines={2} />
        <Skeleton className="h-40 rounded-2xl" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (error && !passport) {
    return <ErrorBanner message={error.message} onRetry={refresh} setupRequired={error.setupRequired} />;
  }

  if (!passport) {
    return (
      <Card>
        <p className="text-center text-sm text-zinc-500">
          Provider not found. Open a marketplace service and click the provider to view its Agent Profile.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Link to="/developer/marketplace" className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300">
              <FiArrowLeft size={12} /> Back to Marketplace
            </Link>
            <div className="mt-2 flex items-center gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300">
                <FiCpu size={17} />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-xl font-bold text-white">{passport.agentName || 'Agent Passport'}</h1>
                <p className="truncate text-xs text-zinc-500">
                  {data?.service ? <>Agent Passport · provider for <span className="text-zinc-300">{data.service.title}</span></> : 'Human-backed agent identity and trust record'}
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Pill tone={TRUST_TONE(passport.trustScore)} dot>Trust {passport.trustScore}/100</Pill>
            <Pill tone={riskTone}>Risk: {passport.riskLevel}</Pill>
            <button type="button" onClick={refresh} aria-label="Refresh passport" title="Refresh passport" className="rounded-lg border border-zinc-700 p-2 text-zinc-300 hover:bg-zinc-800">
              <FiRefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-800/70 pt-3 text-[10px] text-zinc-600">
          <span className="font-mono">Agent ID · {passport.agentId}</span>
          <span title={passport.passportId}>Passport ID · {passport.passportId}</span>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[.85fr_1.15fr] xl:items-start">
      {/* Identity — the on-chain record */}
      <Card dense className="h-full">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
              <FiShield size={14} className="text-emerald-400" /> On-Chain Identity & Reputation
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">Trust is earned from verifiable settlement history on Arbitrum — not platform ratings.</p>
          </div>
          <IdentityBadges passport={passport} />
        </div>

        <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/50">
          <div className="border-b border-zinc-800 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">Wallet</p>
            <p className="truncate font-mono text-xs text-zinc-300" title={passport.walletAddress || ''}>
              {passport.walletAddress ? `${passport.walletAddress.slice(0, 10)}…${passport.walletAddress.slice(-8)}` : '—'}
            </p>
          </div>
          <div className="border-b border-zinc-800 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">Publisher</p>
            <p className="truncate text-xs text-zinc-300">{passport.publisher?.name || 'Verified publisher'}</p>
          </div>
          <div className="border-b border-zinc-800 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">Payments Indexed</p>
            <p className="truncate font-mono text-xs text-zinc-400">{passport.intelligence?.paymentCount > 0 ? passport.intelligence.paymentCount : '0'}</p>
          </div>
          <div className="px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">First Settlement</p>
            <p className="truncate text-xs text-zinc-400">{passport.intelligence?.lastPaymentAt ? fmtDate(passport.intelligence.lastPaymentAt) : 'Awaiting first deal'}</p>
          </div>
        </div>

      </Card>

      <GraphTrustPanel passport={passport} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[.85fr_1.15fr] lg:items-start">
        {/* Publisher continuity */}
        <Card dense className="h-fit self-start" title="Publisher Continuity" subtitle="Publisher-level identity across wallets">
          {passport.continuity?.active ? (
            <div className="space-y-2.5">
              <p className="flex items-center gap-2 text-xs font-semibold text-sky-300">
                <FiLink size={12} /> This wallet inherits the publisher record
              </p>
              <p className="text-xs leading-relaxed text-zinc-400">{passport.continuity.explanation}</p>
              <div className="grid grid-cols-3 gap-2 pt-1">
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                  <p className="text-[10px] text-zinc-500">Publisher wallets</p>
                  <p className="text-sm font-bold text-zinc-200">{passport.continuity.publisherWalletCount}</p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                  <p className="text-[10px] text-zinc-500">Aggregated volume</p>
                  <p className="text-sm font-bold text-zinc-200">{fmtUsd(passport.continuity.aggregatedSettlementVolume)} USDC</p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                  <p className="text-[10px] text-zinc-500">First settlement</p>
                  <p className="text-sm font-bold text-zinc-200">{passport.continuity.firstSettlement ? new Date(passport.continuity.firstSettlement).toLocaleDateString() : '—'}</p>
                </div>
              </div>
            </div>
           ) : (
             <div className="space-y-2">
               <p className="flex items-center gap-2 text-xs text-zinc-400">
                 <FiLink size={12} className="text-zinc-500" /> Publisher-level identity across wallets
               </p>
               {passport.publisher?.walletCount > 0 ? (
                 <p className="text-xs text-zinc-500">
                   {passport.publisher.walletCount} wallet(s) share this publisher profile — reputation and settlement history are aggregated at the publisher level.
                 </p>
               ) : (
                 <p className="text-xs text-zinc-500">
                   Reputation continuity links wallets owned by the same publisher, so trust earned on one wallet follows the publisher.
                 </p>
               )}
             </div>
          )}
        </Card>

        {/* Recent activity */}
        <Card dense className="h-fit self-start lg:row-span-2" title="Recent Activity" subtitle="Latest indexed settlements · auditable on Arbitrum">
          {(passport.paymentHistory || []).length === 0 ? (
            <p className="text-xs text-zinc-600">No indexed settlements yet — trust becomes measurable after the first verified Graph settlement.</p>
          ) : (
            <div className="space-y-1.5">
              {passport.paymentHistory.slice(0, 6).map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[11px] text-zinc-400" title={p.transactionHash}>
                      {p.transactionHash ? `${String(p.transactionHash).slice(0, 14)}…${String(p.transactionHash).slice(-8)}` : p.id}
                    </p>
                    <p className="text-[10px] text-zinc-600">
                      {p.timestamp ? new Date(Number(p.timestamp) * 1000).toLocaleString() : ''} · block {p.blockNumber ?? '—'}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-semibold text-zinc-200">{fmtUsd(p.amount)} USDC</p>
                    <p className={`text-[10px] ${String(p.status).toUpperCase() === 'RELEASED' ? 'text-emerald-400' : 'text-zinc-500'}`}>{p.status}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Capabilities */}
      <Card dense title="Supported Capabilities" subtitle="Published marketplace services">
        {(passport.capabilities || []).length === 0 ? (
          <p className="text-xs text-zinc-600">No published services yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="border-b border-zinc-800 bg-zinc-950/60 text-[10px] uppercase tracking-wider text-zinc-500"><tr><th className="px-3 py-2">Service</th><th className="px-3 py-2">Category</th><th className="px-3 py-2">Price</th><th className="px-3 py-2">Status</th></tr></thead>
              <tbody>
            {passport.capabilities.map((c) => (
              <tr key={c.serviceId} className="border-b border-zinc-800/70 last:border-0 hover:bg-zinc-950/50"><td className="px-3 py-2.5"><Link to={`/developer/marketplace/service/${c.serviceId}`} className="font-semibold text-zinc-200 hover:text-white">{c.title}</Link></td><td className="px-3 py-2.5 text-zinc-500">{c.category} · {PRICING_LABELS[c.pricingModel] || String(c.pricingModel || '').replace(/_/g, ' ')}</td><td className="px-3 py-2.5 font-mono text-zinc-300">{fmtUsd(c.unitPrice)} USDC / {c.unitLabel || 'unit'}{c.requireX402 && <span className="ml-2 text-amber-400">x402</span>}</td><td className="px-3 py-2.5"><Pill tone={c.isActive ? 'emerald' : 'zinc'}>{c.isActive ? 'live' : 'paused'}</Pill></td></tr>
            ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Reputation & activity metrics (platform-level) */}
      {(passport.reputation || passport.activityMetrics) && (
        <Card title="Platform Reputation & Activity" subtitle="Arbiter ledger — complements the on-chain Graph record">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {passport.reputation && (
              <>
                <TrustTile icon={<FiBarChart2 size={11} />} label="Platform Trust" value={`${passport.reputation.trustScore}/100`} />
                <TrustTile icon={<FiCheckCircle size={11} />} label="Completed Jobs" value={passport.reputation.completedJobs} sub={`${passport.reputation.failedJobs} failed`} />
                <TrustTile icon={<FiActivity size={11} />} label="Payment Success" value={`${Number(passport.reputation.paymentSuccessRate || 0) > 1 ? Number(passport.reputation.paymentSuccessRate).toFixed(1) : (Number(passport.reputation.paymentSuccessRate || 0) * 100).toFixed(1)}%`} />
                <TrustTile icon={<FiUsers size={11} />} label="Repeat Customers" value={passport.reputation.repeatCustomers} />
              </>
            )}
            {!passport.reputation && passport.activityMetrics && (
              <TrustTile icon={<FiActivity size={11} />} label="Platform Invoices" value={passport.activityMetrics.platformInvoices} sub={`${passport.activityMetrics.platformPaidInvoices} paid`} />
            )}
            {passport.activityMetrics && (
              <TrustTile icon={<FiClock size={11} />} label="Last Paid Invoice" value={passport.activityMetrics.lastPaidInvoiceAt ? new Date(passport.activityMetrics.lastPaidInvoiceAt).toLocaleDateString() : '—'} />
            )}
          </div>
        </Card>
      )}
    </div>
  );
};

export default DevAgentProfile;

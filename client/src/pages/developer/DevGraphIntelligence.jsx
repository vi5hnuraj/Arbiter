import React, { useState } from 'react';
import {
  FiActivity, FiAlertTriangle, FiBarChart2, FiCheckCircle, FiClock,
  FiCopy, FiExternalLink, FiInfo, FiSearch, FiShield, FiTrendingUp, FiUsers
} from 'react-icons/fi';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import Card from '../../components/dev/Card';
import ErrorBanner from '../../components/dev/ErrorBanner';
import Skeleton from '../../components/dev/Skeleton';
import useApi from '../../hooks/useApi';
import developerApi from '../../utils/developerApi';

const promptGroups = [
  {
    label: 'Choose with confidence',
    prompts: [
      'Which provider has the strongest reliability evidence for my next purchase?',
      'Which provider has enough history to be trusted for a first purchase?'
    ]
  },
  {
    label: 'Match my needs',
    prompts: [
      'Which provider has recent activity and no high-risk signals?',
      'Which provider has served the most distinct buyers successfully?'
    ]
  },
  {
    label: 'Check before paying',
    prompts: [
      'Are any providers showing wash trading, cancellations, or unusual volume?',
      'Which provider has the strongest evidence, not just the highest volume?'
    ]
  }
];

const shortAddress = (value) => {
  const address = String(value || '');
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address || 'Unknown provider';
};

const providerLabel = (provider) => provider?.agentName || shortAddress(provider?.providerId);

const formatDate = (value) => {
  if (value == null || value === '') return 'Unknown';
  const raw = typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : value;
  const date = typeof raw === 'number' && raw < 1e12 ? new Date(raw * 1000) : new Date(raw);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
};

const formatUsdc = (value) => `${Number.isFinite(Number(value)) ? Number(value).toFixed(4) : '0.0000'} USDC`;

const successPercent = (provider) => {
  const value = provider?.successRate != null
    ? Number(provider.successRate) * 100
    : Number(provider?.paymentCount) > 0
      ? (Number(provider.successfulPayments || 0) / Number(provider.paymentCount)) * 100
      : null;
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : 'No evidence';
};

const copyValue = async (value) => {
  if (value && typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(String(value));
};

const RiskBadge = ({ level }) => {
  const styles = level === 'high'
    ? 'bg-rose-500/15 text-rose-300 border-rose-500/25'
    : level === 'medium'
      ? 'bg-amber-500/15 text-amber-300 border-amber-500/25'
      : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25';
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${styles}`}><FiShield size={10} />{level === 'high' ? 'High risk' : level === 'medium' ? 'Medium risk' : 'Low risk'}</span>;
};

const TrustBadge = ({ provider }) => {
  const score = provider?.trustScore;
  if (!provider?.paymentCount) return <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800/50 px-2 py-0.5 text-[10px] font-semibold text-zinc-400"><FiInfo size={10} /> No history</span>;
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${score >= 70 ? 'bg-emerald-500/15 text-emerald-300' : score >= 40 ? 'bg-amber-500/15 text-amber-300' : 'bg-rose-500/15 text-rose-300'}`}><FiShield size={10} />Trust {score ?? 0}/100</span>;
};

const EvidenceBar = ({ label, value, detail, color = 'bg-violet-400' }) => (
  <div>
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-zinc-300">{label}</span>
      <span className="font-mono text-zinc-400">{detail}</span>
    </div>
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800"><div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>
  </div>
);

export default function DevGraphIntelligence() {
  const status = useApi({ fetcher: developerApi.graphStatus });
  const [question, setQuestion] = useState(promptGroups[0].prompts[0]);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const askQuestion = async (value) => {
    setQuestion(value);
    setLoading(true);
    setError(null);
    try { setResult(await developerApi.graphAsk(value)); }
    catch (err) { setError(err.message || 'Trust Engine request failed.'); }
    finally { setLoading(false); }
  };

  const ask = async (event) => { event?.preventDefault(); await askQuestion(question); };
  const providers = result?.providers || [];
  const safest = [...providers].sort((a, b) => Number(b.trustScore || 0) - Number(a.trustScore || 0))[0];

  return (
    <div className="mx-auto max-w-[1240px] space-y-6">
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300"><FiShield size={20} /></div>
          <div>
            <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-bold text-white">Graph Intelligence</h1><span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-[10px] font-semibold text-violet-300">ON-CHAIN TRUST</span></div>
            <p className="mt-1 text-sm text-zinc-500">Evidence for choosing an agent provider before your next payment.</p>
          </div>
        </div>
        <div className="mt-5 grid gap-3 lg:grid-cols-[1.4fr_1fr]">
          <div className="rounded-2xl border border-violet-500/20 bg-gradient-to-br from-violet-500/10 via-zinc-900/60 to-cyan-500/5 p-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-300">The decision layer</p>
            <h2 className="mt-2 max-w-xl text-lg font-semibold text-white">Which provider has earned the right to be trusted?</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">Trust is computed per payee wallet from ArbiterManager settlement events. It is not a self-reported rating, a star score, or a value typed into the database.</p>
            <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-zinc-300"><span className="rounded-full bg-zinc-950/60 px-2.5 py-1">Settlement history</span><span className="rounded-full bg-zinc-950/60 px-2.5 py-1">Risk signals</span><span className="rounded-full bg-zinc-950/60 px-2.5 py-1">Confidence</span></div>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5"><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Data lineage</p><div className="mt-4 flex items-center gap-2 text-xs text-zinc-300"><span className="rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-2">Arbitrum</span><span className="text-zinc-600">→</span><span className="rounded-lg border border-violet-500/30 bg-violet-500/10 px-2.5 py-2 text-violet-300">The Graph</span><span className="text-zinc-600">→</span><span className="rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-2">Trust score</span></div><p className="mt-4 text-xs leading-relaxed text-zinc-500">The Graph is preferred. If it is unavailable, the backend reads the same ArbiterManager logs directly from Arbitrum.</p></div>
        </div>
      </header>

      {status.loading ? <Skeleton className="h-24 rounded-2xl" /> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"><p className="text-[10px] uppercase tracking-widest text-zinc-500">Source</p><p className={`mt-1 text-sm font-semibold ${status.data?.live ? 'text-emerald-400' : 'text-amber-400'}`}>{status.data?.live ? 'Live' : 'Unavailable'}</p><p className="text-[10px] text-zinc-500">{status.data?.provider || 'The Graph'}</p></div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"><p className="text-[10px] uppercase tracking-widest text-zinc-500">Indexed evidence</p><p className="mt-1 text-sm font-semibold text-white">{status.data?.settlementCount ?? 0} settlements</p><p className="text-[10px] text-zinc-500">{status.data?.paymentCount ?? 0} payment records</p></div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"><p className="text-[10px] uppercase tracking-widest text-zinc-500">Indexed block</p><p className="mt-1 text-sm font-semibold text-white">#{status.data?.indexedBlock ?? '?'}</p><p className="text-[10px] text-zinc-500">Head #{status.data?.headBlock ?? '?'}</p></div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"><p className="text-[10px] uppercase tracking-widest text-zinc-500">Sync lag</p><p className="mt-1 text-sm font-semibold text-white">{status.data?.lagBlocks ?? '?'} blocks</p><p className="text-[10px] text-zinc-500">{status.data?.syncing ? 'Catching up' : 'Within tolerance'}</p></div>
      </div>}

      <Card title="Ask the Trust Engine" subtitle="Describe the purchase decision. The answer is computed live from indexed settlements.">
        <form onSubmit={ask} className="flex flex-col gap-3 sm:flex-row"><div className="relative flex-1"><FiSearch className="absolute left-3 top-3 text-zinc-500" size={16} /><input value={question} onChange={(e) => setQuestion(e.target.value)} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 py-2.5 pl-9 pr-3 text-sm text-white outline-none focus:border-violet-500" placeholder="Which OCR provider is safest?" /></div><button disabled={loading || !question.trim()} className="inline-flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50">{loading ? <FiActivity className="animate-spin" /> : <FiShield />} Analyze providers</button></form>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">{promptGroups.map((group) => <div key={group.label}><p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">{group.label}</p>{group.prompts.map((prompt) => <button key={prompt} type="button" onClick={() => askQuestion(prompt)} className="mb-2 block rounded-full border border-zinc-800 px-3 py-1.5 text-left text-xs text-zinc-400 hover:border-violet-500/50 hover:text-violet-300">{prompt}</button>)}</div>)}</div>
      </Card>

      {error && <ErrorBanner message={error} />}
      {!result && !loading && !error && <Card title="How to read this page"><div className="grid gap-3 sm:grid-cols-3"><div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4"><FiShield className="text-violet-400" /><p className="mt-3 text-sm font-medium text-white">Trust is a score</p><p className="mt-1 text-xs leading-relaxed text-zinc-500">Reliability, buyer diversity, track record, recency, and consistency are combined on a 0–100 scale.</p></div><div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4"><FiAlertTriangle className="text-amber-400" /><p className="mt-3 text-sm font-medium text-white">Risk is separate</p><p className="mt-1 text-xs leading-relaxed text-zinc-500">Wash trading, cancellation streaks, failure dominance, volume spikes, and inactivity create risk flags.</p></div><div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4"><FiBarChart2 className="text-cyan-400" /><p className="mt-3 text-sm font-medium text-white">Confidence adds context</p><p className="mt-1 text-xs leading-relaxed text-zinc-500">A score backed by six payments should not be read like one backed by twenty.</p></div></div></Card>}

      {result && providers.length === 0 && <Card title="No provider evidence found" subtitle={`Intent: ${result.intent || 'provider analysis'} · Source: ${result.source || 'The Graph'}`}><p className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm leading-relaxed text-amber-100">{result.answer || 'No indexed settlement history matched this request. A provider with no history is not automatically unsafe; it is simply unproven by this dataset.'}</p></Card>}

      {result && providers.length > 0 && <>
        <Card title={<span className="flex items-center gap-2">Recommendation <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-300">{result.source || 'The Graph'}</span></span>} subtitle={`Question: ${question}`}>
          <div className="rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 via-zinc-950/40 to-violet-500/5 p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-[10px] uppercase tracking-widest text-emerald-300">Best supported by current evidence</p><h2 className="mt-2 text-xl font-semibold text-white">{providerLabel(safest)}</h2><p className="mt-1 font-mono text-xs text-zinc-500">{safest.providerId}</p></div><div className="text-left sm:text-right"><p className="text-4xl font-black text-white">{safest.trustScore ?? '—'}<span className="text-lg text-zinc-500">/100</span></p><div className="mt-1 flex flex-wrap gap-2 sm:justify-end"><TrustBadge provider={safest} /><RiskBadge level={safest.riskLevel} /></div></div></div><div className="mt-5 grid gap-3 sm:grid-cols-4"><div><p className="text-[10px] uppercase text-zinc-500">Success rate</p><p className="mt-1 text-sm font-semibold text-white">{successPercent(safest)}</p></div><div><p className="text-[10px] uppercase text-zinc-500">Settlements</p><p className="mt-1 text-sm font-semibold text-white">{safest.successfulPayments ?? 0}/{safest.paymentCount ?? 0}</p></div><div><p className="text-[10px] uppercase text-zinc-500">Unique buyers</p><p className="mt-1 text-sm font-semibold text-white">{safest.uniquePayers ?? 0}</p></div><div><p className="text-[10px] uppercase text-zinc-500">Confidence</p><p className="mt-1 text-sm font-semibold text-white">{Math.round(Number(safest.confidence || 0) * 100)}%</p></div></div></div>
        </Card>

        <div className="grid gap-6 xl:grid-cols-[1.15fr_.85fr]">
          <Card title="Why this score?" subtitle="Transparent weighting used by the Trust Engine."><div className="space-y-5"><EvidenceBar label="Reliability" value={Number(safest.successRate || 0) * 100} detail={`${Math.round(Number(safest.successRate || 0) * 100)}% · max 40`} color="bg-emerald-400" /><EvidenceBar label="Buyer diversity" value={Math.min(100, Number(safest.uniquePayers || 0) * 10)} detail={`${safest.uniquePayers || 0}/10 buyers · max 15`} /><EvidenceBar label="Track record" value={Math.min(100, Number(safest.successfulPayments || 0) * 4)} detail={`${safest.successfulPayments || 0}/25 successful · max 15`} color="bg-cyan-400" /><EvidenceBar label="Recent activity" value={safest.paymentsLast24h ? 100 : safest.paymentsLast7d ? 67 : safest.paymentsLast30d ? 33 : 0} detail={safest.lastSettlement ? formatDate(safest.lastSettlement) : 'none'} color="bg-amber-400" /><EvidenceBar label="Consistency" value={Math.min(100, Number(safest.paymentsLast30d || 0) * 20)} detail={`${safest.paymentsLast30d || 0}/5 in 30 days · max 15`} color="bg-fuchsia-400" /></div><div className="mt-5 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3 text-xs leading-relaxed text-zinc-500"><FiInfo className="mr-2 inline text-violet-400" />Penalties can reduce the score for self-payments, cancellation streaks, unusual volume spikes, or more failures than successes. The final score is clamped between 0 and 100.</div></Card>
          <Card title="Risk signals" subtitle="Flags are derived from settlement behavior, not opinions."><div className="space-y-2">{(safest.riskFlags || []).length ? safest.riskFlags.map((flag) => <div key={flag.code} className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3"><div className="flex items-center gap-2 text-xs font-semibold text-amber-200"><FiAlertTriangle size={13} />{flag.code.replaceAll('_', ' ')}</div><p className="mt-1 text-xs leading-relaxed text-zinc-400">{flag.detail}</p></div>) : <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm text-emerald-200"><FiCheckCircle className="mr-2 inline" />No high-signal risk flags found in the indexed history.</div>}</div><div className="mt-4 grid grid-cols-2 gap-2 text-xs"><div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3"><FiClock className="text-cyan-400" /><p className="mt-2 text-zinc-500">Last 30 days</p><p className="mt-1 font-semibold text-white">{safest.paymentsLast30d || 0} payments</p></div><div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3"><FiUsers className="text-violet-400" /><p className="mt-2 text-zinc-500">Repeat buyers</p><p className="mt-1 font-semibold text-white">{safest.repeatCustomers || 0}</p></div></div></Card>
        </div>

        <Card title="Provider comparison" subtitle="A high score means stronger settlement evidence, not guaranteed service quality."><div className="mb-4 h-56"><ResponsiveContainer width="100%" height="100%"><BarChart data={providers.slice(0, 8).map((provider) => ({ name: providerLabel(provider), trust: Number(provider.trustScore || 0) }))} margin={{ top: 8, right: 8, left: -18, bottom: 4 }}><CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" tick={{ fill: '#a1a1aa', fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis domain={[0, 100]} tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 10 }} formatter={(value) => [`${value}/100`, 'Trust']} /><Bar dataKey="trust" fill="#a78bfa" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="text-[10px] uppercase tracking-wider text-zinc-500"><tr><th className="pb-3">Provider</th><th className="pb-3">Trust</th><th className="pb-3">Success</th><th className="pb-3">Volume</th><th className="pb-3">Buyers</th><th className="pb-3">Risk</th><th className="pb-3">Evidence</th></tr></thead><tbody>{providers.map((provider, index) => { const validWallet = /^0x[0-9a-fA-F]{40}$/.test(String(provider.providerId || '')); return <tr key={provider.providerId} className="border-t border-zinc-800/70"><td className="py-3 text-white">{index === 0 && <FiCheckCircle className="mr-2 inline text-emerald-400" size={14} />}<span>{providerLabel(provider)}</span><button type="button" title="Copy provider address" onClick={() => copyValue(provider.providerId)} className="ml-2 text-zinc-500 hover:text-white"><FiCopy size={12} /></button></td><td className="py-3"><TrustBadge provider={provider} /></td><td className="py-3 text-zinc-300">{provider.successfulPayments ?? 0}/{provider.paymentCount ?? 0}<span className="ml-1 text-[10px] text-zinc-500">{successPercent(provider)}</span></td><td className="py-3 font-mono text-cyan-300">{formatUsdc(provider.settlementVolume)}</td><td className="py-3 text-zinc-300">{provider.uniquePayers ?? 0}</td><td className="py-3"><RiskBadge level={provider.riskLevel} /></td><td className="py-3">{validWallet ? <a className="inline-flex items-center gap-1 text-violet-400 hover:text-violet-300" href={`https://sepolia.arbiscan.io/address/${provider.providerId}`} target="_blank" rel="noreferrer">Verify <FiExternalLink size={12} /></a> : <span className="text-xs text-zinc-600">No wallet</span>}</td></tr>; })}</tbody></table></div></Card>

        {safest.settlements?.length > 0 && <Card title="Recent indexed settlements" subtitle="Open the transaction to verify the evidence directly on Arbiscan."><div className="divide-y divide-zinc-800/70">{safest.settlements.map((settlement) => <div key={settlement.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs"><div className="flex items-center gap-2"><span className="text-emerald-400">Released</span><span className="font-mono text-cyan-300">{formatUsdc(settlement.amount)}</span><span className="text-zinc-500">{formatDate(settlement.timestamp)}</span></div>{settlement.transactionHash && <a className="inline-flex items-center gap-1 font-mono text-violet-400 hover:text-violet-300" href={`https://sepolia.arbiscan.io/tx/${settlement.transactionHash}`} target="_blank" rel="noreferrer">{shortAddress(settlement.transactionHash)} <FiExternalLink size={12} /></a>}</div>)}</div></Card>}
      </>}

      <Card title="How the score is calculated" subtitle="A transparent signal, not a guarantee."><div className="grid gap-3 md:grid-cols-2"><div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4"><p className="text-sm font-semibold text-white">Score: 0–100</p><p className="mt-2 text-xs leading-relaxed text-zinc-400">Success rate contributes up to 40 points. Buyer diversity, successful track record, recency, and activity consistency contribute up to 15 points each. Risk penalties are then applied and the result is clamped to 0–100.</p></div><div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4"><p className="text-sm font-semibold text-white">Confidence: evidence depth</p><p className="mt-2 text-xs leading-relaxed text-zinc-400">Confidence is based on successful and failed payments, reaching 100% at 20 observations. A high score with low confidence means “promising, but thin evidence.”</p></div><div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4"><p className="text-sm font-semibold text-white">Publisher continuity</p><p className="mt-2 text-xs leading-relaxed text-zinc-400">When an established publisher rotates to a new wallet, the wallet may inherit a bounded 25-point floor. This prevents wallet rotation from erasing history, but never multiplies the score.</p></div><div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4"><p className="text-sm font-semibold text-white">What this cannot prove</p><p className="mt-2 text-xs leading-relaxed text-zinc-400">It cannot measure off-chain service quality, identity, KYC, or settlements outside ArbiterManager on Arbitrum Sepolia. Use it as payment evidence, not as a complete provider review.</p></div></div><div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs leading-relaxed text-amber-100"><FiTrendingUp className="mt-0.5 shrink-0 text-amber-400" />Profile pages may show a separate operational score that blends database metrics such as uptime or ratings. This page is the canonical on-chain Trust Engine: Graph-indexed settlement evidence only.</div></Card>
    </div>
  );
}

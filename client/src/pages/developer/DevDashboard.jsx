import React, { useMemo } from 'react';
import {
  FiCpu, FiCheckCircle, FiZap, FiDollarSign, FiRefreshCw,
  FiServer, FiDatabase, FiRadio, FiClock, FiActivity, FiArrowRight, FiExternalLink,
  FiPackage, FiShoppingBag, FiArrowUpRight, FiArrowDownRight, FiCpu as FiChip
} from 'react-icons/fi';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
} from 'recharts';
import Card from '../../components/dev/Card';
import Skeleton from '../../components/dev/Skeleton';
import useApi from '../../hooks/useApi';
import developerApi from '../../utils/developerApi';

const CHART_TOOLTIP = { background: '#111111', border: '1px solid #333333', borderRadius: 8, fontSize: 11 };

/* Neon glow filter (Hyper Charts style) — referenced by id inside each chart's <defs>. */
const GlowFilter = ({ id }) => (
  <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="0" stdDeviation="1.6" floodColor="currentColor" floodOpacity="0.65" />
  </filter>
);

const hasData = (rows = [], key) => rows.some((r) => r && Number(r[key]) !== 0);

const fmtAgo = (ts) => {
  const mins = Math.max(1, Math.round((Date.now() / 1000 - ts) / 60));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

/* Sparkline built from the chart series — the tiny trend next to each KPI */
const Spark = ({ data = [], color = '#fafafa', dataKey }) => {
  const points = useMemo(() => {
    const vals = data.map((d) => Number(d[dataKey] || 0));
    if (vals.length < 2 || vals.every((v) => v === 0)) return null;
    const max = Math.max(...vals), min = Math.min(...vals);
    const span = max - min || 1;
    return vals.map((v, i) => `${(i / (vals.length - 1)) * 100},${28 - ((v - min) / span) * 24}`).join(' ');
  }, [data, dataKey]);
  if (!points) return <svg viewBox="0 0 100 28" className="h-6 w-16 opacity-20 lg:w-20"><line x1="0" y1="26" x2="100" y2="26" stroke={color} strokeWidth="1" /></svg>;
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="h-6 w-16 lg:w-20">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

const pctDelta = (series = [], key) => {
  const vals = series.map((r) => Number(r[key] || 0)).filter((v) => !Number.isNaN(v));
  if (vals.length < 2) return null;
  const first = vals.slice(0, Math.max(1, Math.floor(vals.length / 2))).reduce((a, b) => a + b, 0);
  const last = vals.slice(Math.max(1, Math.floor(vals.length / 2))).reduce((a, b) => a + b, 0);
  if (first === 0) return last > 0 ? 100 : null;
  return Math.round(((last - first) / first) * 100);
};

/* ── KPI tile: label · big mono numeral · delta · sparkline ── */
const Kpi = ({ label, value, sub, delta, color, data, dataKey }) => (
  <div className="flex min-w-0 items-start justify-between gap-3 border-r border-[#2e2e2e] px-5 py-4 last:border-r-0">
    <div className="min-w-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#525252]">{label}</p>
      <p className="mt-2 font-mono text-[22px] font-semibold leading-none tracking-tight text-[#f5f5f5] xl:text-[26px]">{value}</p>
      <div className="mt-2 flex items-center gap-2">
        {delta != null && delta !== 0 && (
          <span className={`inline-flex items-center gap-0.5 font-mono text-[11px] ${delta > 0 ? 'text-[#e5e5e5]' : 'text-[#f87171]'}`}>
            {delta > 0 ? <FiArrowUpRight size={11} /> : <FiArrowDownRight size={11} />}
            {delta > 0 ? '+' : ''}{delta}%
          </span>
        )}
        {sub && <span className="font-mono text-[10px] text-[#404040]">{sub}</span>}
      </div>
    </div>
    <Spark data={data} dataKey={dataKey} color={color} />
  </div>
);

/* ── Lifecycle node ── */
const LifecycleNode = ({ step, label, done, to, last }) => (
  <a href={to} className="group relative flex-1 min-w-[120px]">
    <div className="flex items-center">
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] transition-colors ${done
        ? 'border-[#fafafa] bg-[#fafafa]/10 text-[#fafafa]'
        : 'border-[#3a3a3a] bg-[#111111] text-[#404040] group-hover:border-[#404040]'}`}>
        {done ? '✓' : String(step).padStart(2, '0')}
      </span>
      {!last && <span className={`h-px flex-1 ${done ? 'bg-[#fafafa]/40' : 'bg-[#2e2e2e]'}`} />}
    </div>
    <p className={`mt-3 font-mono text-[10px] uppercase tracking-[0.18em] ${done ? 'text-[#8f8f8f]' : 'text-[#404040]'}`}>{label}</p>
    <p className={`mt-0.5 font-mono text-[10px] ${done ? 'text-[#fafafa]' : 'text-[#a3a3a3]'}`}>{done ? 'Complete' : 'Pending'}</p>
  </a>
);

/* ── System status row ── */
const StatusRow = ({ label, value, ok }) => (
  <div className="flex items-center justify-between border-b border-[#262626] py-2.5 last:border-b-0">
    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#525252]">{label}</span>
    <span className="flex items-center gap-2 font-mono text-[11px] text-[#a3a3a3]">
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-[#fafafa] shadow-[0_0_6px_rgba(255,255,255,0.7)]' : 'bg-[#f87171]'}`} />
      {value}
    </span>
  </div>
);

/* ── Activity feed item ── */
const ActivityItem = ({ tone, title, meta, amount, time, txHash }) => (
  <div className="flex items-start gap-3 border-b border-[#262626] py-3 last:border-b-0">
    <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border ${tone === 'green' ? 'border-[#fafafa]/30 bg-[#fafafa]/10 text-[#fafafa]' : 'border-[#3a3a3a] bg-[#161616] text-[#8f8f8f]'}`}>
      {tone === 'green' ? <FiCheckCircle size={11} /> : <FiActivity size={11} />}
    </span>
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#d4d4d4]">{title}</p>
        {time && <span className="shrink-0 font-mono text-[10px] text-[#404040]">{time}</span>}
      </div>
      <p className="truncate font-mono text-[10px] text-[#525252]">{meta}</p>
      <div className="flex items-center gap-2">
        {amount && <p className="font-mono text-[12px] font-semibold text-[#f5f5f5]">{amount}</p>}
        {txHash && (
          <a
            href={`https://sepolia.arbiscan.io/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="truncate font-mono text-[10px] text-[#e5e5e5]/70 hover:text-[#e5e5e5] hover:underline"
          >
            tx {String(txHash).slice(0, 10)}…{String(txHash).slice(-6)}
          </a>
        )}
      </div>
    </div>
  </div>
);

const EmptyMini = ({ note }) => (
  <div className="relative h-full flex flex-col items-center justify-center text-center overflow-hidden">
    {/* faint dotted grid so the empty chart still reads as a chart */}
    <div
      className="pointer-events-none absolute inset-0 opacity-40"
      style={{ backgroundImage: 'radial-gradient(circle, #1f1f1f 1px, transparent 1px)', backgroundSize: '18px 18px' }}
    />
    <div className="relative flex flex-col items-center">
      <span className="mb-3 flex h-8 w-8 items-center justify-center rounded-full border border-[#2e2e2e] bg-[#111111]">
        <FiActivity size={13} className="text-[#404040]" />
      </span>
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#525252] max-w-[240px] leading-relaxed">{note}</p>
      <span className="mt-3 inline-block h-px w-10 bg-[#2e2e2e]" />
    </div>
  </div>
);

const ChartCard = ({ title, sub, children, delta }) => (
  <div className="border border-[#2e2e2e] bg-[#111111]">
    <div className="flex items-start justify-between border-b border-[#262626] px-4 py-3">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#8f8f8f]">{title}</p>
        {sub && <p className="mt-0.5 font-mono text-[10px] text-[#404040]">{sub}</p>}
      </div>
      {delta != null && delta !== 0 && (
        <span className={`inline-flex items-center gap-0.5 font-mono text-[10px] ${delta > 0 ? 'text-[#e5e5e5]' : 'text-[#f87171]'}`}>
          {delta > 0 ? '↑' : '↓'} {delta > 0 ? '+' : ''}{delta}%
        </span>
      )}
    </div>
    <div className="h-40 p-3">{children}</div>
  </div>
);

const DevDashboard = () => {
  const { data, loading, error, refresh, refreshing } = useApi({ fetcher: developerApi.dashboard });
  const monitor = useApi({ fetcher: developerApi.monitoring });
  const graphStatus = useApi({ fetcher: developerApi.graphStatus });
  const arbiter = useApi({ fetcher: developerApi.arbiterInfo });

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] p-6">
        <Skeleton className="h-10 w-96 rounded" />
        <div className="mt-8 grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
        <Skeleton className="mt-6 h-40 rounded-xl" />
        <div className="mt-6 grid lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-52 rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] p-6">
        <div className="border border-red-900/40 bg-red-950/10 p-5">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-red-400">Signal lost</p>
          <p className="mt-2 text-sm text-zinc-400">{error.message}</p>
          <button onClick={refresh} className="mt-3 font-mono text-xs text-red-300 underline hover:text-red-200">Retry</button>
        </div>
      </div>
    );
  }

  const d = data || {};
  const api = monitor.data?.api || {};
  const db = monitor.data?.database || {};
  const rpc = monitor.data?.rpc || {};
  const workers = monitor.data?.workers || {};
  const c = d.charts || {};
  const g = graphStatus.data || {};
  const price = arbiter.data?.chainlinkPrice;

  const isFirstTime = (d.totalAgents || 0) === 0 && (d.servicesPublished || 0) === 0;
  const lifecycle = [
    { label: 'Create Agent', done: Number(d.totalAgents || 0) > 0, to: '/developer/agents' },
    { label: 'MPC Wallet', done: Number(d.walletsCreated || 0) > 0, to: '/developer/agents' },
    { label: 'Publish Service', done: Number(d.servicesPublished || 0) > 0, to: '/developer/marketplace/services/publish' },
    { label: 'First Payment', done: Number(d.successfulPayments || 0) > 0, to: '/developer/commerce/sessions' },
    { label: 'Graph Reputation', done: Number(d.successfulPayments || 0) > 0, to: '/developer/graph-intelligence' }
  ];

  const reqDelta = pctDelta(c.requestsOverTime, 'requests');
  const volDelta = pctDelta(c.volumeOverTime, 'volume');
  const revDelta = pctDelta(c.revenue, 'revenue');
  const walletDelta = pctDelta(c.walletGrowth, 'wallets');

  const usdcVolume = Number(d.transactionVolumeUSDC || d.transactionVolumeUsdc || d.transactionVolumeBOT || 0);

  // ── On-chain settlement series (The Graph) ──
  // Prefer real on-chain settlements over local invoice tables: fresh workspaces
  // have no DB invoice rows yet, but every settle lives on Arbitrum Sepolia.
  const buildSeries = (list, pick) => {
    const byDay = new Map();
    (list || []).forEach((s) => {
      if (!s?.timestamp) return;
      const day = new Date(Number(s.timestamp) * 1000).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + Number(pick(s) || 0));
    });
    return [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, value]) => ({ date: date.slice(5), value: Number(value.toFixed(4)) }));
  };
  const chainSeries = buildSeries(g.settlementSeries, (s) => s.amount);
  const releasedSeries = buildSeries(
    (g.settlementSeries || []).filter((s) => String(s.status || '').toUpperCase() === 'RELEASED' || String(s.status || '').toUpperCase() === 'SETTLED'),
    (s) => s.amount
  );
  const revenueSeries = releasedSeries.length ? releasedSeries.map(({ date, value }) => ({ date, revenue: value })) : c.revenue || [];
  const volumeSeries = chainSeries.length ? chainSeries.map(({ date, value }) => ({ date, volume: value })) : c.volumeOverTime || [];
  const chainRevenueTotal = releasedSeries.reduce((s, p) => s + p.value, 0);
  const chainVolumeTotal = chainSeries.reduce((s, p) => s + p.value, 0);

  // Sparse-data fix: trim leading all-zero buckets so charts fill their card.
  const trimLeadingZeros = (list, key) => {
    if (!Array.isArray(list) || list.length < 3) return list;
    let i = 0;
    while (i < list.length - 2 && Number(list[i]?.[key] || 0) === 0) i += 1;
    return i > 0 ? list.slice(i) : list;
  };
  const requestsData = trimLeadingZeros(c.requestsOverTime, 'requests');
  const walletData = trimLeadingZeros(c.walletGrowth, 'wallets');
  const activeData = trimLeadingZeros(c.activeOverTime, 'active');

  const activity = (g.recentSettlements || []).slice(0, 6).map((s) => ({
    tone: 'green',
    title: 'PAYMENT SETTLED',
    meta: `${s.status || 'SETTLED'} · ${s.timestamp ? new Date(Number(s.timestamp) * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'recent'}`,
    amount: `${Number(s.amount || 0).toFixed(2)} USDC`,
    time: s.timestamp ? fmtAgo(Number(s.timestamp)) : '',
    txHash: s.transactionHash
  }));

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#f5f5f5]" style={{ fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif' }}>
      {/* ── Top bar ── */}
      <div className="flex items-center justify-between border-b border-[#262626] px-6 py-3">
        <div className="flex items-center gap-3 font-mono text-[11px] text-[#525252]">
          <span className="text-[#8f8f8f]">ARBITER</span>
          <span className="text-[#2e2e2e]">/</span>
          <span>CONSOLE</span>
          <span className="text-[#2e2e2e]">/</span>
          <span className="text-[#8f8f8f]">DASHBOARD</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="hidden items-center gap-2 rounded-full border border-[#2e2e2e] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[#8f8f8f] sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-[#fafafa] shadow-[0_0_6px_rgba(255,255,255,0.8)]" />
            Arbitrum Sepolia
          </span>
          {price && (
            <span className="hidden font-mono text-[10px] text-[#525252] md:block">
              CHAINLINK USDC/USD <span className="text-[#8f8f8f]">${price}</span>
            </span>
          )}
          <button
            onClick={() => refresh({ background: true })}
            disabled={refreshing}
            className="inline-flex items-center gap-2 border border-[#2e2e2e] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[#8f8f8f] hover:border-[#404040] hover:text-[#d4d4d4] disabled:opacity-50"
          >
            <FiRefreshCw size={11} className={refreshing ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {/* ── Hero ── */}
      <div className="relative overflow-hidden border-b border-[#262626] px-6 py-10">
        <div
          className="pointer-events-none absolute right-[-120px] top-[-160px] h-[420px] w-[420px] rounded-full opacity-40"
          style={{ background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.08), transparent 60%)' }}
        />
        <div className="relative flex flex-wrap items-end justify-between gap-8">
          <div className="max-w-2xl">
            <p className="flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.35em] text-[#737373]">
              <span className="h-2 w-2 animate-pulse rounded-full bg-[#e2574f]" /> Dashboard
            </p>
            <h1 className="mt-5 font-serif text-[40px] font-normal leading-[1.04] text-white sm:text-[52px] xl:text-[64px]">
              The infrastructure behind<br />autonomous commerce.
            </h1>
            <p className="mt-5 max-w-[540px] text-[15px] leading-7 text-[#8f8f8f]">
              Monitor agents, settlements, wallets, and the public record they leave behind.
            </p>
          </div>
          <div className="hidden flex-col items-end gap-1.5 lg:flex">
            <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#737373]">Agents that pay.</p>
            <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#4a4a4a]">Receipts nobody can erase.</p>
          </div>
        </div>
      </div>

      {/* ── KPI row ── */}
      <div className="grid grid-cols-2 border-b border-[#262626] lg:grid-cols-4">
        <Kpi
          label="Active Agents"
          value={String(d.activeAgents ?? d.totalAgents ?? 0)}
          sub={`${d.totalAgents ?? 0} total`}
          color="#4ade80"
          data={activeData}
          dataKey="active"
        />
        <Kpi
          label="Revenue"
          value={chainRevenueTotal > 0 ? `${chainRevenueTotal.toFixed(2)} USDC` : (d.monthlyRevenueUsd != null ? `$${Number(d.monthlyRevenueUsd).toFixed(2)}` : '$0.00')}
          sub={chainRevenueTotal > 0 ? 'released on-chain' : 'invoices'}
          delta={revDelta}
          color="#4ade80"
          data={revenueSeries}
          dataKey="revenue"
        />
        <Kpi
          label="USDC Volume"
          value={`${(chainVolumeTotal || usdcVolume).toFixed(2)} USDC`}
          sub="settled on-chain"
          delta={volDelta}
          color="#a78bfa"
          data={volumeSeries}
          dataKey="volume"
        />
        <Kpi
          label="Settlements"
          value={String(g.settlementCount ?? d.successfulPayments ?? 0)}
          sub={g.graphLive ? 'graph verified' : 'pending'}
          delta={reqDelta}
          color="#22d3ee"
          data={requestsData}
          dataKey="requests"
        />
      </div>

      {/* ── Agent lifecycle ── */}
      <div className="border-b border-[#262626] px-6 py-7">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-serif text-[22px] font-normal leading-tight text-[#ffffff]">Agent Lifecycle</h2>
            <p className="mt-0.5 text-xs text-[#525252]">From wallet creation to marketplace reputation.</p>
          </div>
          <a
            href="/developer/commerce/autonomous"
            className="inline-flex items-center gap-2 border border-[#fafafa]/30 bg-[#fafafa]/5 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[#fafafa] hover:bg-[#fafafa]/10"
          >
            Run autonomous commerce <FiArrowRight size={11} />
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-x-0 gap-y-6">
          {lifecycle.map((stage, i) => <LifecycleNode key={stage.label} step={i + 1} {...stage} last={i === lifecycle.length - 1} />)}
        </div>
      </div>

      {/* ── The Graph strip (full width) ── */}
      <div className="border-b border-[#262626] px-6 py-7">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-serif text-[22px] font-normal leading-tight text-[#ffffff]">The Graph</h2>
            <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-[#525252]">Trust Engine · Live data from the Arbiter subgraph</p>
          </div>
          <a href="/developer/graph-intelligence" className="inline-flex items-center gap-1.5 border border-[#2e2e2e] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[#8f8f8f] hover:border-[#404040] hover:text-[#d4d4d4]">
            View Explorer <FiExternalLink size={10} />
          </a>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-5 md:grid-cols-3 xl:grid-cols-5">
          {[
            { label: 'Indexed Block', value: g.indexedBlock != null ? `#${Number(g.indexedBlock).toLocaleString()}` : '—', ok: g.indexedBlock != null },
            { label: 'Payments', value: String(g.paymentCount ?? 0), ok: (g.paymentCount || 0) > 0 },
            { label: 'Settlements', value: String(g.settlementCount ?? 0), ok: (g.settlementCount || 0) > 0 },
            { label: 'Network', value: g.network || 'Arbitrum Sepolia', ok: true },
            { label: 'Sync', value: g.lagBlocks != null ? `${g.lagBlocks}b behind` : '—', ok: g.syncing === false }
          ].map((item) => (
            <div key={item.label} className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#525252]">{item.label}</p>
              <p className="mt-1.5 flex items-center gap-2 truncate font-mono text-[15px] font-semibold text-[#f5f5f5] xl:text-lg">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.ok ? 'bg-[#fafafa] shadow-[0_0_6px_rgba(255,255,255,0.7)]' : 'bg-[#a3a3a3]'}`} />
                <span className="truncate">{item.value}</span>
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* ── System status + recent activity (2-col band) ── */}
      <div className="grid border-b border-[#262626] lg:grid-cols-2">
        {/* System status */}
        <div className="border-b border-[#262626] px-6 py-7 lg:border-b-0 lg:border-r">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#8f8f8f]">System Status</h3>
          <p className="mt-0.5 font-mono text-[10px] text-[#404040]">Live infrastructure health.</p>
          <div className="mt-4">
            <StatusRow label="API" value={(api?.status === 'ok' ? 'Healthy' : 'Down')} ok={api?.status === 'ok'} />
            <StatusRow label="Database" value={db?.status === 'ok' && db?.latencyMs != null ? `${db.latencyMs}ms` : 'Unreachable'} ok={db?.status === 'ok'} />
            <StatusRow label="RPC" value={rpc?.status === 'ok' && rpc?.blockNumber != null ? `#${Number(rpc.blockNumber).toLocaleString()}` : 'Unreachable'} ok={rpc?.status === 'ok'} />
            <StatusRow label="Broadcast" value={workers?.broadcastRecovery?.status === 'running' ? 'Running' : 'Stopped'} ok={workers?.broadcastRecovery?.status === 'running'} />
            <StatusRow label="Scheduler" value={workers?.scheduledPayment?.status === 'running' ? 'Running' : 'Stopped'} ok={workers?.scheduledPayment?.status === 'running'} />
          </div>
        </div>

        {/* Recent activity */}
        <div className="px-6 py-7">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#8f8f8f]">Recent Activity</h3>
            <a href="/developer/commerce/sessions" className="font-mono text-[10px] text-[#e5e5e5]/70 hover:text-[#e5e5e5]">View all →</a>
          </div>
          <div className="mt-3">
            {activity.length === 0 && (
              <p className="py-6 font-mono text-[10px] uppercase tracking-[0.18em] text-[#404040]">No settlements yet — run the held demo.</p>
            )}
            {activity.slice(0, 4).map((item, i) => <ActivityItem key={`${item.txHash}-${i}`} {...item} />)}
          </div>
        </div>
      </div>

      {/* ── Charts grid ── */}
      <div className="border-b border-[#262626] px-6 py-7">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-serif text-[22px] font-normal leading-tight text-[#ffffff]">Activity</h2>
            <p className="mt-0.5 text-xs text-[#525252]">Last 30 days</p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <ChartCard title="API Requests" sub="per day" delta={reqDelta}>
            {hasData(c.requestsOverTime, 'requests') ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={requestsData}>
                  <defs>
                    <GlowFilter id="glowRequests" />
                    <linearGradient id="requestsFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.16} />
                      <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#1f1f1f" strokeDasharray="2 4" />
                  <XAxis dataKey="date" stroke="#404040" fontSize={9} tickLine={false} axisLine={false} />
                  <YAxis stroke="#404040" fontSize={9} tickLine={false} axisLine={false} width={26} />
                  <Tooltip contentStyle={CHART_TOOLTIP} />
                  <Area type="monotone" dataKey="requests" stroke="#22d3ee" strokeWidth={2} fill="url(#requestsFill)" dot={false} activeDot={{ r: 3.5, fill: '#22d3ee', stroke: '#0a0a0a', strokeWidth: 2 }} style={{ filter: 'url(#glowRequests)', color: '#22d3ee' }} />
                </AreaChart>
              </ResponsiveContainer>
            ) : <EmptyMini note="API calls appear once agents make requests" />}
          </ChartCard>

          <ChartCard title="Wallet Growth" sub="cumulative" delta={walletDelta}>
            {hasData(c.walletGrowth, 'wallets') ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={walletData}>
                  <defs><GlowFilter id="glowWallets" /></defs>
                  <CartesianGrid stroke="#1f1f1f" strokeDasharray="2 4" />
                  <XAxis dataKey="date" stroke="#404040" fontSize={9} tickLine={false} axisLine={false} />
                  <YAxis stroke="#404040" fontSize={9} tickLine={false} axisLine={false} width={26} />
                  <Tooltip contentStyle={CHART_TOOLTIP} />
                  <Line type="stepAfter" dataKey="wallets" stroke="#34d399" strokeWidth={2} dot={false} activeDot={{ r: 3.5, fill: '#34d399', stroke: '#0a0a0a', strokeWidth: 2 }} style={{ filter: 'url(#glowWallets)', color: '#34d399' }} />
                </LineChart>
              </ResponsiveContainer>
            ) : <EmptyMini note="Wallets are created when you add AI agents" />}
          </ChartCard>

          <ChartCard title="Revenue" sub="USDC" delta={revDelta}>
            {revenueSeries.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={revenueSeries} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <GlowFilter id="glowRevenue" />
                    <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#4ade80" stopOpacity={0.14} />
                      <stop offset="60%" stopColor="#4ade80" stopOpacity={0.04} />
                      <stop offset="100%" stopColor="#4ade80" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#1f1f1f" strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="date" stroke="#404040" fontSize={9} tickLine={false} axisLine={false} minTickGap={24} />
                  <YAxis stroke="#404040" fontSize={9} tickLine={false} axisLine={false} width={34} tickFormatter={(v) => Number(v).toFixed(2)} />
                  <Tooltip
                    contentStyle={{ ...CHART_TOOLTIP, borderColor: '#4ade80' }}
                    formatter={(v) => [`${Number(v).toFixed(4)} USDC`, 'Released']}
                    labelStyle={{ color: '#a3a3a3' }}
                    itemStyle={{ color: '#ffffff', fontWeight: 600 }}
                    cursor={{ stroke: '#fafafa', strokeOpacity: 0.25, strokeDasharray: '3 3' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="revenue"
                    stroke="#4ade80"
                    strokeWidth={2.4}
                    fill="url(#revenueFill)"
                    dot={false}
                    activeDot={{ r: 3.5, fill: '#4ade80', stroke: '#0a0a0a', strokeWidth: 2 }}
                    style={{ filter: 'url(#glowRevenue)', color: '#4ade80' }}
                    animationDuration={600}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : <EmptyMini note="Released settlements appear here — run the held demo to see revenue" />}
          </ChartCard>

          <ChartCard title="USDC Volume" sub="daily" delta={volDelta}>
            {volumeSeries.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={volumeSeries} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <GlowFilter id="glowVolume" />
                    <linearGradient id="volumeBarFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.95} />
                      <stop offset="100%" stopColor="#7c3aed" stopOpacity={0.45} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#1f1f1f" strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="date" stroke="#404040" fontSize={9} tickLine={false} axisLine={false} minTickGap={24} />
                  <YAxis stroke="#404040" fontSize={9} tickLine={false} axisLine={false} width={34} tickFormatter={(v) => Number(v).toFixed(2)} />
                  <Tooltip
                    contentStyle={{ ...CHART_TOOLTIP, borderColor: '#a78bfa' }}
                    formatter={(v) => [`${Number(v).toFixed(4)} USDC`, 'Settled']}
                    labelStyle={{ color: '#a3a3a3' }}
                    itemStyle={{ color: '#ffffff', fontWeight: 600 }}
                    cursor={{ fill: '#ffffff', fillOpacity: 0.06 }}
                  />
                  <Bar dataKey="volume" fill="url(#volumeBarFill)" radius={[3, 3, 0, 0]} maxBarSize={volumeSeries.length <= 7 ? 56 : 22} barCategoryGap={volumeSeries.length <= 7 ? '30%' : '20%'} style={{ filter: 'url(#glowVolume)' }} />
                </BarChart>
              </ResponsiveContainer>
            ) : <EmptyMini note="On-chain settlements appear here — run the held demo to populate" />}
          </ChartCard>
        </div>

        {hasData(c.activeOverTime, 'active') && (
          <div className="mt-4 border border-[#2e2e2e] bg-[#111111]">
            <div className="flex items-center justify-between border-b border-[#262626] px-4 py-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#8f8f8f]">Active Agents Over Time</p>
              <p className="font-mono text-[10px] text-[#525252]">{d.activeAgents ?? 0} active</p>
            </div>
            <div className="h-44 p-3">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={activeData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <GlowFilter id="glowActive" />
                    <linearGradient id="activeAgentsFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#fbbf24" stopOpacity={0.14} />
                      <stop offset="55%" stopColor="#fbbf24" stopOpacity={0.04} />
                      <stop offset="100%" stopColor="#fbbf24" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#1f1f1f" strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="date" stroke="#404040" fontSize={9} tickLine={false} axisLine={false} minTickGap={28} />
                  <YAxis stroke="#404040" fontSize={9} tickLine={false} axisLine={false} width={26} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ ...CHART_TOOLTIP, borderColor: '#fafafa' }}
                    formatter={(v) => [`${v} active agent${Number(v) === 1 ? '' : 's'}`, null]}
                    labelStyle={{ color: '#a3a3a3' }}
                    itemStyle={{ color: '#ffffff', fontWeight: 600 }}
                    cursor={{ stroke: '#fbbf24', strokeOpacity: 0.3, strokeDasharray: '3 3' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="active"
                    stroke="#fbbf24"
                    strokeWidth={2.4}
                    fill="url(#activeAgentsFill)"
                    dot={false}
                    activeDot={{ r: 3.5, fill: '#fbbf24', stroke: '#0a0a0a', strokeWidth: 2 }}
                    style={{ filter: 'url(#glowActive)', color: '#fbbf24' }}
                    animationDuration={600}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      {/* ── First-time onboarding ── */}
      {isFirstTime && (
        <div className="border-b border-[#262626] px-6 py-8">
          <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#a3a3a3]">Begin transmission</p>
          <h2 className="mt-1 font-serif text-[26px] font-normal leading-tight text-[#ffffff]">Your platform is live. Three steps to your first settlement:</h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            {[
              { icon: <FiCpu size={16} />, label: 'Create Agent', desc: 'Mint an MPC wallet + API key', to: '/developer/agents' },
              { icon: <FiPackage size={16} />, label: 'Publish Service', desc: 'List what your agent sells', to: '/developer/marketplace/services/publish' },
              { icon: <FiShoppingBag size={16} />, label: 'Run Held Demo', desc: 'First escrowed payment, end to end', to: '/developer/x402' }
            ].map((step, i) => (
              <a key={step.label} href={step.to} className="group border border-[#2e2e2e] bg-[#111111] p-4 hover:border-[#fafafa]/40">
                <p className="font-mono text-[10px] text-[#404040]">{String(i + 1).padStart(2, '0')}</p>
                <div className="mt-2 text-[#fafafa]">{step.icon}</div>
                <p className="mt-2 text-sm font-semibold text-[#f5f5f5]">{step.label}</p>
                <p className="mt-0.5 text-xs text-[#525252]">{step.desc}</p>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* ── Footer line ── */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-4">
        <p className="font-mono text-[9px] uppercase tracking-[0.24em] text-[#404040]">Built on Arbitrum | Verifiable commerce for a more open economy.</p>
        <p className="font-mono text-[9px] uppercase tracking-[0.24em] text-[#404040]">Every settlement leaves a record.</p>
      </div>
    </div>
  );
};

export default DevDashboard;

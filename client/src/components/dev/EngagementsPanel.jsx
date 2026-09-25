/**
 * EngagementsPanel — the freelance / B2B contract story on-chain.
 *
 * A client needs a website built. Instead of trusting each other or using a
 * middleman platform that takes 20%: they open an Arbiter engagement.
 *   client proposes 500 USDC → both sign the identical terms hash →
 *   client locks the money in escrow → freelancer delivers →
 *   client approves → freelancer is paid → reputation increments on-chain.
 *
 * The button runs the full five-step cycle on Arbitrum Sepolia against
 * ArbiterManager with REAL transactions. The list below is aggregated from
 * contract events (no database). Inspired by Pact (ETHOnline 2026).
 */
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import {
  FiPlay, FiRefreshCw, FiExternalLink, FiCheckCircle, FiFileText, FiAward,
  FiBriefcase, FiLock, FiPenTool, FiDollarSign, FiShield,
} from 'react-icons/fi';
import developerApi from '../../utils/developerApi';

const short = (a) => (a ? `${a.slice(0, 10)}…${a.slice(-8)}` : '—');

const STATUS_STYLE = {
  PROPOSED: 'text-amber-300 border-amber-500/30 bg-amber-500/10',
  ACCEPTED: 'text-cyan-300 border-cyan-500/30 bg-cyan-500/10',
  FUNDED: 'text-violet-300 border-violet-500/30 bg-violet-500/10',
  SETTLED: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10',
  CANCELLED: 'text-zinc-400 border-zinc-600/30 bg-zinc-500/10',
};

// The five steps of the freelance journey — labels match the backend cycle.
const STORY_STEPS = [
  { icon: <FiFileText size={14} />, title: 'Proposal written', story: 'Client proposes the job — price and terms are hashed on-chain', color: 'text-amber-400' },
  { icon: <FiPenTool size={14} />, title: 'Both parties sign', story: 'Freelancer signs the identical terms hash — mutual commitment, neither can change the deal', color: 'text-cyan-400' },
  { icon: <FiLock size={14} />, title: 'Client locks the money', story: 'Full amount into escrow at the live Chainlink rate — guaranteed payable, held by the contract', color: 'text-violet-400' },
  { icon: <FiBriefcase size={14} />, title: 'Work is delivered', story: 'Freelancer submits — the delivery evidence hash goes on-chain', color: 'text-blue-400' },
  { icon: <FiDollarSign size={14} />, title: 'Client approves → you get paid', story: 'Escrow releases to the freelancer — and on-chain reputation increments', color: 'text-emerald-400' },
];

const EngagementsPanel = () => {
  const [list, setList] = useState(null);
  const [reputation, setReputation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState(null);       // result of the live demo cycle
  const [revealed, setRevealed] = useState(0); // progressive timeline reveal
  const [amount, setAmount] = useState('50');
  const [services, setServices] = useState([]);       // live marketplace listings
  const [serviceId, setServiceId] = useState('');     // selected service to contract

  const load = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    try {
      const [e, r] = await Promise.all([
        developerApi.arbiterEngagements(),
        developerApi.arbiterReputation().catch(() => null),
      ]);
      setList(e);
      setReputation(r);
    } catch (err) {
      if (!silent) toast.error(err.message || 'Failed to load engagements');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  // Load the live marketplace so the contract targets a REAL published service.
  useEffect(() => {
    (async () => {
      try {
        const m = await developerApi.marketplace({ perPage: 50 });
        const rows = (m?.services || []).filter((s) => s.serviceId);
        setServices(rows);
        if (rows[0]) setServiceId(rows[0].serviceId);
      } catch { /* list stays empty; runner falls back to a generic label */ }
    })();
  }, []);

  // Contract value follows the selected listing: real price when the service
  // is priced like a contract (≥ $1), otherwise a $25 floor (micropayment
  // listings aren't meaningful contract sizes).
  useEffect(() => {
    const svc = services.find((s) => s.serviceId === serviceId);
    if (!svc) return;
    const price = Number(svc.unitPrice);
    setAmount(Number.isFinite(price) && price >= 1 ? String(price) : '25');
  }, [serviceId, services]);

  const selectedService = services.find((s) => s.serviceId === serviceId);

  // Reveal timeline steps one-by-one so the video shows the journey happening.
  useEffect(() => {
    if (!run || revealed >= run.steps.length) return;
    const t = setTimeout(() => setRevealed((n) => n + 1), 900);
    return () => clearTimeout(t);
  }, [run, revealed]);

  const runDemo = async () => {
    const cents = Math.round(Number(amount) * 100);
    if (!(cents > 0)) return toast.error('Enter a contract amount in USDC');
    setRunning(true);
    setRun(null);
    setRevealed(0);
    try {
      const r = await developerApi.arbiterEngagementDemo(cents, serviceId || undefined);
      // Backend may prepend an 'approve USDC' step — map by name, not index.
      const byName = (prefix) => r.steps.find((s) => s.step.toLowerCase().startsWith(prefix));
      r.mapped = [
        byName('propose'), byName('accept'), byName('fund'),
        byName('deliver'), byName('approve →'),
      ];
      setRun(r);
      toast.success(`Contract settled — you were paid ${amount} USDC · reputation now ${r.reputation}`);
      load(true);
    } catch (err) {
      toast.error(err.message || 'Engagement failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="pb-12">
      <header className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold">Freelance &amp; B2B Contracts</h1>
          <p className="text-sm text-zinc-500 mt-1 max-w-3xl">
            A client hires you to build a website. No platform taking 20%, no "payment after invoice, maybe".
            Both parties sign the same terms on-chain, the client locks the money in escrow <em>before</em> you start,
            and when they approve your work the contract pays you instantly — and your on-chain reputation grows.
          </p>
        </div>
        <button type="button" onClick={() => load(true)} className="inline-flex items-center gap-2 border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-sm font-medium px-3.5 py-2.5 rounded-lg">
          <FiRefreshCw size={14} /> Refresh
        </button>
      </header>

      {/* The two parties */}
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] gap-3 items-stretch mb-6">
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">The client</p>
          <p className="text-sm font-semibold text-white">Website client</p>
          <p className="text-[10px] font-mono text-zinc-600 mt-0.5">{reputation?.buyer?.address || '0xD25F8736…'}</p>
          <p className="text-[11px] text-zinc-500 mt-2">Locks payment upfront. Approves delivery. Can&apos;t stiff you — can&apos;t reach the money once locked except to pay you.</p>
        </div>
        <div className="flex items-center justify-center">
          <span className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-[10px] font-semibold text-zinc-400 whitespace-nowrap">escrow between</span>
        </div>
        <div className="bg-zinc-900/60 border border-emerald-900/40 rounded-2xl p-4">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">You — the freelancer</p>
          <p className="text-sm font-semibold text-white">Independent developer</p>
          <p className="text-[10px] font-mono text-zinc-600 mt-0.5">{reputation?.provider?.address || '0x70997970…'}</p>
          <p className="text-[11px] text-zinc-500 mt-2">Starts work only after money is locked. Gets paid the moment approval lands. Reputation is portable — not owned by any platform.</p>
        </div>
      </div>

      {/* Reputation */}
      {reputation?.provider && (
        <div className="mb-6 inline-flex items-center gap-4 bg-zinc-900/60 border border-zinc-800 rounded-2xl px-5 py-3">
          <FiAward size={18} className="text-amber-400" />
          <div>
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Your on-chain reputation</p>
            <p className="text-lg font-bold font-mono text-emerald-400 leading-tight">
              {reputation.provider.engagementsCompleted} <span className="text-xs font-sans text-zinc-500 font-normal">completed contracts — permanent, verifiable by any future client</span>
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Live contract runner */}
        <div className="lg:col-span-3 bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
            <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
              <FiBriefcase size={14} className="text-cyan-400" /> Run a real contract — the website project
            </h2>
            <label className="flex items-center gap-2 text-xs text-zinc-500">
              Contract value (USDC)
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                inputMode="decimal"
                className="w-24 bg-zinc-950/60 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-right font-mono text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
              />
            </label>
          </div>
          <label className="block mb-3">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">The service being contracted — from your live marketplace; both parties sign THIS, hashed on-chain</span>
            <select
              value={serviceId}
              onChange={(e) => setServiceId(e.target.value)}
              className="mt-1 w-full bg-zinc-950/60 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
            >
              {services.length === 0 && <option value="">No marketplace services — publish one first</option>}
              {services.map((s) => (
                <option key={s.serviceId} value={s.serviceId}>
                  {s.title}{s.unitPrice != null ? ` · ${s.unitPrice} USDC` : ''}{s.provider?.name ? ` — by ${s.provider.name}` : ''}
                </option>
              ))}
            </select>
            {selectedService?.description && (
              <span className="mt-1 block text-[10px] text-zinc-600 truncate" title={selectedService.description}>{selectedService.description}</span>
            )}
          </label>
          <p className="text-[11px] text-zinc-500 mb-4">
            Every step below is a real transaction on Arbitrum Sepolia — this is not a simulation. Testnet USDC, real guarantees.
            {' '}Tip: top up the client wallet at <a href="https://faucet.circle.com" target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">faucet.circle.com</a> to run bigger contracts.
          </p>

          {/* The journey timeline */}
          <div className="relative pl-1">
            {STORY_STEPS.map((s, i) => {
              const done = run && i < revealed;
              const active = running && i === 0 && !run;
              return (
                <div key={s.title} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span className={`mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${
                      done ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                      : active ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300 animate-pulse'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-600'}`}>
                      {done ? <FiCheckCircle size={13} /> : s.icon}
                    </span>
                    {i < STORY_STEPS.length - 1 && <span className={`w-px flex-1 my-0.5 ${done ? 'bg-emerald-500/30' : 'bg-zinc-800'}`} />}
                  </div>
                  <div className={`pb-4 ${done ? '' : 'opacity-90'}`}>
                    <p className={`text-[13px] font-semibold ${done ? 'text-white' : 'text-zinc-400'}`}>
                      {i + 1}. {s.title}
                      {done && run?.mapped?.[i] && (
                        <a href={`https://sepolia.arbiscan.io/tx/${run.mapped[i].txHash}`} target="_blank" rel="noreferrer"
                          className="ml-2 font-mono text-[10px] font-normal text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1 align-middle">
                          {short(run.mapped[i].txHash)} <FiExternalLink size={8} />
                        </a>
                      )}
                    </p>
                    <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">{s.story}</p>
                    {done && run?.mapped?.[i]?.detail && <p className="text-[10px] font-mono text-zinc-600 mt-0.5">{run.mapped[i].detail}</p>}
                  </div>
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={runDemo}
            disabled={running}
            className="w-full bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl inline-flex items-center justify-center gap-2 text-sm transition-colors"
          >
            {running ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <FiPlay size={14} />}
            {running ? 'On-chain… sign, lock, deliver, get paid' : `Run the ${amount || '…'} USDC contract`}
          </button>

          {run && revealed >= run.steps.length && (
            <div className="mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3.5">
              <p className="text-xs font-semibold text-emerald-300 flex items-center gap-1.5">
                <FiShield size={12} /> Contract complete — you were paid {amount} USDC from escrow, zero chargeback risk.
              </p>
              <p className="text-[10px] text-zinc-500 mt-1">
                {run.service ? <span className="text-cyan-300/80">“{run.service}” · </span> : null}
                Engagement {run.engagementIdShort} · client wallet can never claw back approved funds · your reputation is now{' '}
                <span className="text-emerald-400 font-mono">{run.reputation}</span>, on-chain forever.
              </p>
            </div>
          )}
        </div>

        {/* On-chain record */}
        <div className="lg:col-span-2 bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2"><FiFileText size={13} className="text-violet-400" /> On-chain contract record</h2>
            <span className="text-[10px] text-zinc-600">{list?.count ?? 0} from contract events</span>
          </div>
          {loading && !list ? (
            <p className="text-xs text-zinc-600">Reading contract events…</p>
          ) : !list?.items?.length ? (
            <div className="py-8 text-center">
              <FiBriefcase size={22} className="text-zinc-700 mx-auto mb-2" />
              <p className="text-xs text-zinc-600">No contracts yet — run the website project to create the first one.</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[26rem] overflow-y-auto">
              {list.items.map((e) => (
                <div key={e.id} className="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-white">{e.usd} USDC contract</span>
                    <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase ${STATUS_STYLE[e.status] || STATUS_STYLE.CANCELLED}`}>{e.status}</span>
                  </div>
                  {e.service ? (
                    <p className="mt-1 text-[11px] text-cyan-300/90">📋 {e.service}</p>
                  ) : null}
                  <p className="mt-1 text-[10px] font-mono text-zinc-600 truncate" title={e.id}>{e.idShort}</p>
                  <div className="mt-1.5 grid grid-cols-2 gap-1 text-[10px]">
                    <span className="text-zinc-500">client <span className="font-mono text-zinc-400">{short(e.client)}</span></span>
                    <span className="text-zinc-500">provider <span className="font-mono text-zinc-400">{short(e.provider)}</span></span>
                  </div>
                  {e.amount && (
                    <p className="mt-1 text-[10px] text-zinc-500">
                      locked <span className="font-mono text-violet-300">{e.amount} USDC</span>
                      {e.chainlinkPrice ? <span className="text-zinc-600"> @ Chainlink {e.chainlinkPrice}</span> : null}
                    </p>
                  )}
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {[['proposed', e.proposedTx], ['accepted', e.acceptedTx], ['funded', e.fundedTx]].filter(([, h]) => h).map(([label, h]) => (
                      <a key={label} href={`https://sepolia.arbiscan.io/tx/${h}`} target="_blank" rel="noreferrer"
                        className="text-[10px] text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-0.5">
                        {label} <FiExternalLink size={7} />
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default EngagementsPanel;

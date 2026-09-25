import React from 'react';
import { FiArrowRight, FiCheckCircle, FiClock, FiLock, FiRefreshCw, FiShield, FiUnlock } from 'react-icons/fi';
import ErrorBanner from '../../components/dev/ErrorBanner';
import HeldDemoPanel from '../../components/dev/HeldDemoPanel';
import Skeleton from '../../components/dev/Skeleton';
import useApi from '../../hooks/useApi';
import developerApi from '../../utils/developerApi';

const DevX402 = () => {
  const { loading, error, refresh } = useApi({ fetcher: () => developerApi.x402Overview() });

  return (
    <div className="mx-auto max-w-[1100px] space-y-6 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-500/25 bg-cyan-500/10 text-cyan-300"><FiLock size={19} /></div>
            <div>
              <h1 className="text-2xl font-bold text-white">Held escrow</h1>
              <p className="mt-1 text-sm text-zinc-500">Pay for an AI service, read the result, then decide what happens to the money.</p>
            </div>
          </div>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-zinc-400">The buyer's USDC goes into the ArbiterManager contract instead of directly to the provider. The provider delivers immediately, while the funds remain held until approval, rejection, or automatic deadline resolution.</p>
        </div>
        <button type="button" onClick={() => refresh({ background: true })} className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3.5 py-2.5 text-sm font-medium text-zinc-300 hover:bg-zinc-800"><FiRefreshCw size={14} /> Refresh</button>
      </header>

      {error && !loading && <ErrorBanner message={error.message} onRetry={refresh} />}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4"><div className="flex items-center gap-2 text-cyan-300"><FiLock size={14} /><p className="text-xs font-semibold">1. Funds held</p></div><p className="mt-2 text-xs leading-relaxed text-zinc-500">USDC lands in the escrow contract, not the seller's wallet.</p></div>
        <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4"><div className="flex items-center gap-2 text-violet-300"><FiShield size={14} /><p className="text-xs font-semibold">2. Read the result</p></div><p className="mt-2 text-xs leading-relaxed text-zinc-500">The deliverable returns while your payment remains protected.</p></div>
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4"><div className="flex items-center gap-2 text-emerald-300"><FiCheckCircle size={14} /><p className="text-xs font-semibold">3. Decide</p></div><p className="mt-2 text-xs leading-relaxed text-zinc-500">Approve payment, reject for a refund, or let the deadline resolve it.</p></div>
      </div>

      {loading && !error ? <Skeleton className="h-48 rounded-2xl" /> : <HeldDemoPanel />}

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center gap-2"><FiClock size={15} className="text-amber-400" /><h2 className="text-sm font-semibold text-white">How resolution works</h2></div>
        <div className="mt-4 grid gap-2 text-xs sm:grid-cols-4">
          <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2.5 text-zinc-300"><span className="font-mono text-cyan-400">402</span><span>Payment required</span></div>
          <FiArrowRight className="hidden self-center text-zinc-700 sm:block" />
          <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2.5 text-zinc-300"><FiLock className="text-cyan-400" /><span>HELD → DELIVERED</span></div>
          <FiArrowRight className="hidden self-center text-zinc-700 sm:block" />
          <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2.5 text-zinc-300"><FiUnlock className="text-emerald-400" /><span>Approve / Reject / Auto-resolve</span></div>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-zinc-500">Approval pays the provider. Rejection refunds the buyer before the deadline. After the deadline, delivered work is paid and undelivered work is refunded, so silence cannot trap the funds.</p>
      </section>
    </div>
  );
};

export default DevX402;

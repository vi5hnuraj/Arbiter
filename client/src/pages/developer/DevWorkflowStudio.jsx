import React, { useEffect, useMemo, useState } from 'react';
import {
  FiCheckCircle, FiXCircle, FiAlertTriangle, FiShield, FiZap, FiEye,
  FiPlay, FiLock, FiFileText, FiExternalLink, FiClock, FiLoader, FiTerminal
} from 'react-icons/fi';
import Card from '../../components/dev/Card';
import ErrorBanner from '../../components/dev/ErrorBanner';
import developerApi from '../../utils/developerApi';

/**
 * Arbiter Workflow Studio — the full thesis in one screen:
 *   ① COMPOSE (agent proposes) → ② REVIEW (human sees every call) →
 *   ③ DRY RUN (simulate, nothing touches the chain) →
 *   ④ EXECUTE (that exact workflow runs via Arbiter) → ⑤ PROVE (HCS + Arbiscan).
 *
 * Nothing is inferred at execution time: the reviewed steps are derived
 * deterministically from the session; execution re-derives the same calls.
 */

const EXPLORER = 'https://sepolia.arbiscan.io';

const STEP_META = {
  approve: { title: 'USDC.approve', desc: 'Allow escrow to pull the approved amount' },
  settleToken: { title: 'settleInvoiceToken', desc: 'Hold USDC in escrow for the provider' },
  releaseToken: { title: 'releaseToken', desc: 'Release escrowed USDC to the provider' },
  settle: { title: 'settleInvoice', desc: 'Hold native ETH in escrow' },
  release: { title: 'release', desc: 'Release escrowed ETH to the provider' }
};

const StagePill = ({ n, label, state }) => {
  const cls =
    state === 'done' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
    : state === 'active' ? 'border-violet-500/50 bg-violet-500/10 text-violet-200 animate-pulse'
    : state === 'failed' ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
    : 'border-zinc-800 bg-zinc-900/40 text-zinc-500';
  return (
    <div className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ${cls}`}>
      <span className="font-mono text-[10px] opacity-70">{n}</span>{label}
    </div>
  );
};

const shortHash = (h) => (h ? `${String(h).slice(0, 10)}…${String(h).slice(-6)}` : '—');

export default function DevWorkflowStudio() {
  const [agents, setAgents] = useState([]);
  const [services, setServices] = useState([]);
  const [consumerAgentId, setConsumerAgentId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [quantity, setQuantity] = useState('1');

  const [workflow, setWorkflow] = useState(null);       // ①② compose result
  const [dryRun, setDryRun] = useState(null);           // ③
  const [chaos, setChaos] = useState(null);             // ③ chaos
  const [execution, setExecution] = useState(null);     // ④
  const [proof, setProof] = useState(null);             // ⑤

  const [busy, setBusy] = useState(null);               // which stage is running
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const [a, m] = await Promise.all([
          developerApi.agents({ limit: 50 }),
          developerApi.marketplace({ perPage: 50 })
        ]);
        const agentRows = (a?.agents || a || []).filter?.((x) => x.agentId || x.agent_id) || [];
        // Marketplace listing = live services only (is_active filtered server-side).
        // These are OTHER orgs' purchasable services — the right buy-side source.
        const svcRows = (m?.services || []).filter?.((x) => x.serviceId) || [];
        setAgents(agentRows);
        setServices(svcRows);
        if (agentRows[0]) setConsumerAgentId(agentRows[0].agentId || agentRows[0].agent_id);
        if (svcRows[0]) setServiceId(svcRows[0].serviceId);
      } catch (err) {
        setError(`Could not load agents/services: ${err.message}`);
      }
    })();
  }, []);

  // Exclude the selected consumer agent's own services (self-purchase is blocked
  // server-side; keep the dropdown consistent with that rule).
  const purchasable = useMemo(
    () => services.filter((s) => s.provider?.agentId !== consumerAgentId),
    [services, consumerAgentId]
  );

  useEffect(() => {
    if (purchasable.length && !purchasable.some((s) => s.serviceId === serviceId)) {
      setServiceId(purchasable[0].serviceId);
    }
  }, [purchasable, serviceId]);

  const stageState = useMemo(() => ({
    compose: workflow ? 'done' : 'idle',
    review: workflow ? 'done' : 'idle',
    dryrun: dryRun ? (dryRun.allClear ? 'done' : 'failed') : 'idle',
    chaos: chaos ? (chaos.keeperHubRefused ? 'done' : 'failed') : 'idle',
    execute: execution ? (execution.success ? 'done' : 'failed') : 'idle',
    prove: proof ? (proof.verified ? 'done' : 'idle') : 'idle'
  }), [workflow, dryRun, chaos, execution, proof]);

  const run = async (stage, fn) => {
    setBusy(stage);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(`${err.message || 'Request failed'} (stage: ${stage})`);
    } finally {
      setBusy(null);
    }
  };

  // ① COMPOSE — agent proposes the workflow
  const compose = () => run('compose', async () => {
    setWorkflow(null); setDryRun(null); setChaos(null); setExecution(null); setProof(null);
    const res = await developerApi.studioCompose({ consumerAgentId, serviceId, quantity });
    setWorkflow(res.workflow);
    setNotice(res.message);
  });

  // ③ DRY RUN — simulate, nothing touches the chain
  const dryRunNow = () => run('dryrun', async () => {
    const res = await developerApi.studioDryRun(workflow.sessionId);
    setDryRun(res);
    setNotice(res.message);
  });

  // ③b CHAOS — tampered workflow must be refused
  const chaosNow = () => run('chaos', async () => {
    const res = await developerApi.studioChaos(workflow.sessionId);
    setChaos(res);
    setNotice(res.message);
  });

  // ④ EXECUTE — the exact reviewed workflow, via Arbiter
  const executeNow = () => run('execute', async () => {
    const res = await developerApi.studioExecute(workflow.sessionId);
    setExecution(res);
    setNotice(res.message);
  });

  // ⑤ PROVE — public evidence
  const proveNow = () => run('prove', async () => {
    const res = await developerApi.studioProve(workflow.sessionId);
    setProof(res);
    setNotice(res.message);
  });

  const agentName = (id) => agents.find((a) => (a.agentId || a.agent_id) === id)?.name
    || agents.find((a) => (a.agentId || a.agent_id) === id)?.agent_name || id;

  return (
    <div className="space-y-6">
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">Arbiter Workflow Studio</h1>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[11px] text-cyan-300"><FiZap size={12} /> Settled via Arbiter</span>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          The agent composes a workflow, <em>you review every call</em>, dry-run it without touching the chain,
          and that exact workflow executes through Arbiter on Arbitrum Sepolia — then proves itself on a second
          public ledger. Nothing is inferred at execution time.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <StagePill n="01" label="Compose" state={stageState.compose} />
          <StagePill n="02" label="Review" state={stageState.review} />
          <StagePill n="03" label="Dry run" state={stageState.dryrun} />
          <StagePill n="03·b" label="Chaos probe" state={stageState.chaos} />
          <StagePill n="04" label="Execute" state={stageState.execute} />
          <StagePill n="05" label="Prove" state={stageState.prove} />
        </div>
      </header>

      {error && <ErrorBanner message={error} />}
      {notice && !error && (
        <div className="flex items-center gap-2 rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-3 text-sm text-cyan-200">
          <FiTerminal size={14} /> {notice}
        </div>
      )}

      {/* ① COMPOSE */}
      <Card title="① Compose — the agent proposes a workflow" subtitle="Trust Engine and your procurement policy gate this like any autonomous purchase.">
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-zinc-500">Consumer agent</span>
            <select value={consumerAgentId} onChange={(e) => setConsumerAgentId(e.target.value)} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-violet-500">
              {agents.map((a) => { const id = a.agentId || a.agent_id; return <option key={id} value={id}>{a.name || a.agent_name || id}</option>; })}
            </select>
          </label>
          <label className="block sm:col-span-2">
            <span className="text-[10px] uppercase tracking-widest text-zinc-500">Service to purchase (live marketplace)</span>
            <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-violet-500">
              {purchasable.length === 0 && <option value="">No purchasable services</option>}
              {purchasable.map((s) => (
                <option key={s.serviceId} value={s.serviceId}>
                  {s.title || s.serviceId}{s.unitPrice != null ? ` · ${s.unitPrice}` : ''}{s.provider?.name ? ` — by ${s.provider.name}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-zinc-500">Quantity</span>
            <input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-violet-500" />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button onClick={compose} disabled={busy || !consumerAgentId || !serviceId} className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50">
            {busy === 'compose' ? <FiLoader className="animate-spin" /> : <FiPlay />} {workflow ? 'Re-compose workflow' : 'Compose workflow'}
          </button>
          {workflow && <span className="font-mono text-xs text-zinc-500">session {workflow.sessionId}</span>}
        </div>
      </Card>

      {/* ② REVIEW */}
      {workflow && (
        <Card title="② Review — exactly what will run" subtitle={`Asset: ${workflow.asset} · Amount: ${workflow.amountHuman} ${workflow.asset} · Chain: ${workflow.chainId} · Rail: arbiter`}>
          <div className="space-y-2">
            {workflow.steps.map((s, i) => (
              <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">#{i + 1}</span>
                    <FiEye size={13} className="text-violet-400" />
                    <span className="font-mono text-sm font-semibold text-white">{s.label}</span>
                  </div>
                  <span className="font-mono text-[11px] text-zinc-500">{s.contractAddress}</span>
                </div>
                <p className="mt-1.5 text-xs text-zinc-400">{s.summary}</p>
                <div className="mt-2 rounded-lg bg-black/60 p-2 font-mono text-[11px] leading-relaxed text-zinc-400">
                  <span className="text-emerald-400">{s.functionName}</span>(
                  {Array.isArray(s.args) && s.args.map((a, j) => (
                    <span key={j} className="text-cyan-300">{j > 0 ? ', ' : ''}{String(a).length > 42 ? `${String(a).slice(0, 10)}…${String(a).slice(-8)}` : String(a)}</span>
                  ))}
                  ) <span className="text-zinc-600">value: {s.valueEther}</span>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 flex items-center gap-1.5 text-[11px] text-zinc-500">
            <FiLock size={11} /> These descriptors are derived deterministically from session {workflow.sessionId}. Execution re-derives the same calls — the reviewed workflow IS the executed workflow.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={dryRunNow} disabled={!!busy} className="inline-flex items-center gap-2 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-sm font-semibold text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50">
              {busy === 'dryrun' ? <FiLoader className="animate-spin" /> : <FiShield />} Dry run (simulate, no chain)
            </button>
            <button onClick={chaosNow} disabled={!!busy} className="inline-flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-500/20 disabled:opacity-50">
              {busy === 'chaos' ? <FiLoader className="animate-spin" /> : <FiAlertTriangle />} Chaos: try a tampered workflow
            </button>
          </div>
        </Card>
      )}

      {/* ③ DRY RUN */}
      {dryRun && (
        <Card title="③ Dry run — Arbiter simulation" subtitle="wouldRevert + gas per step. Signed nothing, broadcast nothing.">
          <div className="space-y-2">
            {dryRun.steps.map((s, i) => (
              <div key={i} className={`rounded-lg border p-3 ${s.passed ? 'border-emerald-500/25 bg-emerald-500/5' : s.deferred ? 'border-amber-500/25 bg-amber-500/5' : 'border-rose-500/30 bg-rose-500/5'}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {s.passed ? <FiCheckCircle className="text-emerald-400" size={15} /> : s.deferred ? <FiClock className="text-amber-400" size={15} /> : <FiXCircle className="text-rose-400" size={15} />}
                    <span className="font-mono text-sm text-white">{s.label}</span>
                  </div>
                  <div className="flex items-center gap-4 font-mono text-[11px]">
                    <span className={s.passed ? 'text-emerald-300' : s.deferred ? 'text-amber-300' : 'text-rose-300'}>wouldRevert: {String(s.wouldRevert)}</span>
                    <span className="text-zinc-500">gas: {s.gasEstimate ?? '—'}</span>
                  </div>
                </div>
                {s.deferred && s.reason && <p className="mt-1.5 text-[11px] leading-relaxed text-amber-200/70">{s.reason}</p>}
              </div>
            ))}
          </div>
          <p className={`mt-3 text-sm ${dryRun.allClear ? 'text-emerald-300' : 'text-rose-300'}`}>
            {dryRun.allClear ? '✅ All steps simulate clean. Safe to execute — on the reviewed workflow only.' : '⚠️ A step would revert. Execution stays locked until the workflow is re-composed.'}
          </p>
          {dryRun.allClear && !execution && (
            <button onClick={executeNow} disabled={!!busy} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
              {busy === 'execute' ? <FiLoader className="animate-spin" /> : <FiZap />} Execute through Arbiter
            </button>
          )}
        </Card>
      )}

      {/* ③b CHAOS */}
      {chaos && (
        <Card title="Chaos probe — try to fool Arbiter" subtitle="The settle step altered after review — the inflated variant must be refused in simulation.">
          <div className={`rounded-xl border p-4 ${chaos.keeperHubRefused ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-rose-500/30 bg-rose-500/5'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-sm text-white">{chaos.tampered.label}</span>
              <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${chaos.keeperHubRefused ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>
                {chaos.keeperHubRefused ? <><FiShield size={13} /> REFUSED in simulation</> : <><FiAlertTriangle size={13} /> NOT REFUSED — investigate</>}
              </span>
            </div>
            <div className="mt-3 grid gap-2 font-mono text-[11px] sm:grid-cols-2">
              <div className="rounded-lg bg-black/50 p-2 text-zinc-400">reviewed amount: <span className="text-zinc-200">{chaos.tampered.reviewedAmountHuman || chaos.tampered.reviewedAmount}</span></div>
              <div className="rounded-lg bg-black/50 p-2 text-zinc-400">tampered amount: <span className="text-rose-300">{chaos.tampered.tamperedAmountHuman || chaos.tampered.tamperedAmount}</span></div>
            </div>
            {chaos.detail?.reason && <p className="mt-2 font-mono text-[11px] text-amber-300/80">{chaos.detail.reason.slice(0, 200)}</p>}
            <p className="mt-3 text-xs text-zinc-500">
              {chaos.keeperHubRefused
                ? 'Deterministic execution: the tampered variant never leaves simulation. What you reviewed is the only thing that can run.'
                : 'The tampered variant simulated clean — do not execute this session; inspect Arbiter policy.'}
            </p>
          </div>
        </Card>
      )}

      {/* ④ EXECUTE */}
      {execution && (
        <Card title="④ Executed — through Arbiter" subtitle={`Rail: ${execution.rail === 'keeperhub' ? 'keeperhub' : 'direct (Privy wallet)'} · Asset: ${execution.asset && execution.asset !== 'NATIVE' && execution.asset !== 'ETH' ? execution.asset : 'ETH (native)'}${execution.amountUnits ? ` · ${Number(execution.amountUnits) / 1e6} ${execution.asset}` : ''}`}>
          {execution.success ? (() => {
            const exec = execution.execution || {};
            const tokenName = execution.asset && execution.asset !== 'NATIVE' && execution.asset !== 'ETH' ? execution.asset : null;
            const rows = tokenName ? [
              [`${tokenName}.approve (allow escrow to spend)`, exec.approveTxHash || execution.approveTxHash],
              ['settleInvoiceToken (escrow hold)', exec.settleTxHash || execution.createTxHash],
              ['releaseToken (paid provider)', exec.releaseTxHash || execution.releaseTxHash]
            ] : [
              ['settleInvoice (ETH → escrow)', exec.settleTxHash || execution.createTxHash],
              ['release (paid provider)', exec.releaseTxHash || execution.releaseTxHash]
            ];
            return (
            <div className="space-y-2">
              {rows.filter(([, h]) => h).map(([label, h], i) => (
                <a key={i} href={`${EXPLORER}/tx/${h}`} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 hover:border-cyan-500/40">
                  <span className="text-sm text-zinc-300">{label}</span>
                  <span className="flex items-center gap-2 font-mono text-xs text-cyan-300">{shortHash(h)} <FiExternalLink size={12} /></span>
                </a>
              ))}
              <button onClick={proveNow} disabled={!!busy} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-violet-500/40 bg-violet-500/10 px-4 py-2 text-sm font-semibold text-violet-200 hover:bg-violet-500/20 disabled:opacity-50">
                {busy === 'prove' ? <FiLoader className="animate-spin" /> : <FiFileText />} Verify public proof (Hedera HCS)
              </button>
            </div>
            );
          })() : (
            <p className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-200">Execution failed: {execution.failureReason}. The dry-run gate above is what caught it before broadcast.</p>
          )}
        </Card>
      )}

      {/* ⑤ PROVE */}
      {proof && (
        <Card title="⑤ Prove — two public ledgers agree" subtitle={proof.hcsTopicId ? `HCS topic ${proof.hcsTopicId} · no trust in this server required` : 'Hedera proof layer not configured'}>
          {proof.anchors.length > 0 ? (
            <div className="space-y-2">
              {proof.anchors.map((a, i) => (
                <div key={i} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ${a.type === 'RELEASED' ? 'bg-emerald-500/15 text-emerald-300' : a.type === 'FAILED' ? 'bg-rose-500/15 text-rose-300' : 'bg-cyan-500/15 text-cyan-300'}`}>{a.type}</span>
                    <span className="font-mono text-[11px] text-zinc-500">seq {a.seq} · {new Date((Number(a.consensusTimestamp) || 0) * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC</span>
                  </div>
                  {a.explorerUrl && <a href={a.explorerUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 font-mono text-xs text-cyan-300 hover:underline">{shortHash(a.txHash)} <FiExternalLink size={11} /></a>}
                </div>
              ))}
              {proof.hashscanUrl && (
                <a href={proof.hashscanUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 pt-1 text-xs text-violet-300 hover:underline">
                  Open the full audit trail on HashScan <FiExternalLink size={11} />
                </a>
              )}
            </div>
          ) : (
            <p className="text-sm text-zinc-500">
              {proof.baseTxs.length > 0
                ? 'HCS anchors may take a few seconds to appear on the mirror node — re-run Verify shortly.'
                : 'No proof yet. Execute the workflow first.'}
            </p>
          )}
          {proof.baseTxs.length > 0 && (
            <div className="mt-3 border-t border-zinc-800 pt-3">
              <p className="mb-2 text-[10px] uppercase tracking-widest text-zinc-500">Arbitrum receipts</p>
              {proof.baseTxs.map((t, i) => (
                <a key={i} href={t.explorerUrl} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-lg px-1 py-1.5 hover:bg-zinc-900/60">
                  <span className="font-mono text-xs text-zinc-400">{t.invoiceId}</span>
                  <span className="flex items-center gap-1.5 font-mono text-xs text-cyan-300">{shortHash(t.txHash)} <FiExternalLink size={10} /></span>
                </a>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

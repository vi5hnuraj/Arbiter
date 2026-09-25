import { useEffect, useState } from "react";
import styles from "../style";
import { Link } from "react-router-dom";

// Live HCS audit topic — Arbiter settlement proofs (Arbitrum Sepolia rail)
const HCS_TOPIC = "0.0.10590142";
const MIRROR = `https://testnet.mirrornode.hedera.com/api/v1/topics/${HCS_TOPIC}/messages?limit=12&order=desc`;

const typeTone = {
  RELEASED: { label: "RELEASED", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400" },
  HELD: { label: "HELD", cls: "border-sky-500/40 bg-sky-500/10 text-sky-400" },
  DELIVERED: { label: "DELIVERED", cls: "border-violet-500/40 bg-violet-500/10 text-violet-300" },
  REFUNDED: { label: "REFUNDED", cls: "border-red-500/40 bg-red-500/10 text-red-400" },
  FAILED: { label: "FAILED", cls: "border-red-500/40 bg-red-500/10 text-red-400" },
};

const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");

// Each record carries its own explorer URL — label and link always tell the truth
// about which chain settled that event, even for legacy (pre-Arbitrum) history.
function txInfo(r) {
  const url = r.explorer || (r.tx ? `https://sepolia.arbiscan.io/tx/${r.tx}` : null);
  if (!url) return null;
  const isLegacy = url.includes("basescan.org");
  return {
    label: isLegacy ? "legacy · base sepolia tx" : "arbitrum sepolia tx",
    href: url,
  };
}

function useLiveLedger() {
  const [records, setRecords] = useState([]);
  const [live, setLive] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(MIRROR);
        const data = await res.json();
        const rows = (data.messages || []).map((m) => {
          try {
            const p = JSON.parse(atob(m.message));
            return {
              seq: m.sequence_number,
              type: p.type || "EVENT",
              session: p.sessionId || "",
              tx: p.txHash || null,
              explorer: p.explorerUrl || null,
              at: m.consensus_timestamp ? new Date(Number(m.consensus_timestamp.split(".")[0]) * 1000) : null,
            };
          } catch {
            return null;
          }
        }).filter(Boolean);
        if (alive) { setRecords(rows); setLive(true); }
      } catch {
        if (alive) setLive(false);
      }
    };
    load();
    const t = setInterval(load, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return { records, live };
}

const Hero = () => {
  const { records, live } = useLiveLedger();
  const counts = records.reduce(
    (acc, r) => { acc[r.type] = (acc[r.type] || 0) + 1; return acc; },
    {}
  );

  return (
    <section id="home" className={`relative ${styles.paddingY} overflow-hidden`}>
      {/* ambient starfield glow */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-[8%] top-[18%] h-[2px] w-[2px] rounded-full bg-white/60 blur-[1px]" />
        <div className="absolute left-[22%] top-[62%] h-[3px] w-[3px] rounded-full bg-white/40 blur-[1px]" />
        <div className="absolute right-[14%] top-[30%] h-[2px] w-[2px] rounded-full bg-white/50 blur-[1px]" />
        <div className="absolute right-[30%] bottom-[18%] h-[2px] w-[2px] rounded-full bg-white/30 blur-[1px]" />
      </div>

      <div className="grid items-start gap-10 lg:grid-cols-[1.05fr_0.95fr] xl:gap-16">
        {/* ── Left: headline ── */}
        <div className={`${styles.flexStart} flex-col xl:px-0 sm:px-16 px-6`}>
          <p className="mb-6 flex flex-wrap items-center gap-2 font-mono text-[12px] uppercase tracking-[0.18em] text-zinc-400">
            <span className={`inline-block h-2 w-2 rounded-full ${live ? "animate-pulse bg-red-500" : "bg-zinc-600"}`} />
            witness {live ? "live" : "offline"} · topic {HCS_TOPIC} · settled via arbiter
          </p>

          <h1 className="font-serif text-[44px] font-normal leading-[1.05] text-white sm:text-[64px] xl:text-[76px]">
            Agents that pay.
            <br className="hidden sm:block" /> Receipts nobody
            <br className="hidden sm:block" /> can erase.
          </h1>

          <p className="mt-7 max-w-[540px] text-[15px] leading-7 text-zinc-400">
            Ask an agent to move funds and it reinterprets what you meant — at the moment it matters
            most. Arbiter removes the guesswork: every purchase is decided on evidence, escrowed
            by the <span className="text-white">Arbiter contract</span>, executed exactly on Arbitrum Sepolia
            in USDC — and every step is anchored to a public ledger anyone can read.
          </p>

          <div className="mt-9 flex flex-wrap gap-4">
            <Link
              to="/developer/studio"
              className="rounded-xl bg-white px-6 py-3.5 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200"
            >
              See it actually happen
            </Link>
            <a
              href={`https://hashscan.io/testnet/topic/${HCS_TOPIC}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-xl border border-white/15 bg-white/5 px-6 py-3.5 text-sm font-semibold text-white transition hover:border-white/30 hover:bg-white/10"
            >
              Open the audit trail
            </a>
          </div>

          <div className="mt-12 grid max-w-[520px] grid-cols-3 divide-x divide-white/10 border-y border-white/10">
            <div className="px-1 py-5 pr-4">
              <p className="font-serif text-4xl text-red-500">{records.length || "—"}</p>
              <p className="mt-2 text-xs leading-5 text-zinc-500">settlement events on the public record, verifiable by anyone.</p>
            </div>
            <div className="px-4 py-5">
              <p className="font-serif text-4xl text-white">
                {(counts.RELEASED || 0) + (counts.REFUNDED || 0)}
              </p>
              <p className="mt-2 text-xs leading-5 text-zinc-500">purchases fully settled and released in USDC on Arbitrum Sepolia.</p>
            </div>
            <div className="px-4 py-5 pl-4">
              <p className="font-serif text-4xl text-emerald-400">{counts.FAILED || 0}</p>
              <p className="mt-2 text-xs leading-5 text-zinc-500">secrets, funds or receipts lost across every run. Fail-open, never fail-closed.</p>
            </div>
          </div>
        </div>

        {/* ── Right: browser-chrome live audit card ── */}
        <div className="relative px-6 sm:px-16 lg:px-0">
          <div className="relative rounded-2xl border border-white/10 bg-[#0A0D12]/90 shadow-[0_40px_120px_-20px_rgba(0,0,0,0.8)]">
            {/* window chrome */}
            <div className="flex items-center gap-3 border-b border-white/10 px-5 py-3.5">
              <span className="h-3 w-3 rounded-full bg-[#FF5F57]" />
              <span className="h-3 w-3 rounded-full bg-[#FEBC2E]" />
              <span className="h-3 w-3 rounded-full bg-[#28C840]" />
              <span className="ml-3 flex-1 truncate rounded-md border border-white/10 bg-black/40 px-3 py-1.5 font-mono text-[11px] text-zinc-400">
                🔒 arbiter.live/audit · topic {HCS_TOPIC}
              </span>
            </div>

            <div className="p-5 sm:p-6">
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                live · consensus topic {HCS_TOPIC}
              </p>
              <h3 className="mt-2 text-xl font-semibold text-white">Every settle, and every failure.</h3>
              <p className="mt-1.5 text-sm leading-6 text-zinc-400">
                Read from Hedera in your browser, then checked against the Arbitrum Sepolia payment that
                settled it. Sequence numbers are monotonic; nobody can rewrite them.
              </p>

              <div className="mt-5 flex flex-wrap items-center gap-2">
                <span className="rounded-md border border-white/10 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-zinc-300">
                  {records.length} records
                </span>
                {counts.HELD > 0 && (
                  <span className="rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-sky-400">
                    {counts.HELD} held
                  </span>
                )}
                {counts.RELEASED > 0 && (
                  <span className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-emerald-400">
                    {counts.RELEASED} released
                  </span>
                )}
                {counts.DELIVERED > 0 && (
                  <span className="rounded-md border border-violet-500/40 bg-violet-500/10 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-violet-300">
                    {counts.DELIVERED} delivered
                  </span>
                )}
                <span className="ml-auto rounded-md border border-white/10 px-3 py-1.5 text-xs font-medium text-zinc-200">auto</span>
              </div>

              <div className="mt-4 max-h-[380px] space-y-3 overflow-y-auto pr-1">
                {records.length === 0 && (
                  <div className="rounded-xl border border-white/10 bg-black/30 p-4 font-mono text-xs text-zinc-500">
                    {live ? "no records yet" : "connecting to hedera mirror node…"}
                  </div>
                )}
                {records.map((r) => {
                  const tone = typeTone[r.type] || { label: r.type, cls: "border-white/15 text-zinc-300" };
                  return (
                    <div key={r.seq} className="rounded-xl border border-white/10 bg-black/30 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${tone.cls}`}>{tone.label}</span>
                        <span className="font-mono text-xs text-zinc-300">{r.session || "event"}</span>
                        <span className="ml-auto font-mono text-[11px] text-zinc-500">
                          {r.at ? r.at.toISOString().replace("T", " ").slice(0, 19) : ""} UTC
                        </span>
                      </div>
                      {(() => {
                        const info = txInfo(r);
                        return info ? (
                          <>
                            <p className="mt-3 font-mono text-[11px] uppercase tracking-wider text-zinc-500">{info.label}</p>
                            <a
                              href={info.href}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-1 inline-block font-mono text-[13px] text-zinc-200 underline decoration-white/25 underline-offset-4 hover:text-white"
                            >
                              {short(r.tx)}
                            </a>
                          </>
                        ) : (
                          <>
                            <p className="mt-3 font-mono text-[11px] uppercase tracking-wider text-zinc-500">arbitrum sepolia tx</p>
                            <span className="mt-1 block font-mono text-[13px] text-zinc-600">—</span>
                          </>
                        );
                      })()}
                      <p className="mt-3 font-mono text-[11px] uppercase tracking-wider text-zinc-600">hcs seq {r.seq}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Hero;

import { useEffect, useState } from "react";

// Live HCS audit feed — same public topic the Hero witnesses.
// Reads Hedera's mirror node directly from the browser: no backend, no trust.
const HCS_TOPIC = "0.0.10590142";
const MIRROR = `https://testnet.mirrornode.hedera.com/api/v1/topics/${HCS_TOPIC}/messages?limit=8&order=desc`;
const HASHSCAN = `https://hashscan.io/testnet/topic/${HCS_TOPIC}`;

const typeTone = {
  RELEASED: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  HELD: "border-sky-500/40 bg-sky-500/10 text-sky-400",
  DELIVERED: "border-violet-500/40 bg-violet-500/10 text-violet-300",
  REFUNDED: "border-red-500/40 bg-red-500/10 text-red-400",
  FAILED: "border-red-500/40 bg-red-500/10 text-red-400",
};

const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");

// Label and link follow each record's own explorerUrl — legacy (pre-Arbitrum)
// records stay truthful instead of being mislabeled.
function txInfo(r) {
  const url = r.explorer || (r.tx ? `https://sepolia.arbiscan.io/tx/${r.tx}` : null);
  if (!url) return null;
  const isLegacy = url.includes("basescan.org");
  return { label: isLegacy ? "LEGACY · BASE SEPOLIA TX" : "ARBITRUM SEPOLIA TX", href: url };
}

export default function LiveAuditPanel() {
  const [records, setRecords] = useState([]);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(MIRROR);
        const data = await res.json();
        const rows = (data.messages || [])
          .map((m) => {
            try {
              const p = JSON.parse(atob(m.message));
              return {
                seq: m.sequence_number,
                type: p.type || "EVENT",
                session: p.sessionId || "",
                tx: p.txHash || null,
                explorer: p.explorerUrl || null,
                at: m.consensus_timestamp
                  ? new Date(Number(m.consensus_timestamp.split(".")[0]) * 1000)
                  : null,
              };
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        if (alive) {
          setRecords(rows);
          setLive(true);
        }
      } catch {
        if (alive) setLive(false);
      }
    };
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const counts = records.reduce(
    (acc, r) => ({ ...acc, [r.type]: (acc[r.type] || 0) + 1 }),
    {}
  );

  return (
    <div className="relative w-[100%] max-w-[560px] rounded-2xl border border-white/10 bg-gradient-to-b from-[#0b1220]/95 to-[#050a14]/95 shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
      {/* browser chrome */}
      <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        <div className="ml-3 flex flex-1 items-center gap-2 rounded-md bg-black/40 px-3 py-1.5 font-mono text-[11px] text-zinc-400">
          <span className="text-emerald-400">🔒</span> arbiter.live/audit ·
          topic {HCS_TOPIC}
        </div>
      </div>

      <div className="px-6 py-5">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-400">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              live ? "animate-pulse bg-red-500" : "bg-zinc-600"
            }`}
          />
          {live ? "live" : "offline"} · consensus topic {HCS_TOPIC}
        </p>

        <h3 className="mt-2 font-serif text-2xl text-white">
          Every settle, and every failure.
        </h3>

        <div className="mt-3 flex flex-wrap gap-2">
          <span className="rounded-md border border-white/15 bg-white/5 px-3 py-1 font-mono text-[11px] text-zinc-300">
            {records.length} RECORDS
          </span>
          {Object.entries(counts)
            .filter(([type]) => typeTone[type])
            .map(([type, n]) => (
              <span
                key={type}
                className={`rounded-md border px-3 py-1 font-mono text-[11px] ${
                  typeTone[type]
                }`}
              >
                {n} {type}
              </span>
            ))}
          <span className="ml-auto rounded-md border border-white/15 bg-white/5 px-3 py-1 font-mono text-[11px] text-zinc-400">
            auto
          </span>
        </div>

        <div className="mt-4 max-h-[280px] space-y-2 overflow-hidden">
          {records.slice(0, 4).map((r) => (
            <div
              key={r.seq}
              className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded border px-2 py-0.5 font-mono text-[10px] ${
                      typeTone[r.type] ||
                      "border-white/15 bg-white/5 text-zinc-300"
                    }`}
                  >
                    {r.type}
                  </span>
                  <span className="font-mono text-[11px] text-zinc-400">
                    {r.session || "—"}
                  </span>
                </div>
                <span className="font-mono text-[10px] text-zinc-500">
                  {r.at ? r.at.toISOString().slice(0, 16).replace("T", " ") : ""}{" "}
                  UTC
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between font-mono text-[11px]">
                <span className="text-zinc-500">
                  {(() => {
                    const info = txInfo(r);
                    if (!info) return <>TX —</>;
                    return (
                      <>
                        {info.label}{" "}
                        <a
                          className="text-sky-400 underline decoration-sky-400/30 underline-offset-2"
                          href={info.href}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {short(r.tx)}
                        </a>
                      </>
                    );
                  })()}
                </span>
                <span className="text-zinc-500">HCS SEQ {r.seq}</span>
              </div>
            </div>
          ))}
          {!records.length && (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-6 text-center font-mono text-[12px] text-zinc-500">
              {live ? "no records yet" : "connecting to mirror node…"}
            </div>
          )}
        </div>

        <a
          href={HASHSCAN}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-block font-mono text-[11px] text-sky-400 underline decoration-sky-400/30 underline-offset-4"
        >
          verify on hashscan.io →
        </a>
      </div>
    </div>
  );
}

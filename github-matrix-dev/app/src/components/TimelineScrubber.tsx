import { useState, useRef, useCallback, useEffect, useMemo } from "react";

// ─── Types ────────────────────────────────────────────────────────────

interface TimelineEvent {
  seq: number;
  op: string;
  target: string;
  date: Date;
  agent: string;
}

interface DensityBucket {
  normalized: number;
  count: number;
  op: string | null;
}

interface DragState {
  active: boolean;
  startX: number;
  startY: number;
  startSeq: number;
  precisionMode: boolean;
  precisionOriginX: number;
  precisionOriginSeq: number;
}

interface OpStyle {
  dot: string;
}

interface OpMeta {
  bg: string;
  text: string;
  dot: string;
}

// ─── Mock data — simulates variable-density edit history ──────────────
// In production this comes from the fold index: the op index gives you
// all DEF seqs, you bucket them across the track width.
// We simulate a realistic pattern: quiet periods, bursts, sparse edits.

function relativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr  = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr  / 24);
  const diffWk  = Math.floor(diffDay / 7);
  const diffMo  = Math.floor(diffDay / 30);
  const diffYr  = Math.floor(diffDay / 365);
  if (diffSec < 60)  return "just now";
  if (diffMin < 60)  return `${diffMin} minute${diffMin !== 1 ? "s" : ""} ago`;
  if (diffHr  < 24)  return `${diffHr} hour${diffHr !== 1 ? "s" : ""} ago`;
  if (diffDay < 7)   return `${diffDay} day${diffDay !== 1 ? "s" : ""} ago`;
  if (diffWk  < 5)   return `${diffWk} week${diffWk !== 1 ? "s" : ""} ago`;
  if (diffMo  < 12)  return `${diffMo} month${diffMo !== 1 ? "s" : ""} ago`;
  return `${diffYr} year${diffYr !== 1 ? "s" : ""} ago`;
}

function absoluteTime(date: Date): string {
  return date.toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function generateEvents(): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  let seq = 1;
  const agents = ["@maria", "@bob", "@alice", "@system"];
  const ops = ["INS","DEF","DEF","DEF","CON","CON","EVA","DEF","DEF","SYN","REC","DEF"];
  const targets = ["CASE-001","CASE-002","CASE-003","ATT-001","ATT-002","WIT-005","BIL-001"];

  const now = new Date();
  // Events span from ~6 weeks ago to ~10 minutes ago
  const startMs = now.getTime() - 42 * 24 * 60 * 60 * 1000; // 6 weeks ago
  const endMs   = now.getTime() - 10 * 60 * 1000;           // 10 min ago

  // Burst 1: big import ~6 weeks ago (dense, 40 events in 2 hours)
  for (let i = 0; i < 40; i++) {
    const t = new Date(startMs + i * 3 * 60 * 1000); // every 3 min
    events.push({ seq: seq++, op: i % 5 === 0 ? "INS" : "DEF",
      target: targets[i % targets.length], date: t, agent: "@system" });
  }
  // Quiet period — 2 weeks of nothing, then 6 sparse edits
  for (let i = 0; i < 6; i++) {
    const t = new Date(startMs + 14 * 24 * 60 * 60 * 1000 + i * 4 * 60 * 60 * 1000);
    events.push({ seq: seq++, op: "DEF",
      target: targets[i % targets.length], date: t, agent: agents[i % 3] });
  }
  // Burst 2: review session ~3 weeks ago
  for (let i = 0; i < 35; i++) {
    const t = new Date(startMs + 21 * 24 * 60 * 60 * 1000 + i * 5 * 60 * 1000);
    events.push({ seq: seq++, op: ops[i % ops.length],
      target: targets[i % targets.length], date: t, agent: agents[i % 3] });
  }
  // Sparse last week
  for (let i = 0; i < 10; i++) {
    const t = new Date(startMs + 35 * 24 * 60 * 60 * 1000 + i * 8 * 60 * 60 * 1000);
    events.push({ seq: seq++, op: i % 3 === 0 ? "CON" : "DEF",
      target: targets[i % targets.length], date: t, agent: agents[i % 3] });
  }
  // Final burst — last 2 days
  for (let i = 0; i < 20; i++) {
    const t = new Date(endMs - (20 - i) * 90 * 60 * 1000); // every 90 min
    events.push({ seq: seq++, op: ops[i % ops.length],
      target: targets[i % targets.length], date: t, agent: agents[i % 3] });
  }
  return events;
}

const EVENTS = generateEvents();
const TOTAL = EVENTS.length;

const OP_COLORS: Record<string, OpStyle> = {
  NUL: { dot: "#9ca3af" }, SIG: { dot: "#6b7eff" },
  INS: { dot: "#3b82f6" }, SEG: { dot: "#8b5cf6" },
  CON: { dot: "#10b981" }, SYN: { dot: "#f59e0b" },
  DEF: { dot: "#22c55e" }, EVA: { dot: "#f97316" },
  REC: { dot: "#a855f7" },
};

const OP_META: Record<string, OpMeta> = {
  NUL: { bg: "#e8e9ed", text: "#6b7280", dot: "#9ca3af" },
  SIG: { bg: "#f0f4ff", text: "#6b7eff", dot: "#6b7eff" },
  INS: { bg: "#eff6ff", text: "#2563eb", dot: "#3b82f6" },
  SEG: { bg: "#f5f3ff", text: "#7c3aed", dot: "#8b5cf6" },
  CON: { bg: "#ecfdf5", text: "#059669", dot: "#10b981" },
  SYN: { bg: "#fffbeb", text: "#d97706", dot: "#f59e0b" },
  DEF: { bg: "#f0fdf4", text: "#16a34a", dot: "#22c55e" },
  EVA: { bg: "#fff7ed", text: "#ea580c", dot: "#f97316" },
  REC: { bg: "#fdf4ff", text: "#9333ea", dot: "#a855f7" },
};

function OpBadge({ op }: { op: string }): JSX.Element {
  const c: OpMeta = OP_META[op] ?? OP_META["NUL"];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "1px 5px", borderRadius: 4,
      background: c.bg, color: c.text,
      fontSize: 9, fontFamily: "'JetBrains Mono', monospace",
      fontWeight: 700, border: `1px solid ${c.dot}33`,
      whiteSpace: "nowrap",
    }}>{op}</span>
  );
}

// ─── Compute density histogram ────────────────────────────────────────
// Buckets events into N bins, returns normalized heights 0-1.
// Works for 3 events or 10,000 — the bucket count adapts to track width.
function useDensityBuckets(events: TimelineEvent[], buckets: number): DensityBucket[] {
  return useMemo(() => {
    if (buckets <= 0 || events.length === 0) return [];
    const counts = new Array<number>(buckets).fill(0);
    const dominantOp = new Array<string | null>(buckets).fill(null);
    const opCounts: Record<string, number>[] = Array.from(
      { length: buckets },
      () => ({} as Record<string, number>),
    );

    for (const ev of events) {
      const b = Math.min(buckets - 1, Math.floor(((ev.seq - 1) / (TOTAL - 1)) * buckets));
      counts[b]++;
      opCounts[b][ev.op] = (opCounts[b][ev.op] ?? 0) + 1;
    }

    // Find dominant op per bucket
    for (let i = 0; i < buckets; i++) {
      let max = 0;
      let dom: string | null = null;
      for (const [op, n] of Object.entries(opCounts[i])) {
        if (n > max) { max = n; dom = op; }
      }
      dominantOp[i] = dom;
    }

    const maxCount = Math.max(1, ...counts);
    return counts.map((c, i): DensityBucket => ({
      normalized: c / maxCount,
      count: c,
      op: dominantOp[i],
    }));
  }, [events, buckets]);
}

// ─── Main component ───────────────────────────────────────────────────
export default function TimelineScrubber() {
  const [currentSeq, setCurrentSeq] = useState(TOTAL);
  const [hoveredSeq, setHoveredSeq] = useState<number | null>(null);

  // Sync currentSeq into a ref so onMouseMove never captures a stale value
  const currentSeqRef = useRef(currentSeq);
  useEffect(() => { currentSeqRef.current = currentSeq; }, [currentSeq]);

  // Drag state
  const dragState = useRef<DragState>({
    active: false,
    startX: 0,
    startY: 0,
    startSeq: 0,
    precisionMode: false,
    precisionOriginX: 0,
    precisionOriginSeq: 0,
  });
  const [isDragging, setIsDragging] = useState(false);
  const [isPrecision, setIsPrecision] = useState(false);

  const trackRef = useRef<HTMLDivElement | null>(null);
  const trackWidthRef = useRef(0);

  const isLive = currentSeq === TOTAL;

  // Adaptive bucket count: 1 bucket per 3px of track width, min 20
  const [trackWidth, setTrackWidth] = useState(200);
  useEffect(() => {
    if (!trackRef.current) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0].contentRect.width;
      setTrackWidth(w);
      trackWidthRef.current = w;
    });
    ro.observe(trackRef.current);
    return () => ro.disconnect();
  }, []);

  const bucketCount = Math.max(20, Math.floor(trackWidth / 3));
  const densityBuckets = useDensityBuckets(EVENTS, bucketCount);

  const seqToPercent = (seq: number) => ((seq - 1) / (TOTAL - 1)) * 100;
  const pctToSeq = (pct: number) => Math.round(1 + Math.max(0, Math.min(1, pct / 100)) * (TOTAL - 1));

  // ── Drag handlers ──────────────────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (!trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    const seq = pctToSeq(pct);
    setCurrentSeq(seq);

    dragState.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      startSeq: seq,
      precisionMode: false,
      precisionOriginX: e.clientX,
      precisionOriginSeq: seq,
    };
    setIsDragging(true);
    setIsPrecision(false);
  }, []);

  // Stable callback — reads currentSeq via ref to avoid stale closures
  const onMouseMove = useCallback((e: MouseEvent) => {
    if (!dragState.current.active || !trackRef.current) return;
    const ds = dragState.current;
    const rect = trackRef.current.getBoundingClientRect();
    const trackW = rect.width;

    // Pull-down detection: if user has dragged Y > 20px downward, enter precision
    const dy = e.clientY - ds.startY;
    if (!ds.precisionMode && dy > 20) {
      ds.precisionMode = true;
      ds.precisionOriginX = e.clientX;
      ds.precisionOriginSeq = currentSeqRef.current;
      setIsPrecision(true);
    }

    if (ds.precisionMode) {
      // Precision mode: each pixel = ~1/10th–1/20th of normal movement
      const pullDepth = Math.min(100, Math.max(20, dy));
      const slowFactor = 0.05 + 0.05 * (1 - (pullDepth - 20) / 80);
      const dx = e.clientX - ds.precisionOriginX;
      const seqsPerPx = (TOTAL - 1) / trackW;
      const delta = Math.round(dx * seqsPerPx * slowFactor);
      const newSeq = Math.max(1, Math.min(TOTAL, ds.precisionOriginSeq + delta));
      setCurrentSeq(newSeq);
    } else {
      // Normal mode: direct mapping
      const pct = ((e.clientX - rect.left) / trackW) * 100;
      setCurrentSeq(pctToSeq(pct));
    }
  }, []); // stable — accesses live state via refs only

  const onMouseUp = useCallback(() => {
    dragState.current.active = false;
    setIsDragging(false);
    setIsPrecision(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDragging, onMouseMove, onMouseUp]);

  // ── Hover (non-drag) ───────────────────────────────────────────────
  const onTrackMouseMove = (e: React.MouseEvent) => {
    if (isDragging || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setHoveredSeq(pctToSeq(pct));
  };

  const fillPct = seqToPercent(currentSeq);
  const hoverEv = hoveredSeq ? EVENTS.find(e => e.seq === hoveredSeq) ?? null : null;
  const currentEv = EVENTS.find(e => e.seq === currentSeq) ?? null;

  // ── Pull-down visual: drop cursor ghost ───────────────────────────
  const [mouseY, setMouseY] = useState(0);
  const [mouseX, setMouseX] = useState(0);
  useEffect(() => {
    const track = (e: MouseEvent) => { setMouseX(e.clientX); setMouseY(e.clientY); };
    window.addEventListener("mousemove", track);
    return () => window.removeEventListener("mousemove", track);
  }, []);

  return (
    <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif", background: "#f0f1f3", minHeight: "100vh", padding: 40 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=DM+Sans:wght@400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes livePulse {
          0%,100% { opacity: 1; } 50% { opacity: 0.4; }
        }
      `}</style>

      {/* Precision mode drop cursor */}
      {isPrecision && (
        <div style={{
          position: "fixed",
          left: mouseX,
          top: mouseY,
          transform: "translate(-50%, -50%)",
          pointerEvents: "none",
          zIndex: 9999,
          display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
        }}>
          <div style={{
            width: 2, height: 20,
            background: "#374151",
            opacity: 0.5,
          }} />
          <div style={{
            padding: "2px 6px", borderRadius: 4,
            background: "#111827", color: "white",
            fontSize: 9, fontFamily: "'JetBrains Mono', monospace",
          }}>
            ×slow
          </div>
        </div>
      )}

      {/* App chrome */}
      <div style={{
        background: "white", borderRadius: 10,
        border: "1px solid #e5e7eb",
        overflow: "visible",
        boxShadow: "0 4px 24px #00000012",
        maxWidth: 900,
      }}>

        {/* ── Top bar — 3-col grid ── */}
        <div style={{
          height: 58, background: "white",
          borderBottom: "1px solid #e9eaec",
          overflow: "visible",
          display: "grid",
          gridTemplateColumns: "1fr 33.333% 1fr",
          alignItems: "center",
          padding: "0 16px",
          userSelect: "none",
        }}>

          {/* Left: brand */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: "#111", letterSpacing: "-0.02em" }}>EO</span>
            <span style={{ fontSize: 13, color: "#9ca3af" }}>DB</span>
          </div>

          {/* ── CENTER: Scrubber ── */}
          <div
            style={{ position: "relative", display: "flex", flexDirection: "column",
              alignItems: "stretch", justifyContent: "center", width: "100%", height: "100%" }}
            onMouseLeave={() => !isDragging && setHoveredSeq(null)}
          >

            {/* Hover tooltip */}
            {hoverEv && !isDragging && (
              <div style={{
                position: "absolute",
                bottom: "calc(100% + 4px)",
                left: `${seqToPercent(hoveredSeq!)}%`,
                transform: "translateX(-50%)",
                background: "#111827", color: "white",
                borderRadius: 6, padding: "5px 9px",
                fontSize: 10, whiteSpace: "nowrap",
                pointerEvents: "none", zIndex: 50,
                boxShadow: "0 4px 12px #00000044",
                display: "flex", flexDirection: "column", gap: 2,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <OpBadge op={hoverEv.op} />
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "#d1d5db" }}>
                    {hoverEv.target}
                  </span>
                </div>
                <div style={{ fontSize: 9, color: "#6b7280" }}>
                  {absoluteTime(hoverEv.date)} · {hoverEv.agent}
                </div>
                <div style={{
                  position: "absolute", top: "100%", left: "50%",
                  transform: "translateX(-50%)",
                  width: 0, height: 0,
                  borderLeft: "4px solid transparent",
                  borderRight: "4px solid transparent",
                  borderTop: "4px solid #111827",
                }} />
              </div>
            )}

            {/* Precision mode indicator tooltip */}
            {isPrecision && (
              <div style={{
                position: "absolute",
                bottom: "calc(100% + 4px)",
                left: `${seqToPercent(currentSeq)}%`,
                transform: "translateX(-50%)",
                background: "#374151", color: "white",
                borderRadius: 6, padding: "4px 8px",
                fontSize: 9, whiteSpace: "nowrap",
                pointerEvents: "none", zIndex: 50,
                fontFamily: "'JetBrains Mono', monospace",
              }}>
                seq:{currentSeq} · precision
              </div>
            )}

            {/* ── Track ── */}
            <div
              ref={trackRef}
              onMouseDown={onMouseDown}
              onMouseMove={onTrackMouseMove}
              style={{
                width: "100%", height: 24,
                position: "relative",
                cursor: isDragging
                  ? (isPrecision ? "ew-resize" : "grabbing")
                  : "crosshair",
                display: "flex", alignItems: "center",
              }}
            >
              {/* Density histogram — adaptive marks */}
              {densityBuckets.map((bucket, i) => {
                if (bucket.count === 0) return null;
                const pct = (i / densityBuckets.length) * 100;
                const bucketPct = pct + 50 / densityBuckets.length;
                const isBeforeHead = bucketPct <= fillPct;
                const c: OpStyle = (bucket.op ? OP_COLORS[bucket.op] : null) ?? { dot: "#9ca3af" };

                // Height scales with density: min 2px, max 12px
                const h = Math.max(2, Math.round(bucket.normalized * 12));

                return (
                  <div
                    key={i}
                    style={{
                      position: "absolute",
                      left: `${bucketPct}%`,
                      bottom: "50%",
                      transform: "translateX(-50%)",
                      width: Math.max(1, Math.floor(trackWidth / densityBuckets.length) - 1),
                      height: h,
                      background: isBeforeHead
                        ? (isLive ? c.dot : "#6b7280")
                        : "#e5e7eb",
                      borderRadius: 1,
                      opacity: isBeforeHead ? (0.5 + bucket.normalized * 0.5) : 0.4,
                      transition: isDragging ? "none" : "background 0.08s",
                    }}
                  />
                );
              })}

              {/* Track baseline */}
              <div style={{
                position: "absolute", left: 0, right: 0, top: "50%",
                height: 1.5,
                background: "#e5e7eb",
                borderRadius: 99,
                transform: "translateY(-50%)",
              }} />

              {/* Fill line */}
              <div style={{
                position: "absolute", left: 0, top: "50%",
                width: `${fillPct}%`, height: 1.5,
                background: isLive
                  ? "linear-gradient(to right, #3b82f6 0%, #10b981 100%)"
                  : "#9ca3af",
                borderRadius: 99,
                transform: "translateY(-50%)",
                transition: isDragging ? "none" : "width 0.06s linear",
              }} />

              {/* Thumb */}
              <div style={{
                position: "absolute",
                left: `${fillPct}%`,
                top: "50%",
                transform: "translate(-50%, -50%)",
                width: isPrecision ? 10 : 12,
                height: isPrecision ? 10 : 12,
                borderRadius: "50%",
                background: isPrecision ? "#374151" : (isLive ? "#10b981" : "#374151"),
                border: "2px solid white",
                boxShadow: isPrecision
                  ? "0 0 0 3px #37415133, 0 1px 4px #00000033"
                  : "0 1px 4px #00000033",
                zIndex: 4,
                transition: isDragging ? "none" : "left 0.06s linear, background 0.2s",
              }} />
            </div>

            {/* Time chip — anchored at thumb position, slides with it */}
            {!isLive && currentEv && (
              <div style={{
                position: "absolute",
                top: "calc(50% + 9px)",
                left: `${seqToPercent(currentSeq)}%`,
                transform: "translateX(-50%)",
                pointerEvents: "none",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 0,
              }}>
                {/* Connecting tick from thumb */}
                <div style={{ width: 1, height: 4, background: "#d1d5db" }} />
                {/* Chip */}
                <div style={{
                  display: "flex", flexDirection: "column", alignItems: "center",
                  background: "#1e2939",
                  borderRadius: 5, padding: "4px 8px",
                  boxShadow: "0 2px 8px #00000022",
                  minWidth: 0, whiteSpace: "nowrap",
                }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700,
                    color: "#f1f5f9",
                    fontFamily: "'DM Sans', sans-serif",
                    letterSpacing: "-0.01em",
                  }}>
                    {relativeTime(currentEv.date)}
                  </span>
                  <span style={{
                    fontSize: 8, color: "#64748b",
                    fontFamily: "'JetBrains Mono', monospace",
                    marginTop: 1,
                  }}>
                    {absoluteTime(currentEv.date)}
                  </span>
                </div>
              </div>
            )}
            {/* Live label */}
            {isLive && (
              <div style={{
                position: "absolute", top: "calc(50% + 9px)",
                left: 0, right: 0,
                display: "flex", justifyContent: "center",
                pointerEvents: "none",
              }}>
                <span style={{
                  display: "flex", alignItems: "center", gap: 3,
                  fontSize: 9, color: "#059669", fontWeight: 600,
                  fontFamily: "'DM Sans', sans-serif",
                  animation: "livePulse 2s infinite",
                }}>
                  <span style={{ width: 4, height: 4, borderRadius: "50%", background: "#10b981", display: "inline-block" }} />
                  live · {TOTAL} events
                </span>
              </div>
            )}
          </div>

          {/* Right: live button + chrome */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
            {!isLive && (
              <button onClick={() => setCurrentSeq(TOTAL)} style={{
                padding: "3px 9px", borderRadius: 5,
                border: "1px solid #d1fae5", background: "#ecfdf5",
                color: "#059669", fontSize: 10, fontWeight: 600,
                cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
                outline: "none",
              }}>→ Live</button>
            )}
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#10b981" }} />
            <span style={{ fontSize: 11, color: "#374151" }}>Connected</span>
            <div style={{
              width: 24, height: 24, borderRadius: "50%",
              background: "#eff6ff", border: "1px solid #bfdbfe",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 10, fontWeight: 700, color: "#2563eb",
              fontFamily: "'JetBrains Mono', monospace",
            }}>A</div>
          </div>
        </div>

        {/* Content area */}
        <div style={{ display: "flex", height: 300 }}>
          {/* Sidebar */}
          <div style={{
            width: 160, borderRight: "1px solid #e9eaec",
            padding: "16px 12px",
            display: "flex", flexDirection: "column", gap: 4,
          }}>
            <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 600, letterSpacing: "0.08em", marginBottom: 8 }}>
              RECORDS
            </div>
            {(["cases", "attorneys", "witnesses"] as const).map((t, i) => (
              <div key={t} style={{
                padding: "5px 8px", borderRadius: 5,
                background: i === 0 ? "#eff6ff" : "transparent",
                color: i === 0 ? "#2563eb" : "#6b7280",
                fontSize: 12, fontWeight: i === 0 ? 600 : 400,
                cursor: "pointer",
                display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
                <span>{t}</span>
                {i === 0 && (
                  <span style={{
                    fontSize: 9, padding: "1px 5px", borderRadius: 3,
                    background: "#dbeafe", color: "#2563eb",
                    fontFamily: "'JetBrains Mono', monospace",
                  }}>10</span>
                )}
              </div>
            ))}
          </div>

          {/* Main */}
          <div style={{ flex: 1, padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{
              padding: "8px 12px",
              background: isLive ? "#ecfdf5" : isPrecision ? "#f0f4ff" : "#fffbeb",
              border: `1px solid ${isLive ? "#a7f3d0" : isPrecision ? "#c7d7ff" : "#fde68a"}`,
              borderRadius: 6, fontSize: 11,
              color: isLive ? "#059669" : isPrecision ? "#4f6eff" : "#d97706",
              fontFamily: "'DM Sans', sans-serif",
              display: "flex", alignItems: "center", gap: 8,
            }}>
              {isLive
                ? <><span>●</span> Live — {TOTAL} events</>
                : isPrecision
                ? <><span>⟷</span> Precision scrub · seq:{currentSeq} of {TOTAL} · pull up to resume</>
                : <><span>◷</span> seq:{currentSeq} of {TOTAL} · {currentEv ? absoluteTime(currentEv.date) : ""} · {TOTAL - currentSeq} events ahead</>
              }
            </div>

            <div style={{ border: "1px solid #e9eaec", borderRadius: 6, overflow: "hidden" }}>
              <div style={{
                display: "grid", gridTemplateColumns: "90px 1fr 100px",
                background: "#f8f9fa", borderBottom: "1px solid #e9eaec",
                padding: "6px 12px",
              }}>
                {["ID", "TARGET", "OP"].map(h => (
                  <span key={h} style={{ fontSize: 10, color: "#9ca3af", fontWeight: 600, letterSpacing: "0.06em" }}>{h}</span>
                ))}
              </div>
              {EVENTS
                .filter(e => e.op === "INS" && e.seq <= currentSeq)
                .slice(-5).reverse()
                .map((ev, i) => {
                  const lastEv = [...EVENTS].filter(e => e.target === ev.target && e.seq <= currentSeq).pop();
                  return (
                    <div key={ev.seq} style={{
                      display: "grid", gridTemplateColumns: "90px 1fr 100px",
                      padding: "7px 12px",
                      borderBottom: i < 4 ? "1px solid #f3f4f6" : "none",
                      alignItems: "center",
                    }}>
                      <span style={{ fontSize: 10, color: "#2563eb", fontFamily: "'JetBrains Mono', monospace" }}>
                        {ev.target}
                      </span>
                      <span style={{ fontSize: 11, color: "#374151" }}>{ev.target} record</span>
                      {lastEv && <OpBadge op={lastEv.op} />}
                    </div>
                  );
                })
              }
            </div>

            {/* Density hint */}
            <div style={{
              marginTop: "auto",
              fontSize: 10, color: "#d1d5db",
              fontFamily: "'JetBrains Mono', monospace",
              display: "flex", justifyContent: "space-between",
            }}>
              <span>seq:1</span>
              <span style={{ color: "#9ca3af" }}>
                {densityBuckets.length} density buckets · {TOTAL} total events
              </span>
              <span>seq:{TOTAL}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Instructions */}
      <div style={{ marginTop: 14, fontSize: 11, color: "#9ca3af", fontFamily: "'DM Sans', sans-serif", lineHeight: 1.6 }}>
        <strong style={{ color: "#6b7280" }}>Drag</strong> to scrub · <strong style={{ color: "#6b7280" }}>Pull down while dragging</strong> for precision (×slow) ·
        Density marks scale to actual edit volume · Taller = more edits in that window
      </div>
    </div>
  );
}

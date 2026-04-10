import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import type { EoEvent, EoState, GraphEdge } from '../db/types';
import {
  type QueryLanguage,
  detectLanguage,
  getTargetSuggestions,
  getQuerySuggestions,
  executeQuery,
} from './query-engine';
import { Modal } from './Modal';
import { HolonSelector, expandHolonSelection } from './HolonSelector';

const NODE_COLORS = ['#4ade80', '#38bdf8', '#a78bfa', '#34d399', '#fb923c', '#f472b6'];
const SOFT_NODE_WARNING = 500;
const LANG_ORDER: QueryLanguage[] = ['target', 'sql', 'eo'];
const LANG_LABELS: Record<string, string> = { target: 'Search', sql: 'SQL', eo: 'EO Path' };
const LANG_PLACEHOLDERS: Record<string, string> = {
  target: 'Search targets by name or path...',
  sql: 'SELECT * FROM tableName WHERE ...',
  eo: 'app.tableName[field=value]',
};

type LabelMode = 'all' | 'greedy' | 'hubs' | 'off';
type CollisionMode = 'circle' | 'label' | 'strict';

interface Edge { source: string; dest: string }
interface NodePos { x: number; y: number }
interface NodeBox { w: number; h: number }

/* ── Dynamic canvas sizing ────────────────────────────────────── */

function computeCanvasSize(nodeIds: string[], maxRadius: number, spacingMult: number): { w: number; h: number } {
  const n = nodeIds.length;
  if (n === 0) return { w: 800, h: 560 };
  let totalChars = 0;
  for (const id of nodeIds) {
    const label = id.split('.').pop() ?? id;
    totalChars += label.length;
  }
  const avgLabelChars = totalChars / n;
  const labelPx = avgLabelChars * 4.5 + 8; // ~7px mono font
  const slot = Math.max(labelPx, 2 * maxRadius + 14) * spacingMult;
  const side = Math.ceil(Math.sqrt(n)) * slot * 1.35;
  return { w: Math.max(800, side), h: Math.max(560, side * 0.72) };
}

/* ── Minimal force-directed layout ────────────────────────────── */

interface ForceNode { id: string; x: number; y: number; vx: number; vy: number }

function forceLayout(
  nodeIds: string[],
  edges: Edge[],
  width: number,
  height: number,
  iterations = 500,
  repulsionMult = 1.0,
  attractionMult = 1.0,
  nodeRadii?: Record<string, number>,
  nodeBoxes?: Record<string, NodeBox>,
  collisionMode: CollisionMode = 'label',
): Record<string, NodePos> {
  const n = nodeIds.length;
  if (n === 0) return {};

  // Initialize nodes in a spread-out pattern (not a tight circle)
  const nodes: ForceNode[] = nodeIds.map((id, i) => {
    const angle = (i / n) * Math.PI * 2;
    const r = Math.min(width, height) * 0.3;
    return {
      id,
      x: width / 2 + Math.cos(angle) * r + (Math.random() - 0.5) * 40,
      y: height / 2 + Math.sin(angle) * r + (Math.random() - 0.5) * 40,
      vx: 0,
      vy: 0,
    };
  });

  const idxMap = new Map<string, number>();
  nodes.forEach((nd, i) => idxMap.set(nd.id, i));

  const edgeIdx = edges
    .map((e) => [idxMap.get(e.source), idxMap.get(e.dest)] as const)
    .filter(([a, b]) => a !== undefined && b !== undefined) as [number, number][];

  // Build adjacency for connected-component aware repulsion
  const idealDist = Math.max(60, Math.sqrt((width * height) / Math.max(n, 1)) * 1.2);
  const springLen = idealDist * 0.8;

  const strictMult = collisionMode === 'strict' ? 1.25 : 1.0;

  // Resolve node overlap once per call; supports circle AABB or label-aware AABB.
  const resolveCollisions = () => {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;

        if (collisionMode === 'circle' || !nodeBoxes) {
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
          const ri = nodeRadii?.[nodes[i].id] ?? 6;
          const rj = nodeRadii?.[nodes[j].id] ?? 6;
          const minDist = (ri + rj) * 1.8 * strictMult;
          if (dist < minDist) {
            const overlap = (minDist - dist) / dist * 0.5;
            const fx = dx * overlap;
            const fy = dy * overlap;
            nodes[i].x -= fx;
            nodes[i].y -= fy;
            nodes[j].x += fx;
            nodes[j].y += fy;
          }
        } else {
          // Label-aware AABB separation. Resolve on the axis with less overlap.
          const bi = nodeBoxes[nodes[i].id] ?? { w: 16, h: 16 };
          const bj = nodeBoxes[nodes[j].id] ?? { w: 16, h: 16 };
          const minX = (bi.w / 2 + bj.w / 2) * 1.05 * strictMult;
          const minY = (bi.h / 2 + bj.h / 2) * 1.10 * strictMult;
          const overlapX = minX - Math.abs(dx);
          const overlapY = minY - Math.abs(dy);
          if (overlapX > 0 && overlapY > 0) {
            if (overlapX < overlapY) {
              const push = (overlapX / 2) * (dx < 0 ? -1 : 1);
              nodes[i].x -= push;
              nodes[j].x += push;
            } else {
              const push = (overlapY / 2) * (dy < 0 ? -1 : 1);
              nodes[i].y -= push;
              nodes[j].y += push;
            }
          }
        }
      }
    }
  };

  let stableTicks = 0;

  for (let iter = 0; iter < iterations; iter++) {
    const temp = 0.1 * (1 - iter / iterations); // cooling

    // Repulsion (all pairs – O(n²) fine for ≲500 nodes)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = nodes[j].x - nodes[i].x;
        let dy = nodes[j].y - nodes[i].y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (idealDist * idealDist) / dist * repulsionMult;
        const fx = (dx / dist) * force * temp;
        const fy = (dy / dist) * force * temp;
        nodes[i].vx -= fx;
        nodes[i].vy -= fy;
        nodes[j].vx += fx;
        nodes[j].vy += fy;
      }
    }

    // Attraction along edges
    for (const [si, di] of edgeIdx) {
      let dx = nodes[di].x - nodes[si].x;
      let dy = nodes[di].y - nodes[si].y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - springLen) * 0.4 * temp * attractionMult;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      nodes[si].vx += fx;
      nodes[si].vy += fy;
      nodes[di].vx -= fx;
      nodes[di].vy -= fy;
    }

    // Center gravity
    for (const nd of nodes) {
      nd.vx += (width / 2 - nd.x) * 0.01 * temp;
      nd.vy += (height / 2 - nd.y) * 0.01 * temp;
    }

    // Apply velocities with damping
    let totalDisp = 0;
    for (const nd of nodes) {
      const speed = Math.sqrt(nd.vx * nd.vx + nd.vy * nd.vy);
      const maxSpeed = idealDist * temp * 10;
      if (speed > maxSpeed) {
        nd.vx = (nd.vx / speed) * maxSpeed;
        nd.vy = (nd.vy / speed) * maxSpeed;
      }
      nd.x += nd.vx;
      nd.y += nd.vy;
      totalDisp += Math.abs(nd.vx) + Math.abs(nd.vy);
      nd.vx *= 0.9;
      nd.vy *= 0.9;
    }

    // Collision pass — runs AFTER velocity integration so it has the last word.
    // Double-pass during the final third for tight resolution.
    resolveCollisions();
    if (iter > iterations * 0.66) resolveCollisions();

    // Early termination once the system settles.
    if (totalDisp < 0.5) {
      stableTicks++;
      if (stableTicks >= 5) break;
    } else {
      stableTicks = 0;
    }
  }

  // Normalize positions into [padding, width-padding] x [padding, height-padding]
  const padding = 40;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const nd of nodes) {
    if (nd.x < minX) minX = nd.x;
    if (nd.x > maxX) maxX = nd.x;
    if (nd.y < minY) minY = nd.y;
    if (nd.y > maxY) maxY = nd.y;
  }
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const scale = Math.min((width - padding * 2) / rangeX, (height - padding * 2) / rangeY);

  const result: Record<string, NodePos> = {};
  for (const nd of nodes) {
    result[nd.id] = {
      x: (nd.x - minX) * scale + padding + ((width - padding * 2) - rangeX * scale) / 2,
      y: (nd.y - minY) * scale + padding + ((height - padding * 2) - rangeY * scale) / 2,
    };
  }
  return result;
}

/* ── Zoom/pan hook ────────────────────────────────────────────── */

function useZoomPan() {
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const isPanning = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const svgElRef = useRef<SVGSVGElement | null>(null);

  const svgCallbackRef = useCallback((node: SVGSVGElement | null) => {
    // Cleanup previous listeners
    const prev = svgElRef.current;
    if (prev) {
      prev.removeEventListener('wheel', onWheel);
      prev.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }
    svgElRef.current = node;
    if (!node) return;

    node.addEventListener('wheel', onWheel, { passive: false });
    node.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    node.style.cursor = 'grab';

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    e.stopPropagation();
    const svg = svgElRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    setTransform((t) => {
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newK = Math.min(Math.max(t.k * factor, 0.1), 10);
      return {
        k: newK,
        x: mx - (mx - t.x) * (newK / t.k),
        y: my - (my - t.y) * (newK / t.k),
      };
    });
  }

  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const target = e.target as SVGElement;
    if (target.tagName !== 'svg' && target.tagName !== 'line' && target.tagName !== 'path' && target.tagName !== 'rect') return;
    isPanning.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    const svg = svgElRef.current;
    if (svg) svg.style.cursor = 'grabbing';
  }

  function onMouseMove(e: MouseEvent) {
    if (!isPanning.current) return;
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    setTransform((t) => ({ ...t, x: t.x + dx, y: t.y + dy }));
  }

  function onMouseUp() {
    isPanning.current = false;
    const svg = svgElRef.current;
    if (svg) svg.style.cursor = 'grab';
  }

  const resetZoom = useCallback(() => setTransform({ x: 0, y: 0, k: 1 }), []);

  const zoomIn = useCallback(() => {
    setTransform((t) => {
      const newK = Math.min(t.k * 1.3, 10);
      // Zoom toward center (VW/2=400, VH/2=280)
      const cx = 400, cy = 280;
      return { k: newK, x: cx - (cx - t.x) * (newK / t.k), y: cy - (cy - t.y) * (newK / t.k) };
    });
  }, []);

  const zoomOut = useCallback(() => {
    setTransform((t) => {
      const newK = Math.max(t.k / 1.3, 0.1);
      const cx = 400, cy = 280;
      return { k: newK, x: cx - (cx - t.x) * (newK / t.k), y: cy - (cy - t.y) * (newK / t.k) };
    });
  }, []);

  return { transform, resetZoom, zoomIn, zoomOut, svgCallbackRef };
}

function extractEdgesFromEvents(events: EoEvent[]): Edge[] {
  const edgeList: Edge[] = [];
  events
    .filter((e) => e.op === 'CON')
    .forEach((e) => {
      const source = e.target.split('.').slice(0, 3).join('.');
      if (e.operand?.added) {
        (e.operand.added as string[]).forEach((dest) => {
          edgeList.push({ source, dest });
        });
      }
    });
  return edgeList;
}

interface GraphViewPrefs {
  repulsionMult: number;
  attractionMult: number;
  spacingMult: number;
  labelMode: LabelMode;
  collisionMode: CollisionMode;
}

const DEFAULT_PREFS: GraphViewPrefs = {
  repulsionMult: 1.0,
  attractionMult: 1.0,
  spacingMult: 1.0,
  labelMode: 'greedy',
  collisionMode: 'label',
};

const GRAPH_PREFS_KEY = 'eo-graph-view-prefs';

function loadGraphPrefs(): GraphViewPrefs {
  if (typeof localStorage === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(GRAPH_PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<GraphViewPrefs>;
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function GraphView({ allStates }: { allStates?: EoState[] }) {
  const { theme } = useTheme();
  const recentEvents = useEoStore((s) => s.recentEvents);
  const store = useEoStore((s) => s.store);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [modalNode, setModalNode] = useState<string | null>(null);
  const initialPrefs = useRef<GraphViewPrefs>(loadGraphPrefs());
  const [repulsionMult, setRepulsionMult] = useState(initialPrefs.current.repulsionMult);
  const [attractionMult, setAttractionMult] = useState(initialPrefs.current.attractionMult);
  const [spacingMult, setSpacingMult] = useState(initialPrefs.current.spacingMult);
  const [labelMode, setLabelMode] = useState<LabelMode>(initialPrefs.current.labelMode);
  const [collisionMode, setCollisionMode] = useState<CollisionMode>(initialPrefs.current.collisionMode);
  const s = styles(theme);

  // Persist view prefs to localStorage
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(
        GRAPH_PREFS_KEY,
        JSON.stringify({ repulsionMult, attractionMult, spacingMult, labelMode, collisionMode }),
      );
    } catch {
      /* ignore quota errors */
    }
  }, [repulsionMult, attractionMult, spacingMult, labelMode, collisionMode]);

  // Data source state
  const [dataSource, setDataSource] = useState<'recent' | 'full'>('recent');
  const [fullGraphEdges, setFullGraphEdges] = useState<Edge[]>([]);
  const [fullGraphLoading, setFullGraphLoading] = useState(false);

  // Query bar state
  const [query, setQuery] = useState('');
  const [lang, setLang] = useState<QueryLanguage>('target');
  const [queryTargets, setQueryTargets] = useState<Set<string> | null>(null);

  // Holon nav selection — tri-state tree in the node detail modal.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [selectionTargets, setSelectionTargets] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Auto-detect language from query content
  useEffect(() => {
    if (query.length > 2) {
      const detected = detectLanguage(query);
      if (detected !== 'target' && detected !== lang) {
        setLang(detected);
      }
    }
  }, [query, lang]);

  // Load full graph edges from IndexedDB
  useEffect(() => {
    if (dataSource !== 'full' || !store) return;
    let cancelled = false;
    setFullGraphLoading(true);

    store.iterator('graph:fwd:').then((entries) => {
      if (cancelled) return;
      const edges: Edge[] = entries.map(([, value]) => {
        const ge = value as GraphEdge;
        return { source: ge.source, dest: ge.dest };
      });
      setFullGraphEdges(edges);
      setFullGraphLoading(false);
    });

    return () => { cancelled = true; };
  }, [dataSource, store]);

  // Get suggestions
  const suggestions = useMemo(() => {
    if (!focused || !query.trim()) return [];
    const states = allStates || [];
    if (lang === 'target') {
      return getTargetSuggestions(query, states).map((s) => ({
        label: s.target,
        detail: s.name,
      }));
    }
    return getQuerySuggestions(query, lang, states).map((s) => ({
      label: s,
      detail: undefined as string | undefined,
    }));
  }, [query, lang, allStates, focused]);

  // Reset selection when suggestions change
  useEffect(() => setSelectedIdx(0), [suggestions]);

  // Scroll selected suggestion into view
  useEffect(() => {
    if (dropdownRef.current) {
      const item = dropdownRef.current.children[selectedIdx] as HTMLElement;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIdx]);

  // Execute query
  const handleExecute = useCallback(() => {
    if (!query.trim()) {
      setQueryTargets(null);
      setError(null);
      return;
    }

    const states = allStates || [];

    if (lang === 'target') {
      const matches = getTargetSuggestions(query, states);
      if (matches.length === 0) {
        setError('No matching targets');
        return;
      }
      setError(null);
      setQueryTargets(new Set(matches.map((m) => m.target)));
      setFocused(false);
      return;
    }

    const result = executeQuery(query, lang, states);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.records.length === 0) {
      setError('No matching records');
      return;
    }
    setError(null);
    setQueryTargets(new Set(result.records.map((r) => r.target)));
    setFocused(false);
  }, [query, lang, allStates]);

  const handleClear = useCallback(() => {
    setQuery('');
    setQueryTargets(null);
    setError(null);
    inputRef.current?.focus();
  }, []);

  const handleSelectSuggestion = useCallback((value: string) => {
    if (lang === 'target') {
      setQuery(value);
      // Auto-execute for target search
      const states = allStates || [];
      const matches = getTargetSuggestions(value, states);
      if (matches.length > 0) {
        setQueryTargets(new Set(matches.map((m) => m.target)));
      }
      setFocused(false);
    } else {
      setQuery(value);
      setSelectedIdx(0);
    }
  }, [lang, allStates]);

  function handleKeyDown(e: React.KeyboardEvent) {
    const len = suggestions.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => (i + 1) % Math.max(len, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => (i - 1 + Math.max(len, 1)) % Math.max(len, 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (lang === 'target' && suggestions[selectedIdx]) {
        handleSelectSuggestion(suggestions[selectedIdx].label);
      } else {
        handleExecute();
      }
    } else if (e.key === 'Tab' && suggestions[selectedIdx]) {
      e.preventDefault();
      setQuery(suggestions[selectedIdx].label);
    } else if (e.key === 'Escape') {
      setFocused(false);
      inputRef.current?.blur();
    }
  }

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const toolbar = document.getElementById('graph-query-toolbar');
      if (toolbar && !toolbar.contains(e.target as Node)) {
        setFocused(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Compute all edges (unfiltered) from selected data source
  const allEdges = useMemo(() => {
    return dataSource === 'full'
      ? fullGraphEdges
      : extractEdgesFromEvents(recentEvents);
  }, [dataSource, recentEvents, fullGraphEdges]);

  // Compute all nodes from unfiltered edges
  const allNodesSet = useMemo(() => {
    const set = new Set<string>();
    allEdges.forEach((e) => { set.add(e.source); set.add(e.dest); });
    return set;
  }, [allEdges]);

  // Compose query filter AND holon selection filter (intersection semantics).
  const effectiveTargets = useMemo<Set<string> | null>(() => {
    if (!queryTargets && !selectionTargets) return null;
    if (!queryTargets) return selectionTargets;
    if (!selectionTargets) return queryTargets;
    const inter = new Set<string>();
    for (const t of queryTargets) if (selectionTargets.has(t)) inter.add(t);
    return inter;
  }, [queryTargets, selectionTargets]);

  // Apply combined filter
  const { nodes, edges } = useMemo(() => {
    const filtered = effectiveTargets
      ? allEdges.filter((e) => effectiveTargets.has(e.source) || effectiveTargets.has(e.dest))
      : allEdges;

    const nodesSet = new Set<string>();
    filtered.forEach((e) => { nodesSet.add(e.source); nodesSet.add(e.dest); });

    return {
      nodes: Array.from(nodesSet),
      edges: filtered,
    };
  }, [allEdges, effectiveTargets]);

  // Precompute node metadata for modal + layout
  const nodeInfo = useMemo(() => {
    const info: Record<string, {
      degree: number;
      inEdges: Edge[];
      outEdges: Edge[];
      role: 'hub' | 'bridge' | 'normal';
      color: string;
    }> = {};
    for (let idx = 0; idx < nodes.length; idx++) {
      const n = nodes[idx];
      const inEdges = edges.filter(e => e.dest === n);
      const outEdges = edges.filter(e => e.source === n);
      const degree = inEdges.length + outEdges.length;
      const connCollections = new Set<string>();
      outEdges.forEach(e => {
        const ep = e.dest.split('.');
        if (ep.length >= 2) connCollections.add(ep.slice(0, 2).join('.'));
      });
      inEdges.forEach(e => {
        const ep = e.source.split('.');
        if (ep.length >= 2) connCollections.add(ep.slice(0, 2).join('.'));
      });
      const isHub = degree >= 6;
      const isBridge = connCollections.size >= 2;
      const role = isHub ? 'hub' as const : isBridge ? 'bridge' as const : 'normal' as const;
      const c = NODE_COLORS[idx % NODE_COLORS.length];
      const color = isHub ? '#a855f7' : isBridge ? '#eab308' : c;
      info[n] = { degree, inEdges, outEdges, role, color };
    }
    return info;
  }, [nodes, edges]);

  const nodeRadii = useMemo(() => {
    const radii: Record<string, number> = {};
    const baseR = 6;
    for (const n of nodes) {
      const degree = nodeInfo[n]?.degree ?? 0;
      radii[n] = baseR + Math.min(degree, 6);
    }
    return radii;
  }, [nodes, nodeInfo]);

  const toggleHighlight = useCallback((name: string) => {
    setHighlighted((h) => (h === name ? null : name));
  }, []);

  // SVG ref for zoom/pan
  const { transform, resetZoom, zoomIn, zoomOut, svgCallbackRef } = useZoomPan();

  // Node bounding boxes (used for label-aware collision + greedy label layout)
  const nodeBoxes = useMemo(() => {
    const boxes: Record<string, NodeBox> = {};
    for (const id of nodes) {
      const label = id.split('.').pop() || id;
      const r = nodeRadii[id] ?? 6;
      boxes[id] = {
        w: Math.max(2 * r, label.length * 4.5 + 6),
        h: 2 * r + 9 + 4,
      };
    }
    return boxes;
  }, [nodes, nodeRadii]);

  // Dynamic canvas sizing: scales with node count and spacing preference.
  const { w: VW, h: VH } = useMemo(
    () => computeCanvasSize(nodes, 12, spacingMult),
    [nodes, spacingMult],
  );

  // Layout: force-directed
  const positions = useMemo(() => {
    return forceLayout(nodes, edges, VW, VH, 500, repulsionMult, attractionMult, nodeRadii, nodeBoxes, collisionMode);
  }, [nodes, edges, repulsionMult, attractionMult, nodeRadii, nodeBoxes, collisionMode, VW, VH]);

  // Greedy label placement: which nodes should render their label?
  const visibleLabels = useMemo(() => {
    const visible = new Set<string>();
    if (labelMode === 'off') return visible;
    if (labelMode === 'all') {
      for (const id of nodes) visible.add(id);
      return visible;
    }
    if (labelMode === 'hubs') {
      for (const id of nodes) {
        if (nodeInfo[id]?.role === 'hub') visible.add(id);
      }
      return visible;
    }
    // 'greedy' — place labels in descending-degree order; drop collisions.
    const sorted = [...nodes].sort(
      (a, b) => (nodeInfo[b]?.degree ?? 0) - (nodeInfo[a]?.degree ?? 0),
    );
    const placed: { cx: number; cy: number; w: number; h: number }[] = [];
    for (const id of sorted) {
      const p = positions[id];
      const box = nodeBoxes[id];
      if (!p || !box) continue;
      const r = nodeRadii[id] ?? 6;
      // Label sits below the node center; approximate its centroid.
      const cy = p.y + r + 10;
      const lw = box.w;
      const lh = 10;
      let collides = false;
      for (const q of placed) {
        if (
          Math.abs(p.x - q.cx) < (lw + q.w) / 2 &&
          Math.abs(cy - q.cy) < (lh + q.h) / 2
        ) {
          collides = true;
          break;
        }
      }
      if (!collides) {
        placed.push({ cx: p.x, cy, w: lw, h: lh });
        visible.add(id);
      }
    }
    return visible;
  }, [labelMode, nodes, nodeInfo, positions, nodeBoxes, nodeRadii]);

  // Status line
  const isFiltered = effectiveTargets !== null;
  const totalNodes = allNodesSet.size;
  const totalEdges = allEdges.length;
  const statusText = isFiltered
    ? `${nodes.length} of ${totalNodes} nodes · ${edges.length} of ${totalEdges} edges (filtered)`
    : `${nodes.length} nodes · ${edges.length} edges`;
  const showCappedWarning = nodes.length >= SOFT_NODE_WARNING;

  const showDropdown = focused && suggestions.length > 0;

  return (
    <div style={s.container}>
      {/* Sidebar: node list */}
      <aside style={s.sidebar}>
        <div style={s.sidebarTitle}>Nodes ({nodes.length})</div>
        {nodes.map((n, i) => {
          const label = n.split('.').pop() || n;
          const isActive = highlighted === n;
          return (
            <button
              key={n}
              onClick={() => setModalNode(n)}
              onMouseEnter={() => setHighlighted(n)}
              onMouseLeave={() => setHighlighted(null)}
              style={{
                ...s.nodeItem,
                background: isActive ? theme.bgActive : 'transparent',
              }}
            >
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: NODE_COLORS[i % NODE_COLORS.length], flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{label}</span>
            </button>
          );
        })}
        <div style={{ ...s.sidebarTitle, marginTop: 16 }}>Edges ({edges.length})</div>
        {edges.slice(0, 20).map((e, i) => (
          <div key={i} style={s.edgeItem}>
            <span style={{ color: theme.accent }}>{e.source.split('.').pop()}</span>
            <span style={{ color: theme.textMuted }}>&rarr;</span>
            <span style={{ color: theme.accent }}>{e.dest.split('.').pop()}</span>
          </div>
        ))}
        {edges.length > 20 && <div style={{ ...s.edgeItem, color: theme.textMuted }}>...+{edges.length - 20} more</div>}
      </aside>

      {/* Right panel: toolbar + graph */}
      <div style={s.rightPanel}>
        {/* Toolbar */}
        <div style={s.toolbar} id="graph-query-toolbar">
          {/* Data source toggle */}
          <div style={s.toolbarRow}>
            <div style={s.sourceToggle}>
              <button
                onClick={() => setDataSource('recent')}
                style={dataSource === 'recent' ? s.sourceBtnActive : s.sourceBtn}
              >
                Recent
              </button>
              <button
                onClick={() => setDataSource('full')}
                style={dataSource === 'full' ? s.sourceBtnActive : s.sourceBtn}
              >
                Full Graph
              </button>
            </div>

            {/* Physics controls */}
            <div style={s.physicsControls}>
              <label style={s.sliderLabel}>
                Repulsion
                <input
                  type="range"
                  min={0.1} max={3.0} step={0.1}
                  value={repulsionMult}
                  onChange={(e) => setRepulsionMult(parseFloat(e.target.value))}
                  style={s.slider}
                />
                <span style={s.sliderValue}>{repulsionMult.toFixed(1)}x</span>
              </label>
              <label style={s.sliderLabel}>
                Attraction
                <input
                  type="range"
                  min={0.1} max={3.0} step={0.1}
                  value={attractionMult}
                  onChange={(e) => setAttractionMult(parseFloat(e.target.value))}
                  style={s.slider}
                />
                <span style={s.sliderValue}>{attractionMult.toFixed(1)}x</span>
              </label>
              <label style={s.sliderLabel}>
                Spacing
                <input
                  type="range"
                  min={0.5} max={3.0} step={0.1}
                  value={spacingMult}
                  onChange={(e) => setSpacingMult(parseFloat(e.target.value))}
                  style={s.slider}
                />
                <span style={s.sliderValue}>{spacingMult.toFixed(1)}x</span>
              </label>
            </div>
          </div>

          {/* Label + collision controls */}
          <div style={s.toolbarRow}>
            <div style={s.segmentGroup} title="How labels are drawn. Greedy hides collisions.">
              <span style={s.segmentLabel}>Labels</span>
              {(['all', 'greedy', 'hubs', 'off'] as LabelMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setLabelMode(m)}
                  style={labelMode === m ? s.segmentBtnActive : s.segmentBtn}
                >
                  {m}
                </button>
              ))}
            </div>
            <div style={s.segmentGroup} title="How node overlap is prevented during layout.">
              <span style={s.segmentLabel}>Collision</span>
              {(['circle', 'label', 'strict'] as CollisionMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setCollisionMode(m)}
                  style={collisionMode === m ? s.segmentBtnActive : s.segmentBtn}
                >
                  {m}
                </button>
              ))}
            </div>
            {(
              repulsionMult !== DEFAULT_PREFS.repulsionMult ||
              attractionMult !== DEFAULT_PREFS.attractionMult ||
              spacingMult !== DEFAULT_PREFS.spacingMult ||
              labelMode !== DEFAULT_PREFS.labelMode ||
              collisionMode !== DEFAULT_PREFS.collisionMode
            ) && (
              <button
                onClick={() => {
                  setRepulsionMult(DEFAULT_PREFS.repulsionMult);
                  setAttractionMult(DEFAULT_PREFS.attractionMult);
                  setSpacingMult(DEFAULT_PREFS.spacingMult);
                  setLabelMode(DEFAULT_PREFS.labelMode);
                  setCollisionMode(DEFAULT_PREFS.collisionMode);
                }}
                style={s.physicsResetBtn}
              >
                Reset view
              </button>
            )}
            {selectionTargets !== null && (
              <div style={s.selectionChip}>
                <span>
                  Holon selection · {selectionTargets.size} node{selectionTargets.size === 1 ? '' : 's'}
                </span>
                <button
                  onClick={() => {
                    setSelectionTargets(null);
                    setSelectedPaths(new Set());
                  }}
                  style={s.selectionChipClear}
                  aria-label="Clear holon selection"
                >
                  &times;
                </button>
              </div>
            )}
          </div>

          {/* Query bar */}
          <div style={s.querySection}>
            {/* Language tabs */}
            <div style={s.langSelector}>
              {LANG_ORDER.map((l) => (
                <button
                  key={l}
                  onClick={() => { setLang(l); setError(null); inputRef.current?.focus(); }}
                  style={{
                    ...s.langBtn,
                    ...(lang === l ? s.langBtnActive : {}),
                  }}
                >
                  {LANG_LABELS[l]}
                </button>
              ))}
            </div>

            {/* Input row */}
            <div style={s.inputWrap}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, opacity: 0.6 }}>
                <circle cx="6.5" cy="6.5" r="5" stroke={theme.textMuted} strokeWidth="1.5" />
                <path d="M10.5 10.5L14.5 14.5" stroke={theme.textMuted} strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setError(null); }}
                onFocus={() => setFocused(true)}
                onKeyDown={handleKeyDown}
                placeholder={LANG_PLACEHOLDERS[lang]}
                style={s.input}
                spellCheck={false}
                autoComplete="off"
              />
              {query && (
                <button onClick={handleClear} style={s.clearBtn}>&times;</button>
              )}
              {lang !== 'target' && (
                <button onClick={handleExecute} style={s.runBtn}>Run</button>
              )}
              {lang === 'target' && query && (
                <button onClick={handleExecute} style={s.runBtn}>Filter</button>
              )}
            </div>

            {/* Error */}
            {error && (
              <div style={s.errorRow}>{error}</div>
            )}

            {/* Suggestions dropdown */}
            {showDropdown && (
              <div style={s.dropdown} ref={dropdownRef}>
                {suggestions.map((item, i) => (
                  <div
                    key={i}
                    style={{
                      ...s.suggestion,
                      ...(i === selectedIdx ? s.suggestionActive : {}),
                    }}
                    onMouseEnter={() => setSelectedIdx(i)}
                    onMouseDown={(e) => { e.preventDefault(); handleSelectSuggestion(item.label); }}
                  >
                    <span style={s.suggestionLabel}>{item.label}</span>
                    {item.detail && <span style={s.suggestionDetail}>{item.detail}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Graph area */}
        <div style={s.graphArea}>
          {fullGraphLoading && dataSource === 'full' ? (
            <div style={s.empty}>
              <div style={{ fontSize: 12, color: theme.textMuted }}>Loading full graph...</div>
            </div>
          ) : nodes.length === 0 ? (
            <div style={s.empty}>
              <div style={{ fontSize: 14, color: theme.textSecondary, fontWeight: 300 }}>
                {isFiltered ? 'No edges match this query' : 'No graph data yet'}
              </div>
              <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6 }}>
                {isFiltered
                  ? 'Try a broader query or clear the filter to see all edges.'
                  : 'Use the Compose tab to create CON events, which link targets together as graph edges.'}
              </div>
            </div>
          ) : (
            <>
              <svg
                ref={svgCallbackRef}
                viewBox={`0 0 ${VW} ${VH}`}
                style={{ width: '100%', height: '100%', userSelect: 'none' }}
              >
                <defs>
                  <marker id="arrow" viewBox="0 0 10 10" refX="18" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#a78bfa" fillOpacity="0.6" />
                  </marker>
                </defs>

                {/* Zoomable/pannable group */}
                <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
                  {/* Edges */}
                  {edges.map((e, i) => {
                    const sp = positions[e.source];
                    const dp = positions[e.dest];
                    if (!sp || !dp) return null;
                    const connected = !highlighted || e.source === highlighted || e.dest === highlighted;
                    return (
                      <line
                        key={i}
                        x1={sp.x} y1={sp.y}
                        x2={dp.x} y2={dp.y}
                        stroke="#a78bfa"
                        strokeWidth={connected && highlighted ? 1.5 : 0.8}
                        strokeOpacity={highlighted ? (connected ? 0.7 : 0.06) : 0.35}
                        markerEnd="url(#arrow)"
                      />
                    );
                  })}

                  {/* Nodes — sized by degree, colored by role */}
                  {nodes.map((n) => {
                    const p = positions[n];
                    const info = nodeInfo[n];
                    if (!info) return null;
                    const label = n.split('.').pop() || n;
                    const isSelected = n === highlighted;
                    const opacity = highlighted ? (isSelected ? 1 : 0.25) : 1;
                    const r = isSelected ? 9 : nodeRadii[n] || 6;
                    const roleColor = info.color;

                    const showLabel = visibleLabels.has(n) || isSelected || n === highlighted;
                    return (
                      <g
                        key={n}
                        onClick={() => setModalNode(n)}
                        onMouseEnter={() => setHighlighted(n)}
                        onMouseLeave={() => setHighlighted(null)}
                        style={{ cursor: 'pointer' }}
                      >
                        <circle
                          cx={p.x} cy={p.y} r={r}
                          fill={roleColor}
                          fillOpacity={opacity * 0.25}
                          stroke={roleColor}
                          strokeWidth={isSelected ? 2 : 1}
                          strokeOpacity={opacity}
                        />
                        {/* Label — offset below node. Hidden by label-mode unless selected/hovered. */}
                        {showLabel && (
                          <text
                            x={p.x} y={p.y + r + 10}
                            textAnchor="middle"
                            fill={roleColor}
                            fontFamily="JetBrains Mono, monospace"
                            fontSize={isSelected ? 9 : 7}
                            fontWeight={isSelected ? '700' : '500'}
                            fillOpacity={opacity * 0.9}
                          >
                            {label}
                          </text>
                        )}
                        {/* Role badge for hubs — follows the same label-visibility rule. */}
                        {info.role === 'hub' && showLabel && (
                          <text
                            x={p.x} y={p.y - r - 3}
                            textAnchor="middle"
                            fill={roleColor}
                            fontFamily="JetBrains Mono, monospace"
                            fontSize={5}
                            fontWeight="700"
                            fillOpacity={opacity * 0.6}
                          >
                            HUB
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>

                {/* Status text — fixed position, not affected by zoom */}
                <text
                  x={VW / 2} y={VH - 8}
                  textAnchor="middle"
                  fill={theme.textMuted}
                  fontFamily="JetBrains Mono, monospace"
                  fontSize={9}
                  fillOpacity={0.7}
                >
                  {statusText}
                  {showCappedWarning ? ` (dense graph — consider filtering)` : ''}
                  {' · scroll to zoom · drag to pan'}
                </text>
              </svg>

              {/* Zoom controls */}
              <div style={s.zoomControls}>
                <button onClick={zoomOut} style={s.zoomBtn} title="Zoom out">-</button>
                <button onClick={zoomIn} style={s.zoomBtn} title="Zoom in">+</button>
                {(transform.k !== 1 || transform.x !== 0 || transform.y !== 0) && (
                  <button onClick={resetZoom} style={s.zoomBtn} title="Reset view">
                    Reset
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Node detail modal */}
      <Modal
        open={modalNode !== null}
        onClose={() => setModalNode(null)}
        title={modalNode ? (modalNode.split('.').pop() || modalNode) : ''}
        width={820}
      >
        {modalNode && nodeInfo[modalNode] && (() => {
          const info = nodeInfo[modalNode];
          const navRoot = modalNode.split('.').slice(0, -1).join('.') || modalNode;
          const allNodesArr = Array.from(allNodesSet);
          return (
            <div style={{ display: 'flex', gap: 16, fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
              {/* Left: node details */}
              <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                <div style={s.modalRow}>
                  <span style={{ color: theme.textMuted }}>Target </span>
                  <span style={{ color: theme.text }}>{modalNode}</span>
                </div>
                <div style={s.modalRow}>
                  <span style={{ color: theme.textMuted }}>Role </span>
                  <span style={{
                    color: info.role === 'hub' ? '#a855f7' : info.role === 'bridge' ? '#eab308' : theme.text,
                    fontWeight: 600,
                  }}>
                    {info.role.toUpperCase()}
                  </span>
                </div>
                <div style={{ ...s.modalRow, marginBottom: 14 }}>
                  <span style={{ color: theme.textMuted }}>Degree </span>
                  <span style={{ color: theme.text }}>{info.degree}</span>
                  <span style={{ color: theme.textMuted, marginLeft: 6 }}>
                    ({info.inEdges.length} in, {info.outEdges.length} out)
                  </span>
                </div>

                {info.outEdges.length > 0 && (
                  <>
                    <div style={s.modalSectionTitle}>Outgoing ({info.outEdges.length})</div>
                    {info.outEdges.map((e, i) => (
                      <button
                        key={`out-${i}`}
                        onClick={() => { setModalNode(null); setHighlighted(e.dest); }}
                        style={s.modalEdgeBtn}
                      >
                        <span style={{ color: info.color }}>{modalNode.split('.').pop()}</span>
                        <span style={{ color: theme.textMuted }}>&rarr;</span>
                        <span style={{ color: theme.accent }}>{e.dest.split('.').pop()}</span>
                      </button>
                    ))}
                  </>
                )}

                {info.inEdges.length > 0 && (
                  <>
                    <div style={{ ...s.modalSectionTitle, marginTop: info.outEdges.length > 0 ? 10 : 0 }}>
                      Incoming ({info.inEdges.length})
                    </div>
                    {info.inEdges.map((e, i) => (
                      <button
                        key={`in-${i}`}
                        onClick={() => { setModalNode(null); setHighlighted(e.source); }}
                        style={s.modalEdgeBtn}
                      >
                        <span style={{ color: theme.accent }}>{e.source.split('.').pop()}</span>
                        <span style={{ color: theme.textMuted }}>&rarr;</span>
                        <span style={{ color: info.color }}>{modalNode.split('.').pop()}</span>
                      </button>
                    ))}
                  </>
                )}

                {info.degree === 0 && (
                  <div style={{ color: theme.textMuted, fontStyle: 'italic', marginTop: 8 }}>
                    No connected edges
                  </div>
                )}
              </div>

              {/* Right: holon nav / multi-level selection */}
              <div style={{ flex: '0 0 320px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                <HolonSelector
                  rootScope={navRoot}
                  nodes={allNodesArr}
                  selectedPaths={selectedPaths}
                  onChange={setSelectedPaths}
                />
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => {
                      setSelectionTargets(null);
                      setSelectedPaths(new Set());
                    }}
                    style={s.physicsResetBtn}
                  >
                    Clear selection
                  </button>
                  <button
                    onClick={() => {
                      setSelectionTargets(expandHolonSelection(selectedPaths, allNodesArr));
                      setModalNode(null);
                    }}
                    disabled={selectedPaths.size === 0}
                    style={{
                      ...s.segmentBtnActive,
                      padding: '4px 12px',
                      borderRight: `1px solid ${theme.accent}`,
                      borderRadius: 3,
                      opacity: selectedPaths.size === 0 ? 0.4 : 1,
                    }}
                  >
                    Apply filter
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}

function styles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: { display: 'flex', flex: 1, overflow: 'hidden' },
    sidebar: {
      width: 220,
      borderRight: `1px solid ${t.border}`,
      background: t.bgCard,
      overflowY: 'auto',
      padding: '12px 0',
    },
    sidebarTitle: {
      padding: '4px 14px 8px',
      fontSize: 9,
      fontWeight: 700,
      fontFamily: "'JetBrains Mono', monospace",
      textTransform: 'uppercase' as const,
      letterSpacing: '0.08em',
      color: t.textMuted,
    },
    nodeItem: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      padding: '6px 14px',
      border: 'none',
      background: 'transparent',
      color: t.text,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      cursor: 'pointer',
      textAlign: 'left' as const,
    },
    edgeItem: {
      display: 'flex',
      gap: 6,
      padding: '3px 14px',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
    },
    rightPanel: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column' as const,
      overflow: 'hidden',
    },
    toolbar: {
      background: t.bgCard,
      borderBottom: `1px solid ${t.border}`,
      position: 'relative' as const,
      zIndex: 50,
    },
    toolbarRow: {
      display: 'flex',
      alignItems: 'center',
      padding: '8px 12px 0',
      gap: 12,
    },
    sourceToggle: {
      display: 'flex',
      gap: 0,
      borderRadius: 4,
      overflow: 'hidden',
      border: `1px solid ${t.border}`,
    },
    sourceBtn: {
      padding: '4px 12px',
      fontSize: 9,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      letterSpacing: '0.04em',
      border: 'none',
      background: 'transparent',
      color: t.textMuted,
      cursor: 'pointer',
      textTransform: 'uppercase' as const,
    },
    sourceBtnActive: {
      padding: '4px 12px',
      fontSize: 9,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      letterSpacing: '0.04em',
      border: 'none',
      background: t.accent,
      color: '#fff',
      cursor: 'pointer',
      textTransform: 'uppercase' as const,
    },
    querySection: {
      position: 'relative' as const,
    },
    langSelector: {
      display: 'flex',
      gap: 0,
      padding: '6px 12px 0',
    },
    langBtn: {
      padding: '4px 10px',
      fontSize: 9,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      letterSpacing: '0.04em',
      border: 'none',
      borderBottom: '1.5px solid transparent',
      background: 'transparent',
      color: t.textMuted,
      cursor: 'pointer',
      textTransform: 'uppercase' as const,
      transition: 'color .15s, border-color .15s',
    },
    langBtnActive: {
      color: t.accent,
      borderBottomColor: t.accent,
    },
    inputWrap: {
      display: 'flex',
      alignItems: 'center',
      padding: '6px 12px 8px',
      gap: 6,
    },
    input: {
      flex: 1,
      border: 'none',
      outline: 'none',
      background: 'transparent',
      fontSize: 12,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.text,
      padding: '4px 0',
      minWidth: 0,
    },
    clearBtn: {
      background: 'none',
      border: 'none',
      color: t.textMuted,
      cursor: 'pointer',
      fontSize: 16,
      padding: '0 4px',
      lineHeight: 1,
      flexShrink: 0,
    },
    runBtn: {
      padding: '3px 10px',
      fontSize: 10,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.accent,
      color: '#fff',
      border: 'none',
      borderRadius: 3,
      cursor: 'pointer',
      flexShrink: 0,
    },
    errorRow: {
      padding: '6px 12px',
      fontSize: 11,
      color: t.dangerText,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.dangerBg,
      borderBottom: `1px solid ${t.dangerBorder}`,
    },
    dropdown: {
      position: 'absolute' as const,
      top: '100%',
      left: 0,
      right: 0,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderTop: 'none',
      borderRadius: '0 0 6px 6px',
      maxHeight: 260,
      overflowY: 'auto' as const,
      boxShadow: `0 8px 24px ${t.shadow}`,
      zIndex: 100,
    },
    suggestion: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 14px',
      cursor: 'pointer',
      fontSize: 11,
      borderBottom: `1px solid ${t.borderLight}`,
      transition: 'background .08s',
      fontFamily: "'JetBrains Mono', monospace",
    } as React.CSSProperties,
    suggestionActive: {
      background: t.bgHover,
    },
    suggestionLabel: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.textHeading,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    suggestionDetail: {
      fontSize: 11,
      color: t.textMuted,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
      flexShrink: 1,
      marginLeft: 10,
    },
    graphArea: {
      flex: 1,
      background: t.bg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 16,
      position: 'relative' as const,
    },
    zoomControls: {
      position: 'absolute' as const,
      bottom: 12,
      right: 16,
      display: 'flex',
      gap: 4,
    },
    zoomBtn: {
      padding: '4px 10px',
      fontSize: 10,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.bgCard,
      color: t.textMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      cursor: 'pointer',
      lineHeight: 1,
      minWidth: 28,
    },
    empty: {
      display: 'flex',
      flexDirection: 'column' as const,
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      flex: 1,
    },
    physicsControls: {
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      marginLeft: 16,
    },
    sliderLabel: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 9,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.04em',
      cursor: 'default',
    },
    slider: {
      width: 80,
      accentColor: t.accent,
      cursor: 'pointer',
    },
    sliderValue: {
      fontSize: 9,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.text,
      minWidth: 28,
    },
    physicsResetBtn: {
      padding: '2px 8px',
      fontSize: 9,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      background: 'transparent',
      color: t.textMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 3,
      cursor: 'pointer',
      textTransform: 'uppercase' as const,
      letterSpacing: '0.04em',
    },
    segmentGroup: {
      display: 'flex',
      alignItems: 'center',
      gap: 0,
      marginRight: 8,
    },
    segmentLabel: {
      fontSize: 9,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.04em',
      marginRight: 6,
    },
    segmentBtn: {
      padding: '3px 8px',
      fontSize: 9,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      letterSpacing: '0.04em',
      background: 'transparent',
      color: t.textMuted,
      border: `1px solid ${t.border}`,
      borderRight: 'none',
      cursor: 'pointer',
      textTransform: 'uppercase' as const,
    },
    segmentBtnActive: {
      padding: '3px 8px',
      fontSize: 9,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      letterSpacing: '0.04em',
      background: t.accent,
      color: '#fff',
      border: `1px solid ${t.accent}`,
      borderRight: 'none',
      cursor: 'pointer',
      textTransform: 'uppercase' as const,
    },
    selectionChip: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '3px 6px 3px 10px',
      marginLeft: 'auto',
      fontSize: 9,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      letterSpacing: '0.04em',
      textTransform: 'uppercase' as const,
      color: t.accent,
      background: t.bgHover,
      border: `1px solid ${t.accent}`,
      borderRadius: 999,
    },
    selectionChipClear: {
      background: 'none',
      border: 'none',
      color: t.accent,
      fontSize: 14,
      cursor: 'pointer',
      padding: '0 2px',
      lineHeight: 1,
    },
    modalRow: {
      marginBottom: 6,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    },
    modalSectionTitle: {
      fontSize: 10,
      fontWeight: 700,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.06em',
      marginBottom: 4,
    },
    modalEdgeBtn: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      width: '100%',
      padding: '5px 8px',
      border: 'none',
      background: 'transparent',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      cursor: 'pointer',
      borderRadius: 4,
      textAlign: 'left' as const,
      transition: 'background .08s',
    },
  };
}

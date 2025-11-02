import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** --- Typen --- */
type MindNode = {
  id: number;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  strokeColor: string;
  fillColor?: string;
  bold?: boolean;
};

type Link = {
  id: number;
  source: number;
  target: number;
  label?: string;
  dashed?: boolean;
};

type Snapshot = {
  nodes: MindNode[];
  edges: Link[];
  pan: { x: number; y: number };
  scale: number;
  selectedId: number | null;
  selectedIds: number[];
  selectedEdgeIds: number[];
};

/** --- Konstanten --- */
const STORAGE_KEY = "mindmap_v14"; // neue Version
const BASE_W = 120;
const BASE_H = 64;
const DRAG_THRESHOLD = 16;
const CHILD_RADIUS = 160;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** --- Utilities --- */
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const approxTextWidth = (text: string, fontSize: number) =>
  text.length * fontSize * 0.6;

function layoutLabel(label: string, baseFont: number, minW: number) {
  const maxLines = 3;
  const paddingX = 16;
  const paddingY = 12;
  const lineHeight = Math.round(baseFont * 1.15);

  const words = label.split(/\s+/).filter(Boolean);
  let lines: string[] = [];
  let width = Math.max(minW, BASE_W);

  const rebuild = () => {
    lines = [];
    let current = "";
    for (const w of (words.length ? words : [label])) {
      const test = current ? current + " " + w : w;
      if (approxTextWidth(test, baseFont) <= width - paddingX * 2) current = test;
      else {
        if (current) lines.push(current);
        current = w;
      }
    }
    if (current) lines.push(current);

    if (lines.length > maxLines) {
      const textLen = label.replace(/\s+/g, " ").trim().length || 1;
      const targetCharsPerLine = Math.ceil(textLen / maxLines);
      width = Math.max(
        width,
        Math.ceil(targetCharsPerLine * baseFont * 0.6 + paddingX * 2)
      );
      return false;
    }
    return true;
  };

  for (let i = 0; i < 6; i++) {
    if (rebuild()) break;
  }

  const textW = Math.max(...lines.map((t) => approxTextWidth(t, baseFont)), 0);
  width = Math.max(width, Math.ceil(textW + paddingX * 2));
  const height = Math.max(BASE_H, Math.ceil(lines.length * lineHeight + paddingY * 2));
  return {
    lines: lines.length ? lines : [""],
    width,
    height,
    lineHeight,
    paddingX,
    paddingY,
    fontSize: baseFont,
  };
}

function hexToRgba60(hex: string) {
  const m = hex.replace("#", "");
  const bigint = parseInt(m.length === 3 ? m.split("").map(c => c + c).join("") : m, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r},${g},${b},0.6)`;
}

function distPointToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const vx = x2 - x1, vy = y2 - y1;
  const wx = px - x1, wy = py - y1;
  const len2 = vx * vx + vy * vy || 1e-6;
  let t = (wx * vx + wy * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * vx, cy = y1 + t * vy;
  return Math.hypot(px - cx, py - cy);
}

const rectRadius = (n: MindNode) => Math.max(n.w, n.h) / 2;
const cloneSnapshot = (s: Snapshot): Snapshot => JSON.parse(JSON.stringify(s));

/** --- App --- */
export default function App() {
  /** State */
  const [nodes, setNodes] = useState<MindNode[]>([
    {
      id: 1,
      label: "Type to change Text",
      x: 0, // Weltursprung
      y: 0,
      w: BASE_W,
      h: BASE_H,
      strokeColor: "#333",
      fillColor: undefined,
      bold: false,
    },
  ]);
  const [edges, setEdges] = useState<Link[]>([]);

  const [selectedId, setSelectedId] = useState<number | null>(1);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set([1]));
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<Set<number>>(new Set());

  /** Pan & Zoom */
  const [pan, setPan] = useState(() => ({
    x: typeof window !== "undefined" ? window.innerWidth / 2 : 0,
    y: typeof window !== "undefined" ? window.innerHeight / 2 : 0,
  }));
  const [scale, setScale] = useState(1);

  /** Refs */
  // Merkt sich den aktuellen Pfad und die Position darin für Shift+Tab
// Pfad-Navigation für Shift+Tab
const shiftTabPathRef = useRef<number[] | null>(null); // [root, ..., leaf]
const shiftTabIndexRef = useRef<number>(0);            // aktueller Index im Pfad


  const svgRef = useRef<SVGSVGElement | null>(null);
  const draggingNodeId = useRef<number | null>(null);
  const dragOffset = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const somethingMoved = useRef<boolean>(false);

  const groupDragging = useRef(false);
  const groupStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const groupStartPositions = useRef<{ id: number; x: number; y: number }[]>([]);

  const panning = useRef(false);
  const panStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const panAtStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const activeTouches = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStart = useRef<{ d: number; scale: number; panX: number; panY: number; cx: number; cy: number } | null>(null);

  const [marquee, setMarquee] = useState<{ active: boolean; x1: number; y1: number; x2: number; y2: number }>({ active: false, x1: 0, y1: 0, x2: 0, y2: 0 });

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const editInputRef = useRef<HTMLInputElement | null>(null);

  const [linking, setLinking] = useState<{ phase: "idle" | "pending" | "active"; sourceId: number | null; x: number; y: number; startX: number; startY: number }>
  ({ phase: "idle", sourceId: null, x: 0, y: 0, startX: 0, startY: 0 });

  const freshTyping = useRef<boolean>(true);

  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);

  /** Kontextmenü (+ Klickposition in Weltkoordinaten) */
  const [contextMenu, setContextMenu] = useState<{
    open: boolean;
    x: number; y: number; // Bildschirmposition
    wx?: number; wy?: number; // Weltposition für „Neuer Knoten“
    kind: 'bg' | 'node' | 'edge';
    targetNodeId?: number;
    targetEdgeId?: number;
  }>({ open:false, x:0, y:0, kind:'bg' });

  /** Persistenz */
  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      if (Array.isArray(data?.nodes) && Array.isArray(data?.edges)) {
        const migrated: MindNode[] = data.nodes.map((n: any) => ({
          id: Number(n.id),
          label: String(n.label ?? ""),
          x: Number(n.x), y: Number(n.y),
          w: Number(n.w ?? BASE_W),
          h: Number(n.h ?? BASE_H),
          strokeColor: n.strokeColor ?? "#333",
          fillColor: n.fillColor,
          bold: Boolean(n.bold),
        }));
        const migratedEdges: Link[] = data.edges.map((e: any) => ({
          id: Number(e.id),
          source: Number(e.source),
          target: Number(e.target),
          label: e.label ? String(e.label) : undefined,
          dashed: Boolean(e.dashed),
        }));
        setNodes(migrated);
        setEdges(migratedEdges);
      }
    } catch {}
  }, []);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes, edges }));
  }, [nodes, edges]);

  /** Initial zentrieren – ohne Flash */
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    setPan({ x: rect.width / 2, y: rect.height / 2 });
    setScale(1);
  }, []);

  /** Helpers */
  function toWorld(clientX: number, clientY: number) {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return { x: (clientX - rect.left - pan.x) / scale, y: (clientY - rect.top - pan.y) / scale };
  }
  function toScreen(wx: number, wy: number) {
    return { x: pan.x + wx * scale, y: pan.y + wy * scale };
  }
  function bringBoxIntoView(cx: number, cy: number, w: number, h: number, margin = 24) {
    const svg = svgRef.current; if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const left = toScreen(cx - w / 2, cy - h / 2);
    const right = toScreen(cx + w / 2, cy + h / 2);
    let newPanX = pan.x, newPanY = pan.y;
    if (left.x < margin) newPanX += margin - left.x;
    if (right.x > rect.width - margin) newPanX -= right.x - (rect.width - margin);
    if (left.y < margin) newPanY += margin - left.y;
    if (right.y > rect.height - margin) newPanY -= right.y - (rect.height - margin);
    if (newPanX !== pan.x || newPanY !== pan.y) setPan({ x: newPanX, y: newPanY });
  }
  function getCentroidAndDistance(points: {x:number,y:number}[]) {
    const cx = (points[0].x + points[1].x) / 2;
    const cy = (points[0].y + points[1].y) / 2;
    const dx = points[1].x - points[0].x;
    const dy = points[1].y - points[0].y;
    const d  = Math.hypot(dx, dy);
    return { cx, cy, d };
  }
  function selectOnly(id: number) {
  // Shift+Tab-Pfad zurücksetzen, wenn Auswahl manuell/anders wechselt
  shiftTabPathRef.current = null;
  shiftTabIndexRef.current = 0;

  setSelectedId(id);
  setSelectedIds(new Set([id]));
  setSelectedEdgeIds(new Set());
  freshTyping.current = true;
}

  function clearSelection() {
    setSelectedId(null);
    setSelectedIds(new Set());
    setSelectedEdgeIds(new Set());
    freshTyping.current = true;
  }
  function selectFromArray(ids: number[]) {
    setSelectedId(ids[0] ?? null);
    setSelectedIds(new Set(ids));
    setSelectedEdgeIds(new Set());
    freshTyping.current = true;
  }
  function isPositionFree(x: number, y: number, parentId?: number) {
    const NODE_PADDING = 8;
    const EDGE_PADDING = 6;
    for (const n of nodes) {
      if (n.id === parentId) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      const newR = Math.max(BASE_W, BASE_H) / 2;
      if (d < rectRadius(n) + newR + NODE_PADDING) return false;
    }
    for (const e of edges) {
      if (parentId && (e.source === parentId || e.target === parentId)) continue;
      const s = nodes.find(n => n.id === e.source);
      const t = nodes.find(n => n.id === e.target);
      if (!s || !t) continue;
      const d = distPointToSeg(x, y, s.x, s.y, t.x, t.y);
      if (d < Math.max(BASE_W, BASE_H) / 2 + EDGE_PADDING) return false;
    }
    return true;
  }
  function ensureEdge(a: number, b: number) {
    if (a === b) return;
    const exists = edges.some(ed => (ed.source === a && ed.target === b) || (ed.source === b && ed.target === a));
    if (!exists) setEdges(es => [...es, { id: Date.now(), source: a, target: b }]);
  }
  function getParentId(childId: number): number | null {
    const e = edges.find(ed => ed.target === childId);
    return e ? e.source : null;
  }
  function getChildrenOf(parentId: number): number[] {
    return edges.filter(e => e.source === parentId).map(e => e.target).sort((a,b)=>a-b);
  }
  // Pfad von Root → current (z. B. [root, ..., current])
// Pfad von Root → current (z. B. [root, ..., current])
function buildRootPath(startId: number): number[] {
  const up: number[] = [];
  let cur: number | null = startId;
  while (cur != null) {
    up.push(cur);
    cur = getParentId(cur);
  }
  return up.reverse();
}


  // Winkel normalisieren in [0, 2π)
function normAng(rad: number) {
  const twoPi = Math.PI * 2;
  let a = rad % twoPi;
  if (a < 0) a += twoPi;
  return a;
}

// Geschwister des aktuellen Knotens im Uhrzeigersinn (um den Parent) sortiert
function getSiblingsClockwise(currentId: number): number[] {
  const parentId = getParentId(currentId);
  if (parentId == null) return []; // kein Parent → keine Geschwister

  const parent = nodes.find(n => n.id === parentId);
  if (!parent) return [];

  const siblings = getChildrenOf(parentId); // inkl. currentId

  const withAngle = siblings.map(id => {
    const c = nodes.find(n => n.id === id)!;
    // Winkel relativ zum Parent
    const theta = Math.atan2(c.y - parent.y, c.x - parent.x);
    return { id, a: normAng(theta) };
  });

  // Uhrzeigersinn: in SVG ist Y nach unten → praktikabel: Winkel absteigend sortieren
  withAngle.sort((p, q) => q.a - p.a);

  return withAngle.map(x => x.id);
}



  function resizeNodeForLabel(n: MindNode): MindNode {
    const baseFont = clamp(Math.round(n.h * 0.35), 12, 20);
    const L = layoutLabel(n.label, baseFont, BASE_W);
    return { ...n, w: L.width, h: L.height };
  }
  function isPointInNode(n: MindNode, x: number, y: number) {
    return Math.abs(x - n.x) <= n.w / 2 && Math.abs(y - n.y) <= n.h / 2;
  }
  function findNodeAt(x: number, y: number, excludeId?: number): number | null {
    for (const n of nodes) {
      if (excludeId && n.id === excludeId) continue;
      if (isPointInNode(n, x, y)) return n.id;
    }
    return null;
  }

  /** History */
  function snapshot(): Snapshot {
    return {
      nodes,
      edges,
      pan: { ...pan },
      scale,
      selectedId,
      selectedIds: Array.from(selectedIds),
      selectedEdgeIds: Array.from(selectedEdgeIds),
    };
  }
  function pushHistory() {
    undoStack.current.push(cloneSnapshot(snapshot()));
    redoStack.current = [];
  }
  function restore(s: Snapshot) {
    setNodes(s.nodes);
    setEdges(s.edges);
    setPan(s.pan);
    setScale(s.scale);
    setSelectedId(s.selectedId);
    setSelectedIds(new Set(s.selectedIds));
    setSelectedEdgeIds(new Set(s.selectedEdgeIds));
  }
  function undo() {
    const s = undoStack.current.pop();
    if (!s) return;
    redoStack.current.push(cloneSnapshot(snapshot()));
    restore(s);
  }
  function redo() {
    const s = redoStack.current.pop();
    if (!s) return;
    undoStack.current.push(cloneSnapshot(snapshot()));
    restore(s);
  }

  /** Knoten hinzufügen – unterstützt optionale Koordinaten (für Kontextmenü) */
  function addStandalone(): number;
  function addStandalone(at: { x: number; y: number }): number;
  function addStandalone(at?: { x: number; y: number }): number {
    pushHistory();
    const newId = nodes.length ? Math.max(...nodes.map(n => n.id)) + 1 : 1;

    let x: number, y: number;

    if (at) {
      x = at.x; y = at.y;
      if (!isPositionFree(x, y)) {
        let angle = 0, radius = 12;
        for (let i = 0; i < 60; i++) {
          const nx = x + Math.cos(angle) * radius;
          const ny = y + Math.sin(angle) * radius;
          if (isPositionFree(nx, ny)) { x = nx; y = ny; break; }
          angle += GOLDEN_ANGLE;
          if (i % 6 === 5) radius += 12;
        }
      }
    } else {
      const svg = svgRef.current;
      if (!svg) {
        const node: MindNode = { id: newId, label: "", x: 0, y: 0, w: BASE_W, h: BASE_H, strokeColor: "#333", bold:false };
        setNodes(ns => [...ns, node]);
        return newId;
      }
      const rect = svg.getBoundingClientRect();
      const wx = (rect.width / 2 - pan.x) / scale;
      const wy = (rect.height / 2 - pan.y) / scale;
      x = wx; y = wy;
      let angle = 0, radius = 0;
      for (let i = 0; i < 120; i++) {
        const nx = wx + Math.cos(angle) * radius;
        const ny = wy + Math.sin(angle) * radius;
        if (isPositionFree(nx, ny)) { x = nx; y = ny; break; }
        angle += GOLDEN_ANGLE;
        if (i % 6 === 5) radius += 24;
      }
    }

    const node: MindNode = { id: newId, label: "", x, y, w: BASE_W, h: BASE_H, strokeColor: "#333", fillColor: undefined, bold:false };
    setNodes(ns => [...ns, node]);
    setTimeout(() => bringBoxIntoView(x, y, BASE_W, BASE_H), 0);
    return newId;
  }

  function addChild(parentId: number): number {
    const parent = nodes.find(n => n.id === parentId);
    if (!parent) return parentId;
    pushHistory();
    const newId = nodes.length ? Math.max(...nodes.map(n => n.id)) + 1 : 1;

    let angle = getChildrenOf(parentId).length * GOLDEN_ANGLE;
    let radius = CHILD_RADIUS;
    let x = parent.x, y = parent.y;
    for (let i = 0; i < 96; i++) {
      x = parent.x + Math.cos(angle) * radius;
      y = parent.y + Math.sin(angle) * radius;
      if (isPositionFree(x, y, parentId)) break;
      angle += GOLDEN_ANGLE;
      if (i % 8 === 7) radius += 24;
    }

    const child: MindNode = {
      id: newId, label: "", x, y, w: BASE_W, h: BASE_H,
      strokeColor: parent.strokeColor, fillColor: parent.fillColor, bold: false,
    };
    setNodes(ns => [...ns, child]);
    setEdges(es => [...es, { id: Date.now(), source: parentId, target: newId }]);
    setTimeout(() => bringBoxIntoView(x, y, BASE_W, BASE_H), 0);
    return newId;
  }
  function addSiblingOf(nodeId: number): number {
    const parentId = getParentId(nodeId);
    if (parentId != null) return addChild(parentId);
    return addStandalone();
  }

  /** Entfernen – wählt Parent automatisch */
  function removeEdges(ids: number[]) {
    if (!ids.length) return;
    pushHistory();
    const del = new Set(ids);
    setEdges(prev => prev.filter(e => !del.has(e.id)));
    setSelectedEdgeIds(new Set());
  }
  function removeNodes(ids: number[]) {
    if (!ids.length) return;
    pushHistory();
    const del = new Set(ids);

    let nextSelection: number | null = null;
    if (ids.length === 1) {
      const victim = ids[0];
      const parent = getParentId(victim);
      if (parent != null && !del.has(parent)) nextSelection = parent;
    }

    setNodes(prev => prev.filter(n => !del.has(n.id)));
    setEdges(prev => prev.filter(e => !del.has(e.source) && !del.has(e.target)));

    if (nextSelection != null) {
      setSelectedId(nextSelection);
      setSelectedIds(new Set([nextSelection]));
      setSelectedEdgeIds(new Set());
      setTimeout(() => {
        const n = nodes.find(x => x.id === nextSelection);
        if (n) bringBoxIntoView(n.x, n.y, n.w, n.h);
      }, 0);
    } else {
      clearSelection();
    }
  }

  /** --- Pointer auf Node --- */
  function onPointerDownNode(e: React.PointerEvent<SVGGElement>, id: number) {
    if (editingId !== null) return;

    if (e.shiftKey) {
      e.preventDefault(); e.stopPropagation();
      if (selectedId != null && selectedId !== id) {
        pushHistory(); ensureEdge(selectedId, id); selectOnly(id); return;
      }
      selectOnly(id);
      const src = nodes.find(n => n.id === id)!;
      setLinking({ phase: "pending", sourceId: id, x: src.x, y: src.y, startX: src.x, startY: src.y });
      return;
    }
    if (linking.phase !== "idle") return;

    const wasInSelection = selectedIds.has(id);
    freshTyping.current = true;
    if (!wasInSelection) selectOnly(id);

    const { x: px, y: py } = toWorld(e.clientX, e.clientY);

    if (selectedIds.size > 1) {
      groupDragging.current = true;
      groupStart.current = { x: px, y: py };
      groupStartPositions.current = Array.from(selectedIds).map(nid => {
        const n = nodes.find(nn => nn.id === nid)!;
        return { id: nid, x: n.x, y: n.y };
      });
    } else {
      draggingNodeId.current = id;
      const node = nodes.find(n => n.id === id)!;
      dragOffset.current = { dx: node.x - px, dy: node.y - py };
      somethingMoved.current = false;
    }
  }

  /** --- SVG Pointer --- */
  function onPointerDownSvg(e: React.PointerEvent<SVGSVGElement>) {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    activeTouches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activeTouches.current.size === 2) {
      const pts = Array.from(activeTouches.current.values());
      const { cx, cy, d } = getCentroidAndDistance(pts);
      pinchStart.current = { d, scale, panX: pan.x, panY: pan.y, cx, cy };
    }
    panning.current = activeTouches.current.size < 2;
    panStart.current = { x: e.clientX, y: e.clientY };
    panAtStart.current = { ...pan };
  }

  function onPointerMoveSvg(e: React.PointerEvent<SVGSVGElement>) {
    if (activeTouches.current.has(e.pointerId)) {
      activeTouches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activeTouches.current.size === 2 && pinchStart.current) {
        e.preventDefault();
        const pts = Array.from(activeTouches.current.values());
        const { cx, cy, d } = getCentroidAndDistance(pts);
        const svg = svgRef.current!;
        const rect = svg.getBoundingClientRect();

        const s0 = pinchStart.current.scale;
        let s = clamp(s0 * (d / pinchStart.current.d), 0.3, 3);
        const wx0 = (pinchStart.current.cx - rect.left - pinchStart.current.panX) / pinchStart.current.scale;
        const wy0 = (pinchStart.current.cy - rect.top  - pinchStart.current.panY) / pinchStart.current.scale;

        const newPanX = (cx - rect.left) - wx0 * s;
        const newPanY = (cy - rect.top)  - wy0 * s;

        setScale(s);
        setPan({ x: newPanX, y: newPanY });
        return;
      }
    }

    if (marquee.active) {
      const { x, y } = toWorld(e.clientX, e.clientY);
      setMarquee(m => ({ ...m, x2: x, y2: y }));
      return;
    }
    if (linking.phase === "pending" || linking.phase === "active") {
      const { x, y } = toWorld(e.clientX, e.clientY);
      const thresholdWorld = DRAG_THRESHOLD / scale;
      const moved = Math.hypot(x - linking.startX, y - linking.startY) > thresholdWorld;
      if (linking.phase === "pending" && moved) setLinking(l => ({ ...l, phase: "active", x, y }));
      else if (linking.phase === "active") setLinking(l => ({ ...l, x, y }));
      return;
    }
    if (groupDragging.current) {
      somethingMoved.current = true;
      const { x: px, y: py } = toWorld(e.clientX, e.clientY);
      const dx = px - groupStart.current.x;
      const dy = py - groupStart.current.y;
      const posMap = new Map(groupStartPositions.current.map(p => [p.id, p]));
      setNodes(prev => prev.map(n => selectedIds.has(n.id) ? { ...n, x: posMap.get(n.id)!.x + dx, y: posMap.get(n.id)!.y + dy } : n));
      return;
    }
    if (draggingNodeId.current != null) {
      const { x: px, y: py } = toWorld(e.clientX, e.clientY);
      const id = draggingNodeId.current;
      setNodes(prev => prev.map(n => n.id === id ? { ...n, x: px + dragOffset.current.dx, y: py + dragOffset.current.dy } : n));
      somethingMoved.current = true;
      return;
    }

    if (panning.current) {
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      setPan({ x: panAtStart.current.x + dx, y: panAtStart.current.y + dy });
    }
  }

  function onPointerUpSvg(e?: React.PointerEvent<SVGSVGElement>) {
    if (e) {
      activeTouches.current.delete(e.pointerId);
      if (activeTouches.current.size < 2) pinchStart.current = null;
    }
    if (marquee.active) {
      const { x1, y1, x2, y2 } = marquee;
      const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
      const ids = nodes.filter(n => n.x >= minX && n.x <= maxX && n.y >= minY && n.y <= maxY).map(n => n.id);
      selectFromArray(ids);
      setMarquee({ active: false, x1: 0, y1: 0, x2: 0, y2: 0 });
    }
    if ((linking.phase === "pending" || linking.phase === "active") && linking.sourceId != null) {
      const targetId = findNodeAt(linking.x, linking.y, linking.sourceId);
      if (targetId) {
        const exists = edges.some(ed =>
          (ed.source === linking.sourceId && ed.target === targetId) ||
          (ed.source === targetId && ed.target === linking.sourceId)
        );
        if (!exists) { pushHistory(); setEdges(es => [...es, { id: Date.now(), source: linking.sourceId!, target: targetId }]); }
        selectOnly(targetId);
      }
      setLinking({ phase: "idle", sourceId: null, x: 0, y: 0, startX: 0, startY: 0 });
    }

    if (somethingMoved.current) { pushHistory(); }

    draggingNodeId.current = null;
    groupDragging.current = false;
    panning.current = false;
    somethingMoved.current = false;
  }

  function onPointerCancelSvg(e: React.PointerEvent<SVGSVGElement>) {
    activeTouches.current.delete(e.pointerId);
    pinchStart.current = null;
    panning.current = false;
  }

  /** --- Keyboard --- */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (editingId != null) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;

      const hasNodeSel = selectedIds.size > 0;
      const hasEdgeSel = selectedEdgeIds.size > 0;

      // Undo/Redo
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) { e.preventDefault(); undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && (e.key === "Z" || e.key === "z")))) { e.preventDefault(); redo(); return; }

      // Größe +/- (Shift)
      if (e.shiftKey && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        const ids = Array.from(selectedIds);
        if (ids.length) {
          pushHistory();
          setNodes(prev => prev.map(n => ids.includes(n.id)
            ? { ...n, w: Math.min(420, Math.round(n.w * 1.2)), h: Math.min(240, Math.round(n.h * 1.15)) }
            : n));
        }
        return;
      }
      if (e.shiftKey && (e.key === "-" || e.key === "_")) {
        e.preventDefault();
        const ids = Array.from(selectedIds);
        if (ids.length) {
          pushHistory();
          setNodes(prev => prev.map(n => ids.includes(n.id)
            ? { ...n, w: Math.max(80, Math.round(n.w / 1.2)), h: Math.max(48, Math.round(n.h / 1.15)) }
            : n));
        }
        return;
      }

      // Pfeile: Nachbar
      if ((e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") && selectedId != null) {
        e.preventDefault();
        const dir = e.key === "ArrowUp" ? {x:0,y:-1} : e.key === "ArrowDown" ? {x:0,y:1} : e.key === "ArrowLeft" ? {x:-1,y:0} : {x:1,y:0};
        const cur = nodes.find(n => n.id === selectedId); if (!cur) return;
        let best: { id: number; score: number; dist: number } | null = null;
        const len = Math.hypot(dir.x, dir.y) || 1; const ux = dir.x/len, uy = dir.y/len;
        for (const n of nodes) {
          if (n.id === selectedId) continue;
          const vx = n.x - cur.x; const vy = n.y - cur.y;
          const dist = Math.hypot(vx, vy); if (dist === 0) continue;
          const dot = vx*ux + vy*uy; if (dot <= 0) continue;
          const cos = dot / dist;
          const score = cos + 0.0001/dist;
          if (!best || score > best.score) best = { id: n.id, score, dist };
        }
        if (best) { selectOnly(best.id); const n = nodes.find(x => x.id === best!.id)!; bringBoxIntoView(n.x, n.y, n.w, n.h); }
        return;
      }

      // Enter: Child / Shift+Enter: Sibling (ohne doppeltes bringBoxIntoView)
      if (e.key === "Enter" && selectedId != null && selectedIds.size === 1 && !e.shiftKey) {
        e.preventDefault();
        const newId = addChild(selectedId);
        selectOnly(newId);
        freshTyping.current = true;
        return;
      }
      if (e.key === "Enter" && e.shiftKey && selectedId != null && selectedIds.size === 1) {
        e.preventDefault();
        const newId = addSiblingOf(selectedId);
        selectOnly(newId);
        freshTyping.current = true;
        return;
      }

      // Escape: Auswahl löschen
      if (e.key === "Escape") { clearSelection(); return; }

      // Shift+Backspace: löschen (Knoten bevorzugt, sonst Kanten)
      if (e.key === "Backspace" && e.shiftKey) {
        e.preventDefault();
        if (hasNodeSel) removeNodes(Array.from(selectedIds));
        else if (hasEdgeSel) removeEdges(Array.from(selectedEdgeIds));
        return;
      }

      // Backspace: Text löschen (bei 1 Knoten), mehrere → löschen
      if (e.key === "Backspace") {
        e.preventDefault();
        const ids = Array.from(selectedIds);
        if (ids.length > 1) { removeNodes(ids); return; }
        if (ids.length === 1) {
          const id = ids[0];
          pushHistory();
          setNodes(prev => prev.map(n => {
            if (n.id !== id) return n;
            const next = n.label.slice(0, Math.max(0, n.label.length - 1));
            return resizeNodeForLabel({ ...n, label: next });
          }));
        }
        return;
      }

      // Shift+Tab: zum nächst höheren Knoten (Parent) springen
// Shift+Tab: nach oben (Parent). Wenn am Root angekommen, denselben Pfad wieder nach unten gehen.
// Shift+Tab: nach oben. Wenn oben (Root) angekommen, denselben Pfad wieder nach unten laufen – bis Leaf, dann stoppen.
if (e.key === "Tab" && e.shiftKey && selectedId != null && selectedIds.size === 1) {
  e.preventDefault();

  // Pfad initialisieren oder neu aufbauen, wenn Selection nicht im aktuellen Pfad ist
  if (
    !shiftTabPathRef.current ||
    shiftTabPathRef.current.indexOf(selectedId) === -1
  ) {
    const path = buildRootPath(selectedId);          // [root, ..., current]
    shiftTabPathRef.current = path;
    shiftTabIndexRef.current = path.length - 1;      // current-Position
  }

  const path = shiftTabPathRef.current!;
  let idx = shiftTabIndexRef.current;

  if (idx > 0) {
    // noch nicht am Root → einen Schritt nach oben
    idx = idx - 1;
  } else {
    // bereits am Root → jetzt wieder nach unten laufen, bis Leaf
    if (idx < path.length - 1) {
      idx = idx + 1;
    } else {
      // schon am Leaf: nichts mehr tun
      return;
    }
  }

  shiftTabIndexRef.current = idx;
  const nextId = path[idx];
  selectOnly(nextId);
  const n = nodes.find(x => x.id === nextId);
  if (n) bringBoxIntoView(n.x, n.y, n.w, n.h);
  return;
}



// Normales Tab: alle Knoten spiralförmig durchgehen (wrap-around)
// Normales Tab: alle Geschwister im Uhrzeigersinn durchgehen (Wrap-around)
if (e.key === 'Tab' && !e.shiftKey && selectedId != null && selectedIds.size === 1) {
  e.preventDefault();
  const order = getSiblingsClockwise(selectedId);
  if (order.length <= 1) return; // kein oder nur ein Geschwister → nichts zu tun
  const idx = order.indexOf(selectedId);
  const nextId = order[(idx + 1) % order.length];
  selectOnly(nextId);
  const n = nodes.find(x => x.id === nextId);
  if (n) bringBoxIntoView(n.x, n.y, n.w, n.h);
  return;
}
// Option+Tab (Alt+Tab): in ersten Unterknoten springen (falls vorhanden)
if ((e.key === 'Tab' && (e.altKey || e.metaKey)) && selectedId != null && selectedIds.size === 1) {
  e.preventDefault();
  const kids = getChildrenOf(selectedId);
  if (kids.length > 0) {
    const nextId = kids[0]; // nimm den ersten Unterknoten
    selectOnly(nextId);
    const n = nodes.find(x => x.id === nextId);
    if (n) bringBoxIntoView(n.x, n.y, n.w, n.h);
  }
  return;
}



      // Tippen: Text in Knoten/Kante
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const char = e.key;

        if (selectedEdgeIds.size) {
          pushHistory();
          const replaceAll = freshTyping.current;
          setEdges(prev => prev.map(ed => {
            if (!selectedEdgeIds.has(ed.id)) return ed;
            const cur = ed.label ?? "";
            const next = replaceAll ? char : cur + char;
            return { ...ed, label: next };
          }));
          freshTyping.current = false;
          return;
        }

        if (selectedIds.size >= 1) {
          pushHistory();
          const ids = Array.from(selectedIds);
          let replaceAll = freshTyping.current;
          setNodes(prev => prev.map(n => {
            if (!ids.includes(n.id)) return n;
            const nextText = replaceAll ? char : (n.label + char);
            return resizeNodeForLabel({ ...n, label: nextText });
          }));
          freshTyping.current = false;
          return;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId, selectedIds, selectedEdgeIds, editingId, linking.phase, edges, nodes, pan, scale]);

  /** Hintergrund-Interaktionen */
  function onPointerDownBg(e: React.PointerEvent<SVGRectElement>) {
    if (editingId != null) setEditingId(null);
    if (linking.phase !== "idle") return;

    if (e.shiftKey) {
      e.preventDefault();
      const { x, y } = toWorld(e.clientX, e.clientY);
      setMarquee({ active: true, x1: x, y1: y, x2: x, y2: y });
      return;
    }
    clearSelection();
    panning.current = true;
    panStart.current = { x: e.clientX, y: e.clientY };
    panAtStart.current = { ...pan };
    freshTyping.current = true;
  }

  function onWheelSvg(e: React.WheelEvent<SVGSVGElement>) {
    e.preventDefault();
    const doZoom = !e.shiftKey;

    if (doZoom) {
      const zoomIntensity = 0.0015;
      const factor = Math.exp(-e.deltaY * zoomIntensity);
      const newScale = clamp(scale * factor, 0.3, 3);

      const svg = svgRef.current!;
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const wx = (mx - pan.x) / scale;
      const wy = (my - pan.y) / scale;

      const newPanX = mx - wx * newScale;
      const newPanY = my - wy * newScale;

      setPan({ x: newPanX, y: newPanY });
      setScale(newScale);
      return;
    }

    setPan(prev => ({ x: prev.x - e.deltaX, y: prev.y - e.deltaY }));
  }

  /** Checkbox/Linien-Dash im Kontextmenü gebraucht */
  const selectedEdgesArray = edges.filter(e => selectedEdgeIds.has(e.id));
  const palette: { name: string; color: string }[] = [
    { name: "Neon Grün",  color: "#39FF14" },
    { name: "Neon Gelb",  color: "#FFFF33" },
    { name: "Neon Rot",   color: "#FF073A" },
    { name: "Schwarz",    color: "#000000" },
  ];
  function applyFillToSelection(hex: string) {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    pushHistory();
    const rgba = hexToRgba60(hex);
    setNodes(prev => prev.map(n => ids.includes(n.id) ? { ...n, fillColor: rgba } : n));
  }
  function clearFillOfSelection() {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    pushHistory();
    setNodes(prev => prev.map(n => ids.includes(n.id) ? { ...n, fillColor: undefined } : n));
  }

  /** --- Render --- */
  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "#f5f5f5",
        overflow: "hidden",
        userSelect: "none",
        fontFamily:
          "Inter, Roboto, Noto Sans, Ubuntu, Cantarell, system-ui, -apple-system, Helvetica, Arial, sans-serif",
      }}
      onClick={() => { if (contextMenu.open) setContextMenu({ ...contextMenu, open:false }); }}
      onContextMenu={(e) => {
        e.preventDefault();
        const w = toWorld(e.clientX, e.clientY);
        setContextMenu({ open:true, x:e.clientX, y:e.clientY, wx:w.x, wy:w.y, kind:'bg' });
      }}
    >
      {/* Zeichenfläche */}
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        onPointerDown={onPointerDownSvg}
        onPointerMove={onPointerMoveSvg}
        onPointerUp={onPointerUpSvg}
        onPointerLeave={onPointerUpSvg}
        onPointerCancel={onPointerCancelSvg}
        onWheel={onWheelSvg}
        style={{
          touchAction: "none",
          background: "#fff",
          cursor:
            groupDragging.current || draggingNodeId.current
              ? "grabbing"
              : linking.phase === "active"
              ? "crosshair"
              : "grab",
          userSelect: "none",
        }}
      >
        <defs>
          <pattern id="dotGrid" width="32" height="32" patternUnits="userSpaceOnUse">
            <rect x="0" y="0" width="2.4" height="2.4" fill="#b6c2d1" opacity="0.5" />
          </pattern>
        </defs>
        <g transform={`translate(${pan.x},${pan.y}) scale(${scale})`}>
          {/* Hintergrund */}
          <rect
            x={-5000}
            y={-5000}
            width={10000}
            height={10000}
            fill="url(#dotGrid)"
            onPointerDown={onPointerDownBg}
            onContextMenu={(e) => {
              e.preventDefault();
              const w = toWorld(e.clientX, e.clientY);
              setContextMenu({ open:true, x:e.clientX, y:e.clientY, wx:w.x, wy:w.y, kind:'bg' });
            }}
          />

          {/* Kanten */}
          {edges.map((e) => {
            const s = nodes.find((n) => n.id === e.source);
            const t = nodes.find((n) => n.id === e.target);
            if (!s || !t) return null;

            const highlightedNodeSide = selectedIds.has(e.source) || selectedIds.has(e.target);
            const isEdgeSelected = selectedEdgeIds.has(e.id);

            const stroke = isEdgeSelected ? "#1976d2" : (highlightedNodeSide ? "#1976d2" : "#888");
            const strokeWidth = isEdgeSelected ? 4 : (highlightedNodeSide ? 3 : 2);
            const dash = e.dashed ? "8 6" : undefined;

            const onEdgePointerDown = (evt: React.PointerEvent<SVGLineElement | SVGPathElement>) => {
              evt.stopPropagation();
              setSelectedIds(new Set()); setSelectedId(null);
              setSelectedEdgeIds(prev => {
                const next = new Set(prev);
                if (evt.shiftKey) { if (next.has(e.id)) next.delete(e.id); else next.add(e.id); }
                else { next.clear(); next.add(e.id); }
                return next;
              });
              freshTyping.current = true;
            };

            const mx = (s.x + t.x) / 2;
            const my = (s.y + t.y) / 2;

            return (
              <g key={e.id}>
                <line
                  x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                  stroke="transparent" strokeWidth={Math.max(12 / scale, 6)}
                  onPointerDown={onEdgePointerDown}
                  onContextMenu={(evt)=>{ evt.preventDefault(); evt.stopPropagation(); setSelectedIds(new Set()); setSelectedId(null); setSelectedEdgeIds(new Set([e.id])); setContextMenu({ open:true, x:evt.clientX, y:evt.clientY, kind:'edge', targetEdgeId:e.id }); }}
                />
                <line x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={dash} />
                {e.label && (
                  <g pointerEvents="none">
                    <rect x={mx - (e.label.length * 6)} y={my - 10} width={Math.max(24, e.label.length * 12)} height={20} rx={6} ry={6} fill="rgba(255,255,255,0.9)" />
                    <text x={mx} y={my + 5} textAnchor="middle" fontSize={12} fill={isEdgeSelected ? "#1976d2" : "#333"}>{e.label}</text>
                  </g>
                )}
              </g>
            );
          })}

          {/* temporäre Kante */}
          {linking.phase === "active" && linking.sourceId != null && (() => {
            const s = nodes.find((n) => n.id === linking.sourceId)!;
            return <line x1={s.x} y1={s.y} x2={linking.x} y2={linking.y} stroke="#1976d2" strokeWidth={2} strokeDasharray="6 4" />;
          })()}

          {/* Knoten */}
          {nodes.map((n) => {
            const isEditing = editingId === n.id;
            const isSelected = selectedIds.has(n.id);

            const baseFont = clamp(Math.round(n.h * 0.35), 12, 20);
            const displayText = isEditing ? editingText : n.label;
            const L = layoutLabel(displayText, baseFont, n.w);
            const textLines = L.lines;

            const corner = Math.round(Math.min(n.w, n.h) * 0.28);
            const stroke = isSelected ? "#1976d2" : (n.strokeColor || "#000");
            const strokeW = isSelected ? 4 : 2;

            const startY = -((textLines.length - 1) / 2) * L.lineHeight;

            return (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                onPointerDown={(e) => onPointerDownNode(e, n.id)}
                onDoubleClick={() => { selectOnly(n.id); freshTyping.current = true;  }}
                onContextMenu={(e)=>{ e.preventDefault(); e.stopPropagation(); selectOnly(n.id); setContextMenu({ open:true, x:e.clientX, y:e.clientY, kind:'node', targetNodeId:n.id }); }}
              >
                {/* Box */}
                <rect x={-n.w/2} y={-n.h/2} width={n.w} height={n.h} rx={corner} ry={corner} fill="#fff" />
                {n.fillColor && <rect x={-n.w/2} y={-n.h/2} width={n.w} height={n.h} rx={corner} ry={corner} fill={n.fillColor} />}
                <rect x={-n.w/2} y={-n.h/2} width={n.w} height={n.h} rx={corner} ry={corner} fill="none" stroke={stroke} strokeWidth={strokeW} style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,.15))" }} />

                {/* Text */}
                <g pointerEvents="none">
                  {textLines.map((line, i) => (
                    <text
                      key={i}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      x={0}
                      y={startY + i * L.lineHeight}
                      fontSize={L.fontSize}
                      fontWeight={n.bold ? 700 : 400}
                      fill={isSelected ? "#1976d2" : "#000"}
                      style={{ userSelect: "text" }}
                    >
                      {line}
                    </text>
                  ))}
                </g>

                {/* Unsichtbares Input */}
                {isEditing && (
                  <foreignObject x={-n.w/2 + 8} y={-n.h/2 + 6} width={n.w - 16} height={n.h - 12}>
                    <input
                      ref={editInputRef}
                      value={editingText}
                      onChange={(e) => {
                        const v = e.target.value;
                        setEditingText(v);
                        if (editingId != null) {
                          pushHistory();
                          setNodes(prev => prev.map(nn => nn.id === editingId ? resizeNodeForLabel({ ...nn, label: v }) : nn));
                        }
                      }}
                      onBlur={() => setEditingId(null)}
                      onKeyDown={(e) => { if (e.key === "Enter") setEditingId(null); if (e.key === "Escape") setEditingId(null); }}
                      style={{
                        width: "100%", height: "100%", border: "none", background: "transparent",
                        color: "transparent", caretColor: isSelected ? "#1976d2" : "#000", padding: 0, margin: 0,
                        fontSize: L.fontSize, lineHeight: `${L.lineHeight}px`, textAlign: "center", outline: "none",
                        fontFamily: "Inter, Roboto, Noto Sans, Ubuntu, Cantarell, system-ui, -apple-system, Helvetica, Arial, sans-serif",
                      }}
                    />
                  </foreignObject>
                )}
              </g>
            );
          })}

          {/* Marquee */}
          {marquee.active && (() => {
            const { x1, y1, x2, y2 } = marquee;
            const x = Math.min(x1, x2);
            const y = Math.min(y1, y2);
            const w = Math.abs(x2 - x1);
            const h = Math.abs(y2 - y1);
            return <rect x={x} y={y} width={w} height={h} fill="#1976d2" fillOpacity={0.12} stroke="#1976d2" strokeDasharray="6 4" />;
          })()}
        </g>
      </svg>

      {/* Rechtsklick-Menü */}
      {contextMenu.open && (
        <div
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 2000, background: '#fff', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.18)', padding: 6, minWidth: 240, border: '1px solid rgba(0,0,0,.08)' }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Hintergrund */}
          {contextMenu.kind === 'bg' && (
            <>
              <MenuItem
                label="➕ Neuer Knoten"
                onClick={() => {
                  const id = (contextMenu.wx != null && contextMenu.wy != null)
                    ? addStandalone({ x: contextMenu.wx, y: contextMenu.wy })
                    : addStandalone();
                  selectOnly(id);
                  setContextMenu({ ...contextMenu, open: false });
                }}
              />

              <div style={{ height: 1, background: 'rgba(0,0,0,.08)', margin: '6px 0' }} />
              <div style={{ padding: '6px 10px' }}>
                <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
                  Füllfarbe (Auswahl)
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {palette.map((p) => (
                    <button
                      key={`bg-${p.color}`}
                      title={selectedIds.size ? p.name : 'Kein Knoten ausgewählt'}
                      disabled={selectedIds.size === 0}
                      onClick={() => { applyFillToSelection(p.color); setContextMenu({ ...contextMenu, open: false }); }}
                      style={{
                        width: 24, height: 24, borderRadius: 6, border: '1px solid #555', background: '#fff', padding: 0,
                        cursor: selectedIds.size ? 'pointer' : 'not-allowed',
                        opacity: selectedIds.size ? 1 : 0.5,
                        boxShadow: '0 1px 4px rgba(0,0,0,.15)',
                      }}
                    >
                      <span style={{ display: 'block', width: 18, height: 18, borderRadius: 5, background: p.color, margin: '3px' }} />
                    </button>
                  ))}
                  <button
                    disabled={selectedIds.size === 0}
                    onClick={() => { clearFillOfSelection(); setContextMenu({ ...contextMenu, open: false }); }}
                    style={{ background:'#eee', color:'#333', border:'none', padding:'6px 10px', borderRadius:10, cursor: selectedIds.size ? 'pointer' : 'not-allowed' }}
                  >
                    🧽 Farbe weg
                  </button>
                </div>
              </div>

              <div style={{ height: 1, background: 'rgba(0,0,0,.08)', margin: '6px 0' }} />
              <MenuItem
                label="🗑️ Löschen (Auswahl)"
                onClick={() => {
                  if (selectedIds.size > 0) removeNodes(Array.from(selectedIds));
                  else if (selectedEdgeIds.size > 0) removeEdges(Array.from(selectedEdgeIds));
                  setContextMenu({ ...contextMenu, open: false });
                }}
                disabled={selectedIds.size === 0 && selectedEdgeIds.size === 0}
              />
            </>
          )}

          {/* Knoten */}
          {contextMenu.kind === 'node' && (
            <>
              <MenuItem label="✏️ Umbenennen" onClick={() => { if (contextMenu.targetNodeId!=null) { setEditingId(contextMenu.targetNodeId); setEditingText(nodes.find(n=>n.id===contextMenu.targetNodeId)?.label || ""); } setContextMenu({ ...contextMenu, open:false }); }} />
              <MenuItem label="➕ Unterknoten" onClick={() => { if (contextMenu.targetNodeId!=null) { const id = addChild(contextMenu.targetNodeId); selectOnly(id); } setContextMenu({ ...contextMenu, open:false }); }} />
              <MenuItem label="➕ Nebenknoten" onClick={() => { if (contextMenu.targetNodeId!=null) { const id = addSiblingOf(contextMenu.targetNodeId); selectOnly(id); } setContextMenu({ ...contextMenu, open:false }); }} />
              <MenuItem label="⭐ Hervorheben" onClick={() => { if (contextMenu.targetNodeId!=null) { const id = contextMenu.targetNodeId; pushHistory(); setNodes(prev => prev.map(n => n.id === id ? { ...n, bold: !n.bold } : n)); } setContextMenu({ ...contextMenu, open:false }); }} />
              <div style={{ height:1, background:'rgba(0,0,0,.08)', margin:'6px 0' }} />

              <div style={{ padding:'6px 10px' }}>
                <div style={{ fontSize:12, opacity:.7, marginBottom:6 }}>Füllfarbe</div>
                <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
                  {palette.map(p => (
                    <button
                      key={p.color}
                      title={p.name}
                      onClick={() => {
                        if (contextMenu.targetNodeId!=null) {
                          const rgba = hexToRgba60(p.color);
                          pushHistory();
                          setNodes(prev => prev.map(n => n.id === contextMenu.targetNodeId ? { ...n, fillColor: rgba } : n));
                        }
                        setContextMenu({ ...contextMenu, open:false });
                      }}
                      style={{ width:24, height:24, borderRadius:6, border:'1px solid #555', background:'#fff', padding:0, cursor:'pointer', boxShadow:'0 1px 4px rgba(0,0,0,.15)' }}
                    >
                      <span style={{ display:'block', width:18, height:18, borderRadius:5, background:p.color, margin:'3px' }} />
                    </button>
                  ))}
                  <button
                    onClick={() => {
                      if (contextMenu.targetNodeId!=null) {
                        pushHistory();
                        setNodes(prev => prev.map(n => n.id === contextMenu.targetNodeId ? { ...n, fillColor: undefined } : n));
                      }
                      setContextMenu({ ...contextMenu, open:false });
                    }}
                    style={{ background:'#eee', color:'#333', border:'none', padding:'6px 10px', borderRadius:10 }}
                  >Farbe weg</button>
                </div>
              </div>

              {/* Rahmenfarbe */}
              <div style={{ padding:'6px 10px' }}>
                <div style={{ fontSize:12, opacity:.7, margin:'6px 0' }}>Rahmenfarbe</div>
                <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
                  {palette.map(p => (
                    <button
                      key={`border-${p.color}`}
                      title={p.name}
                      onClick={() => {
                        if (contextMenu.targetNodeId!=null) {
                          pushHistory();
                          setNodes(prev => prev.map(n => n.id === contextMenu.targetNodeId ? { ...n, strokeColor: p.color } : n));
                        }
                        setContextMenu({ ...contextMenu, open:false });
                      }}
                      style={{ width:24, height:24, borderRadius:6, border:'2px solid #555', background:p.color, padding:0, cursor:'pointer', boxShadow:'0 1px 4px rgba(0,0,0,.15)' }}
                    />
                  ))}
                </div>
              </div>

              <div style={{ height:1, background:'rgba(0,0,0,.08)', margin:'6px 0' }} />
              <MenuItem label="🗑️ Knoten löschen" onClick={() => { if (contextMenu.targetNodeId!=null) removeNodes([contextMenu.targetNodeId]); setContextMenu({ ...contextMenu, open:false }); }} />
            </>
          )}

          {/* Kante */}
          {contextMenu.kind === 'edge' && (
            <>
              <MenuItem
                label="gestrichelt umschalten"
                onClick={() => {
                  if (contextMenu.targetEdgeId!=null) {
                    const id = contextMenu.targetEdgeId;
                    pushHistory();
                    setEdges(prev => prev.map(ed => ed.id === id ? { ...ed, dashed: !ed.dashed } : ed));
                  }
                  setContextMenu({ ...contextMenu, open:false });
                }}
              />
              <MenuItem
                label="✏️ Label bearbeiten"
                onClick={() => {
                  if (contextMenu.targetEdgeId!=null) {
                    const ed = edges.find(x => x.id === contextMenu.targetEdgeId);
                    const cur = ed?.label ?? "";
                    const next = window.prompt('Label für Kante:', cur);
                    if (next !== null) {
                      pushHistory();
                      const id = contextMenu.targetEdgeId;
                      setEdges(prev => prev.map(e => e.id === id ? { ...e, label: next || undefined } : e));
                    }
                  }
                  setContextMenu({ ...contextMenu, open:false });
                }}
              />
              <div style={{ height:1, background:'rgba(0,0,0,.08)', margin:'6px 0' }} />
              <MenuItem label="🗑️ Kante löschen" onClick={() => { if (contextMenu.targetEdgeId!=null) removeEdges([contextMenu.targetEdgeId]); setContextMenu({ ...contextMenu, open:false }); }} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** --- MenuItem-Helper --- */
function MenuItem({ label, onClick, disabled }: { label: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', background: 'transparent',
        cursor: disabled ? 'not-allowed' : 'pointer', borderRadius: 8, color: disabled ? '#999' : '#222'
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(25,118,210,.08)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
    >
      {label}
    </button>
  );
}

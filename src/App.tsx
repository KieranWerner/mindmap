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
const STORAGE_KEY = "mindmap_v14";
const BASE_W = 120;
const BASE_H = 64;
const DRAG_THRESHOLD = 16;
const CHILD_RADIUS = 160;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** --- Utilities --- */
const clamp = (v: number, a: number, b: number) =>
  Math.max(a, Math.min(b, v));
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

  const textW = Math.max(
    ...lines.map((t) => approxTextWidth(t, baseFont)),
    0
  );
  width = Math.max(width, Math.ceil(textW + paddingX * 2));
  const height = Math.max(
    BASE_H,
    Math.ceil(lines.length * lineHeight + paddingY * 2)
  );
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
  const bigint = parseInt(
    m.length === 3 ? m.split("").map((c) => c + c).join("") : m,
    16
  );
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r},${g},${b},0.6)`;
}

function distPointToSeg(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
) {
  const vx = x2 - x1,
    vy = y2 - y1;
  const wx = px - x1,
    wy = py - y1;
  const len2 = vx * vx + vy * vy || 1e-6;
  let t = (wx * vx + wy * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * vx,
    cy = y1 + t * vy;
  return Math.hypot(px - cx, py - cy);
}

const rectRadius = (n: MindNode) => Math.max(n.w, n.h) / 2;
const cloneSnapshot = (s: Snapshot): Snapshot =>
  JSON.parse(JSON.stringify(s));

/** --- App --- */
export default function App() {
  /** State */
  const [nodes, setNodes] = useState<MindNode[]>([
    {
      id: 1,
      label: "Type to change Text",
      x: 0,
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
  const [selectedIds, setSelectedIds] = useState<Set<number>>(
    new Set([1])
  );
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<Set<number>>(
    new Set()
  );

  /** Pan & Zoom */
  const [pan, setPan] = useState(() => ({
    x: typeof window !== "undefined" ? window.innerWidth / 2 : 0,
    y: typeof window !== "undefined" ? window.innerHeight / 2 : 0,
  }));
  const [scale, setScale] = useState(1);

  /** Refs */
  // Pfad-Navigation für Shift+Tab
  const shiftTabPathRef = useRef<number[] | null>(null); // [root, ..., leaf]
  const shiftTabIndexRef = useRef<number>(0); // aktueller Index im Pfad

  // zuletzt ausgewählter Knoten für Tab-Toggle
  const prevSelectedIdRef = useRef<number | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const draggingNodeId = useRef<number | null>(null);
  const dragOffset = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const somethingMoved = useRef<boolean>(false);

  const groupDragging = useRef(false);
  const groupStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const groupStartPositions = useRef<
    { id: number; x: number; y: number }[]
  >([]);

  const panning = useRef(false);
  const panStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const panAtStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const activeTouches = useRef<
    Map<number, { x: number; y: number }>
  >(new Map());
  const pinchStart = useRef<{
    d: number;
    scale: number;
    panX: number;
    panY: number;
    cx: number;
    cy: number;
  } | null>(null);

  const [marquee, setMarquee] = useState<{
    active: boolean;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }>({ active: false, x1: 0, y1: 0, x2: 0, y2: 0 });

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const editInputRef = useRef<HTMLInputElement | null>(null);

  const [linking, setLinking] = useState<{
    phase: "idle" | "pending" | "active";
    sourceId: number | null;
    x: number;
    y: number;
    startX: number;
    startY: number;
  }>({
    phase: "idle",
    sourceId: null,
    x: 0,
    y: 0,
    startX: 0,
    startY: 0,
  });

  const freshTyping = useRef<boolean>(true);

  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);

  /** Kontextmenü (+ Klickposition in Weltkoordinaten) */
  const [contextMenu, setContextMenu] = useState<{
    open: boolean;
    x: number;
    y: number; // Bildschirmposition
    wx?: number;
    wy?: number; // Weltposition für „new knot“
    kind: "bg" | "node" | "edge";
    targetNodeId?: number;
    targetEdgeId?: number;
  }>({ open: false, x: 0, y: 0, kind: "bg" });

  // File-Input-Ref für Load-Dialog
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
          x: Number(n.x),
          y: Number(n.y),
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
    return {
      x: (clientX - rect.left - pan.x) / scale,
      y: (clientY - rect.top - pan.y) / scale,
    };
  }
  function toScreen(wx: number, wy: number) {
    return { x: pan.x + wx * scale, y: pan.y + wy * scale };
  }
  function bringBoxIntoView(
    cx: number,
    cy: number,
    w: number,
    h: number,
    margin = 24
  ) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const left = toScreen(cx - w / 2, cy - h / 2);
    const right = toScreen(cx + w / 2, cy + h / 2);
    let newPanX = pan.x,
      newPanY = pan.y;
    if (left.x < margin) newPanX += margin - left.x;
    if (right.x > rect.width - margin)
      newPanX -= right.x - (rect.width - margin);
    if (left.y < margin) newPanY += margin - left.y;
    if (right.y > rect.height - margin)
      newPanY -= right.y - (rect.height - margin);
    if (newPanX !== pan.x || newPanY !== pan.y)
      setPan({ x: newPanX, y: newPanY });
  }
  function getCentroidAndDistance(points: { x: number; y: number }[]) {
    const cx = (points[0].x + points[1].x) / 2;
    const cy = (points[0].y + points[1].y) / 2;
    const dx = points[1].x - points[0].x;
    const dy = points[1].y - points[0].y;
    const d = Math.hypot(dx, dy);
    return { cx, cy, d };
  }
  function selectOnly(id: number) {
    // Shift+Tab-Pfad zurücksetzen, wenn Auswahl wechselt
    shiftTabPathRef.current = null;
    shiftTabIndexRef.current = 0;

    // vorher markierten Knoten merken, wenn tatsächlich gewechselt wird
    if (selectedId != null && selectedId !== id) {
      prevSelectedIdRef.current = selectedId;
    }

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
      if (parentId && (e.source === parentId || e.target === parentId))
        continue;
      const s = nodes.find((n) => n.id === e.source);
      const t = nodes.find((n) => n.id === e.target);
      if (!s || !t) continue;
      const d = distPointToSeg(x, y, s.x, s.y, t.x, t.y);
      if (d < Math.max(BASE_W, BASE_H) / 2 + EDGE_PADDING) return false;
    }
    return true;
  }
  function ensureEdge(a: number, b: number) {
    if (a === b) return;
    const exists = edges.some(
      (ed) =>
        (ed.source === a && ed.target === b) ||
        (ed.source === b && ed.target === a)
    );
    if (!exists)
      setEdges((es) => [...es, { id: Date.now(), source: a, target: b }]);
  }
  function getParentId(childId: number): number | null {
    const e = edges.find((ed) => ed.target === childId);
    return e ? e.source : null;
  }
  function getChildrenOf(parentId: number): number[] {
    return edges
      .filter((e) => e.source === parentId)
      .map((e) => e.target)
      .sort((a, b) => a - b);
  }
  function buildRootPath(startId: number): number[] {
    const up: number[] = [];
    let cur: number | null = startId;
    while (cur != null) {
      up.push(cur);
      cur = getParentId(cur);
    }
    return up.reverse();
  }
  function normAng(rad: number) {
    const twoPi = Math.PI * 2;
    let a = rad % twoPi;
    if (a < 0) a += twoPi;
    return a;
  }
  function getSiblingsClockwise(currentId: number): number[] {
    const parentId = getParentId(currentId);
    if (parentId == null) return [];
    const parent = nodes.find((n) => n.id === parentId);
    if (!parent) return [];
    const siblings = getChildrenOf(parentId);
    const withAngle = siblings.map((id) => {
      const c = nodes.find((n) => n.id === id)!;
      const theta = Math.atan2(c.y - parent.y, c.x - parent.x);
      return { id, a: normAng(theta) };
    });
    // Uhrzeigersinn: absteigend (Canvas-Y wächst nach unten)
    withAngle.sort((p, q) => q.a - p.a);
    return withAngle.map((x) => x.id);
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

  /** --- Datei Export/Import --- */
  function exportToFile() {
    if (typeof window === "undefined") return;

    const data: Snapshot = snapshot();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `mindmap-${ts}.json`;
    a.click();

    URL.revokeObjectURL(url);
  }

  function importFromText(text: string) {
    try {
      const raw = JSON.parse(text);

      if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
        alert("Datei scheint keine gültige Mindmap zu sein.");
        return;
      }

      if (
        raw.pan &&
        typeof raw.pan.x === "number" &&
        typeof raw.pan.y === "number" &&
        typeof raw.scale === "number"
      ) {
        const snap: Snapshot = {
          nodes: raw.nodes,
          edges: raw.edges,
          pan: raw.pan,
          scale: raw.scale,
          selectedId: raw.selectedId ?? null,
          selectedIds: raw.selectedIds ?? [],
          selectedEdgeIds: raw.selectedEdgeIds ?? [],
        };
        restore(snap);
      } else {
        setNodes(raw.nodes as MindNode[]);
        setEdges(raw.edges as Link[]);
        setPan({ x: 0, y: 0 });
        setScale(1);
        clearSelection();
      }
    } catch (err) {
      console.error(err);
      alert("Konnte die Datei nicht lesen (kein gültiges JSON).");
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = String(ev.target?.result || "");
      importFromText(text);
      e.target.value = "";
    };
    reader.readAsText(file, "utf-8");
  }

  /** Knoten hinzufügen */
  function addStandalone(): number;
  function addStandalone(at: { x: number; y: number }): number;
  function addStandalone(at?: { x: number; y: number }): number {
    pushHistory();
    const newId = nodes.length ? Math.max(...nodes.map((n) => n.id)) + 1 : 1;

    let x: number, y: number;

    if (at) {
      x = at.x;
      y = at.y;
      if (!isPositionFree(x, y)) {
        let angle = 0,
          radius = 12;
        for (let i = 0; i < 60; i++) {
          const nx = x + Math.cos(angle) * radius;
          const ny = y + Math.sin(angle) * radius;
          if (isPositionFree(nx, ny)) {
            x = nx;
            y = ny;
            break;
          }
          angle += GOLDEN_ANGLE;
          if (i % 6 === 5) radius += 12;
        }
      }
    } else {
      const svg = svgRef.current;
      if (!svg) {
        const node: MindNode = {
          id: newId,
          label: "",
          x: 0,
          y: 0,
          w: BASE_W,
          h: BASE_H,
          strokeColor: "#333",
          bold: false,
        };
        setNodes((ns) => [...ns, node]);
        return newId;
      }
      const rect = svg.getBoundingClientRect();
      const wx = (rect.width / 2 - pan.x) / scale;
      const wy = (rect.height / 2 - pan.y) / scale;
      x = wx;
      y = wy;
      let angle = 0,
        radius = 0;
      for (let i = 0; i < 120; i++) {
        const nx = wx + Math.cos(angle) * radius;
        const ny = wy + Math.sin(angle) * radius;
        if (isPositionFree(nx, ny)) {
          x = nx;
          y = ny;
          break;
        }
        angle += GOLDEN_ANGLE;
        if (i % 6 === 5) radius += 24;
      }
    }

    const node: MindNode = {
      id: newId,
      label: "",
      x,
      y,
      w: BASE_W,
      h: BASE_H,
      strokeColor: "#333",
      fillColor: undefined,
      bold: false,
    };
    setNodes((ns) => [...ns, node]);
    setTimeout(() => bringBoxIntoView(x, y, BASE_W, BASE_H), 0);
    return newId;
  }

  function addChild(parentId: number): number {
    const parent = nodes.find((n) => n.id === parentId);
    if (!parent) return parentId;
    pushHistory();
    const newId = nodes.length ? Math.max(...nodes.map((n) => n.id)) + 1 : 1;

    let angle = getChildrenOf(parentId).length * GOLDEN_ANGLE;
    let radius = CHILD_RADIUS;
    let x = parent.x,
      y = parent.y;
    for (let i = 0; i < 96; i++) {
      x = parent.x + Math.cos(angle) * radius;
      y = parent.y + Math.sin(angle) * radius;
      if (isPositionFree(x, y, parentId)) break;
      angle += GOLDEN_ANGLE;
      if (i % 8 === 7) radius += 24;
    }

    const child: MindNode = {
      id: newId,
      label: "",
      x,
      y,
      w: BASE_W,
      h: BASE_H,
      strokeColor: parent.strokeColor,
      fillColor: parent.fillColor,
      bold: false,
    };
    setNodes((ns) => [...ns, child]);
    setEdges((es) => [
      ...es,
      { id: Date.now(), source: parentId, target: newId },
    ]);
    setTimeout(() => bringBoxIntoView(x, y, BASE_W, BASE_H), 0);
    return newId;
  }
  function addSiblingOf(nodeId: number): number {
    const parentId = getParentId(nodeId);
    if (parentId != null) return addChild(parentId);
    return addStandalone();
  }

  /** Entfernen */
  function removeEdges(ids: number[]) {
    if (!ids.length) return;
    pushHistory();
    const del = new Set(ids);
    setEdges((prev) => prev.filter((e) => !del.has(e.id)));
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

    setNodes((prev) => prev.filter((n) => !del.has(n.id)));
    setEdges((prev) =>
      prev.filter((e) => !del.has(e.source) && !del.has(e.target))
    );

    if (nextSelection != null) {
      setSelectedId(nextSelection);
      setSelectedIds(new Set([nextSelection]));
      setSelectedEdgeIds(new Set());
      setTimeout(() => {
        const n = nodes.find((x) => x.id === nextSelection);
        if (n) bringBoxIntoView(n.x, n.y, n.w, n.h);
      }, 0);
    } else {
      clearSelection();
    }
  }

  /** --- Pointer auf Node (inkl. Mehrfachauswahl) --- */
  function onPointerDownNode(
    e: React.PointerEvent<SVGGElement>,
    id: number
  ) {
    if (editingId !== null) return;

    // Shift = Link-Modus
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      if (selectedId != null && selectedId !== id) {
        pushHistory();
        ensureEdge(selectedId, id);
        selectOnly(id);
        return;
      }
      selectOnly(id);
      const src = nodes.find((n) => n.id === id)!;
      setLinking({
        phase: "pending",
        sourceId: id,
        x: src.x,
        y: src.y,
        startX: src.x,
        startY: src.y,
      });
      return;
    }

    if (linking.phase !== "idle") return;

    // Ctrl/Cmd = Mehrfachauswahl toggeln
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();

      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }

        const idsArr = Array.from(next);
        setSelectedId(idsArr[0] ?? null);
        setSelectedEdgeIds(new Set());
        freshTyping.current = true;

        return next;
      });

      return; // kein Drag bei Ctrl-Klick
    }

    const wasInSelection = selectedIds.has(id);
    freshTyping.current = true;
    if (!wasInSelection) selectOnly(id);

    const { x: px, y: py } = toWorld(e.clientX, e.clientY);

    if (selectedIds.size > 1) {
      groupDragging.current = true;
      groupStart.current = { x: px, y: py };
      groupStartPositions.current = Array.from(selectedIds).map((nid) => {
        const n = nodes.find((nn) => nn.id === nid)!;
        return { id: nid, x: n.x, y: n.y };
      });
    } else {
      draggingNodeId.current = id;
      const node = nodes.find((n) => n.id === id)!;
      dragOffset.current = { dx: node.x - px, dy: node.y - py };
      somethingMoved.current = false;
    }
  }

  /** --- SVG Pointer --- */
  function onPointerDownSvg(e: React.PointerEvent<SVGSVGElement>) {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    activeTouches.current.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
    });

    if (activeTouches.current.size === 2) {
      const pts = Array.from(activeTouches.current.values());
      const { cx, cy, d } = getCentroidAndDistance(pts);
      pinchStart.current = {
        d,
        scale,
        panX: pan.x,
        panY: pan.y,
        cx,
        cy,
      };
    }
    panning.current = activeTouches.current.size < 2;
    panStart.current = { x: e.clientX, y: e.clientY };
    panAtStart.current = { ...pan };
  }

  function onPointerMoveSvg(e: React.PointerEvent<SVGSVGElement>) {
    if (activeTouches.current.has(e.pointerId)) {
      activeTouches.current.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
      });
      if (activeTouches.current.size === 2 && pinchStart.current) {
        e.preventDefault();
        const pts = Array.from(activeTouches.current.values());
        const { cx, cy, d } = getCentroidAndDistance(pts);
        const svg = svgRef.current!;
        const rect = svg.getBoundingClientRect();

        const s0 = pinchStart.current.scale;
        let s = clamp(s0 * (d / pinchStart.current.d), 0.3, 3);
        const wx0 =
          (pinchStart.current.cx -
            rect.left -
            pinchStart.current.panX) /
          pinchStart.current.scale;
        const wy0 =
          (pinchStart.current.cy -
            rect.top -
            pinchStart.current.panY) /
          pinchStart.current.scale;

        const newPanX = cx - rect.left - wx0 * s;
        const newPanY = cy - rect.top - wy0 * s;

        setScale(s);
        setPan({ x: newPanX, y: newPanY });
        return;
      }
    }

    if (marquee.active) {
      const { x, y } = toWorld(e.clientX, e.clientY);
      setMarquee((m) => ({ ...m, x2: x, y2: y }));
      return;
    }
    if (linking.phase === "pending" || linking.phase === "active") {
      const { x, y } = toWorld(e.clientX, e.clientY);
      const thresholdWorld = DRAG_THRESHOLD / scale;
      const moved =
        Math.hypot(x - linking.startX, y - linking.startY) >
        thresholdWorld;
      if (linking.phase === "pending" && moved)
        setLinking((l) => ({ ...l, phase: "active", x, y }));
      else if (linking.phase === "active")
        setLinking((l) => ({ ...l, x, y }));
      return;
    }
    if (groupDragging.current) {
      somethingMoved.current = true;
      const { x: px, y: py } = toWorld(e.clientX, e.clientY);
      const dx = px - groupStart.current.x;
      const dy = py - groupStart.current.y;
      const posMap = new Map(
        groupStartPositions.current.map((p) => [p.id, p])
      );
      setNodes((prev) =>
        prev.map((n) =>
          selectedIds.has(n.id)
            ? {
                ...n,
                x: posMap.get(n.id)!.x + dx,
                y: posMap.get(n.id)!.y + dy,
              }
            : n
        )
      );
      return;
    }
    if (draggingNodeId.current != null) {
      const { x: px, y: py } = toWorld(e.clientX, e.clientY);
      const id = draggingNodeId.current;
      setNodes((prev) =>
        prev.map((n) =>
          n.id === id
            ? { ...n, x: px + dragOffset.current.dx, y: py + dragOffset.current.dy }
            : n
        )
      );
      somethingMoved.current = true;
      return;
    }

    if (panning.current) {
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      setPan({
        x: panAtStart.current.x + dx,
        y: panAtStart.current.y + dy,
      });
    }
  }

  function onPointerUpSvg(e?: React.PointerEvent<SVGSVGElement>) {
    if (e) {
      activeTouches.current.delete(e.pointerId);
      if (activeTouches.current.size < 2) pinchStart.current = null;
    }
    if (marquee.active) {
      const { x1, y1, x2, y2 } = marquee;
      const minX = Math.min(x1, x2),
        maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2),
        maxY = Math.max(y1, y2);
      const ids = nodes
        .filter(
          (n) =>
            n.x >= minX &&
            n.x <= maxX &&
            n.y >= minY &&
            n.y <= maxY
        )
        .map((n) => n.id);
      selectFromArray(ids);
      setMarquee({
        active: false,
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
      });
    }
    if (
      (linking.phase === "pending" || linking.phase === "active") &&
      linking.sourceId != null
    ) {
      const targetId = findNodeAt(
        linking.x,
        linking.y,
        linking.sourceId
      );
      if (targetId) {
        const exists = edges.some(
          (ed) =>
            (ed.source === linking.sourceId &&
              ed.target === targetId) ||
            (ed.source === targetId &&
              ed.target === linking.sourceId)
        );
        if (!exists) {
          pushHistory();
          setEdges((es) => [
            ...es,
            {
              id: Date.now(),
              source: linking.sourceId!,
              target: targetId,
            },
          ]);
        }
        selectOnly(targetId);
      }
      setLinking({
        phase: "idle",
        sourceId: null,
        x: 0,
        y: 0,
        startX: 0,
        startY: 0,
      });
    }

    if (somethingMoved.current) {
      pushHistory();
    }

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
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable)
      )
        return;

      const hasNodeSel = selectedIds.size > 0;
      const hasEdgeSel = selectedEdgeIds.size > 0;

      // Undo/Redo
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        (e.key === "z" || e.key === "Z")
      ) {
        e.preventDefault();
        undo();
        return;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === "y" ||
          (e.shiftKey && (e.key === "Z" || e.key === "z")))
      ) {
        e.preventDefault();
        redo();
        return;
      }

      // Größe +/- (Shift)
      if (e.shiftKey && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        const ids = Array.from(selectedIds);
        if (ids.length) {
          pushHistory();
          setNodes((prev) =>
            prev.map((n) =>
              ids.includes(n.id)
                ? {
                    ...n,
                    w: Math.min(
                      420,
                      Math.round(n.w * 1.2)
                    ),
                    h: Math.min(
                      240,
                      Math.round(n.h * 1.15)
                    ),
                  }
                : n
            )
          );
        }
        return;
      }
      if (e.shiftKey && (e.key === "-" || e.key === "_")) {
        e.preventDefault();
        const ids = Array.from(selectedIds);
        if (ids.length) {
          pushHistory();
          setNodes((prev) =>
            prev.map((n) =>
              ids.includes(n.id)
                ? {
                    ...n,
                    w: Math.max(
                      80,
                      Math.round(n.w / 1.2)
                    ),
                    h: Math.max(
                      48,
                      Math.round(n.h / 1.15)
                    ),
                  }
                : n
            )
          );
        }
        return;
      }

      // Pfeile: Nachbarwahl
      if (
        (e.key === "ArrowUp" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight") &&
        selectedId != null
      ) {
        e.preventDefault();

        const dir =
          e.key === "ArrowUp"
            ? { x: 0, y: -1 }
            : e.key === "ArrowDown"
            ? { x: 0, y: 1 }
            : e.key === "ArrowLeft"
            ? { x: -1, y: 0 }
            : { x: 1, y: 0 };

        const cur = nodes.find((n) => n.id === selectedId);
        if (!cur) return;

        const len = Math.hypot(dir.x, dir.y) || 1;
        const ux = dir.x / len;
        const uy = dir.y / len;

        type Cand = {
          id: number;
          dist: number;
          angle: number;
        };

        const candidates: Cand[] = [];

        for (const n of nodes) {
          if (n.id === selectedId) continue;

          const vx = n.x - cur.x;
          const vy = n.y - cur.y;
          const dist = Math.hypot(vx, vy);
          if (dist === 0) continue;

          const dot = vx * ux + vy * uy;
          if (dot <= 0) continue;

          const cos = dot / dist;
          const angle = Math.acos(Math.max(-1, Math.min(1, cos)));

          candidates.push({ id: n.id, dist, angle });
        }

        if (!candidates.length) return;

        const DEG = Math.PI / 180;

        function pickWithin(maxAngleRad: number): Cand | null {
          let best: Cand | null = null;
          for (const c of candidates) {
            if (c.angle > maxAngleRad) continue;
            if (!best) {
              best = c;
              continue;
            }
            if (
              c.dist < best.dist - 1e-3 ||
              (Math.abs(c.dist - best.dist) <= 1e-3 &&
                c.angle < best.angle)
            ) {
              best = c;
            }
          }
          return best;
        }

        let best = pickWithin(30 * DEG);
        if (!best) best = pickWithin(60 * DEG);
        if (!best) {
          best = candidates.reduce((acc, c) =>
            c.angle < acc.angle ? c : acc
          );
        }

        if (best) {
          selectOnly(best.id);
          const n = nodes.find((x) => x.id === best!.id);
          if (n) bringBoxIntoView(n.x, n.y, n.w, n.h);
        }

        return;
      }

      // Enter: Child / Shift+Enter: Sibling
      if (
        e.key === "Enter" &&
        selectedId != null &&
        selectedIds.size === 1 &&
        !e.shiftKey
      ) {
        e.preventDefault();
        const newId = addChild(selectedId);
        selectOnly(newId);
        freshTyping.current = true;
        return;
      }
      if (
        e.key === "Enter" &&
        e.shiftKey &&
        selectedId != null &&
        selectedIds.size === 1
      ) {
        e.preventDefault();
        const newId = addSiblingOf(selectedId);
        selectOnly(newId);
        freshTyping.current = true;
        return;
      }

      // Escape: Auswahl löschen
      if (e.key === "Escape") {
        clearSelection();
        return;
      }

      // Shift+Backspace oder Delete: löschen
      if (
        (e.key === "Backspace" && e.shiftKey) ||
        e.key === "Delete"
      ) {
        e.preventDefault();
        if (hasNodeSel) removeNodes(Array.from(selectedIds));
        else if (hasEdgeSel) removeEdges(Array.from(selectedEdgeIds));
        return;
      }

      // Backspace: Text löschen (bei 1 Knoten), mehrere → löschen
      if (e.key === "Backspace") {
        e.preventDefault();
        const ids = Array.from(selectedIds);
        if (ids.length > 1) {
          removeNodes(ids);
          return;
        }
        if (ids.length === 1) {
          const id = ids[0];
          pushHistory();
          setNodes((prev) =>
            prev.map((n) => {
              if (n.id !== id) return n;
              const next = n.label.slice(
                0,
                Math.max(0, n.label.length - 1)
              );
              return resizeNodeForLabel({ ...n, label: next });
            })
          );
        }
        return;
      }

      // Shift+Tab: nach oben (Parent). Am Root angekommen → wieder nach unten.
      if (
        e.key === "Tab" &&
        e.shiftKey &&
        selectedId != null &&
        selectedIds.size === 1
      ) {
        e.preventDefault();

        if (
          !shiftTabPathRef.current ||
          shiftTabPathRef.current.indexOf(selectedId) === -1
        ) {
          const path = buildRootPath(selectedId);
          shiftTabPathRef.current = path;
          shiftTabIndexRef.current = path.length - 1;
        }

        const path = shiftTabPathRef.current!;
        let idx = shiftTabIndexRef.current;

        if (idx > 0) {
          idx = idx - 1;
        } else {
          if (idx < path.length - 1) {
            idx = idx + 1;
          } else {
            return;
          }
        }

        shiftTabIndexRef.current = idx;
        const nextId = path[idx];
        selectOnly(nextId);
        const n = nodes.find((x) => x.id === nextId);
        if (n) bringBoxIntoView(n.x, n.y, n.w, n.h);
        return;
      }

      // Tab: zum vorher markierten Knoten springen
      if (
        e.key === "Tab" &&
        !e.shiftKey &&
        selectedId != null &&
        selectedIds.size === 1
      ) {
        e.preventDefault();
        const prevId = prevSelectedIdRef.current;

        if (prevId == null || prevId === selectedId) return;
        if (!nodes.some((n) => n.id === prevId)) return;

        selectOnly(prevId);
        const n = nodes.find((x) => x.id === prevId);
        if (n) bringBoxIntoView(n.x, n.y, n.w, n.h);
        return;
      }

      // Tippen: Text in Knoten/Kante
      if (
        e.key.length === 1 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        const char = e.key;

        if (selectedEdgeIds.size) {
          pushHistory();
          const replaceAll = freshTyping.current;
          setEdges((prev) =>
            prev.map((ed) => {
              if (!selectedEdgeIds.has(ed.id)) return ed;
              const cur = ed.label ?? "";
              const next = replaceAll ? char : cur + char;
              return { ...ed, label: next };
            })
          );
          freshTyping.current = false;
          return;
        }

        if (selectedIds.size >= 1) {
          pushHistory();
          const ids = Array.from(selectedIds);
          const replaceAll = freshTyping.current;
          setNodes((prev) =>
            prev.map((n) => {
              if (!ids.includes(n.id)) return n;
              const nextText = replaceAll ? char : n.label + char;
              return resizeNodeForLabel({
                ...n,
                label: nextText,
              });
            })
          );
          freshTyping.current = false;
          return;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    selectedId,
    selectedIds,
    selectedEdgeIds,
    editingId,
    linking.phase,
    edges,
    nodes,
    pan,
    scale,
  ]);

  /** Hintergrund-Interaktionen */
  function onPointerDownBg(e: React.PointerEvent<SVGRectElement>) {
    if (editingId != null) setEditingId(null);
    if (linking.phase !== "idle") return;

    if (e.shiftKey) {
      e.preventDefault();
      const { x, y } = toWorld(e.clientX, e.clientY);
      setMarquee({
        active: true,
        x1: x,
        y1: y,
        x2: x,
        y2: y,
      });
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

    setPan((prev) => ({
      x: prev.x - e.deltaX,
      y: prev.y - e.deltaY,
    }));
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
          "Inter, system-ui, -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif",
        WebkitFontSmoothing: "antialiased",
      }}
      onClick={() => {
        if (contextMenu.open)
          setContextMenu({ ...contextMenu, open: false });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const w = toWorld(e.clientX, e.clientY);
        setContextMenu({
          open: true,
          x: e.clientX,
          y: e.clientY,
          wx: w.x,
          wy: w.y,
          kind: "bg",
        });
      }}
    >
      {/* kleine Toolbar fürs Speichern/Laden */}
      <div
        style={{
          position: "fixed",
          top: 5,
          left: 5,
          zIndex: 1500,
          display: "flex",
          gap: 10,
          background: "rgba(255,255,255,0.9)",
          padding: "5px 5px",
          borderRadius: 10,
          boxShadow: "0 4px 12px rgba(0,0,0,.12)",
          border: "1px solid rgba(0,0,0,.06)",
          backdropFilter: "blur(6px)",
        }}
      >
        <button
          onClick={exportToFile}
          style={{
            padding: "4px 5px",
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
            background: "transparent",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="currentColor"
          >
            <path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
            <path
              d="M12 8v6m0 0l-3-3m3 3l3-3"
              stroke="white"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          style={{
            padding: "4px 5px",
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
            background: "transparent",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="currentColor"
          >
            <path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
            <path
              d="M12 16V10m0 0l-3 3m3-3l3 3"
              stroke="white"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
      </div>

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
        shapeRendering="geometricPrecision"
        textRendering="geometricPrecision"
        style={{
          touchAction: "none",
          background: "#ffffff",
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
          <pattern
            id="dotGrid"
            width="32"
            height="32"
            patternUnits="userSpaceOnUse"
          >
            <rect
              x="0"
              y="0"
              width="2"
              height="2"
              fill="#cbd5e1"
              opacity="0.7"
              shapeRendering="crispEdges"
            />
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
              setContextMenu({
                open: true,
                x: e.clientX,
                y: e.clientY,
                wx: w.x,
                wy: w.y,
                kind: "bg",
              });
            }}
          />

          {/* Kanten */}
          {edges.map((e) => {
            const s = nodes.find((n) => n.id === e.source);
            const t = nodes.find((n) => n.id === e.target);
            if (!s || !t) return null;

            const highlightedNodeSide =
              selectedIds.has(e.source) ||
              selectedIds.has(e.target);
            const isEdgeSelected = selectedEdgeIds.has(e.id);

            const stroke = isEdgeSelected
              ? "#1976d2"
              : highlightedNodeSide
              ? "#1976d2"
              : "#888";
            const strokeWidth = isEdgeSelected
              ? 3
              : highlightedNodeSide
              ? 2.5
              : 1.5;
            const dash = e.dashed ? "8 6" : undefined;

            const onEdgePointerDown = (
              evt:
                | React.PointerEvent<SVGLineElement>
                | React.PointerEvent<SVGPathElement>
            ) => {
              evt.stopPropagation();
              setSelectedIds(new Set());
              setSelectedId(null);
              setSelectedEdgeIds((prev) => {
                const next = new Set(prev);
                if (evt.shiftKey) {
                  if (next.has(e.id)) next.delete(e.id);
                  else next.add(e.id);
                } else {
                  next.clear();
                  next.add(e.id);
                }
                return next;
              });
              freshTyping.current = true;
            };

            const mx = (s.x + t.x) / 2;
            const my = (s.y + t.y) / 2;

            return (
              <g key={e.id}>
                {/* breiter Hit-Bereich */}
                <line
                  x1={s.x}
                  y1={s.y}
                  x2={t.x}
                  y2={t.y}
                  stroke="transparent"
                  strokeWidth={Math.max(12 / scale, 6)}
                  onPointerDown={onEdgePointerDown}
                  onContextMenu={(evt) => {
                    evt.preventDefault();
                    evt.stopPropagation();
                    setSelectedIds(new Set());
                    setSelectedId(null);
                    setSelectedEdgeIds(new Set([e.id]));
                    setContextMenu({
                      open: true,
                      x: evt.clientX,
                      y: evt.clientY,
                      kind: "edge",
                      targetEdgeId: e.id,
                    });
                  }}
                />
                <line
                  x1={s.x}
                  y1={s.y}
                  x2={t.x}
                  y2={t.y}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  strokeDasharray={dash}
                  vectorEffect="non-scaling-stroke"
                />
                {e.label && (
                  <g pointerEvents="none">
                    <rect
                      x={mx - e.label.length * 6}
                      y={my - 10}
                      width={Math.max(24, e.label.length * 12)}
                      height={20}
                      rx={6}
                      ry={6}
                      fill="rgba(255,255,255,0.95)"
                      stroke="rgba(15,23,42,0.08)"
                      strokeWidth={0.5}
                      vectorEffect="non-scaling-stroke"
                    />
                    <text
                      x={mx}
                      y={my + 5}
                      textAnchor="middle"
                      fontSize={12}
                      fill={isEdgeSelected ? "#1976d2" : "#0f172a"}
                    >
                      {e.label}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* temporäre Kante */}
          {linking.phase === "active" &&
            linking.sourceId != null &&
            (() => {
              const s = nodes.find(
                (n) => n.id === linking.sourceId
              )!;
              return (
                <line
                  x1={s.x}
                  y1={s.y}
                  x2={linking.x}
                  y2={linking.y}
                  stroke="#1976d2"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })()}

          {/* Knoten */}
          {nodes.map((n) => {
            const isEditing = editingId === n.id;
            const isSelected = selectedIds.has(n.id);

            const baseFont = clamp(
              Math.round(n.h * 0.35),
              12,
              20
            );
            const displayText = isEditing ? editingText : n.label;
            const L = layoutLabel(displayText, baseFont, n.w);
            const textLines = L.lines;

            const corner = Math.round(
              Math.min(n.w, n.h) * 0.24
            );
            const stroke = isSelected
              ? "#1976d2"
              : n.strokeColor || "#0f172a";
            const strokeW = isSelected ? 2.5 : 1.5;

            const startY =
              -((textLines.length - 1) / 2) * L.lineHeight;

            return (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                onPointerDown={(e) => onPointerDownNode(e, n.id)}
                onDoubleClick={() => {
                  selectOnly(n.id);
                  freshTyping.current = true;
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();

                  // Mehrfachauswahl behalten, falls Node schon selektiert ist
                  if (!selectedIds.has(n.id)) {
                    selectOnly(n.id);
                  }

                  setContextMenu({
                    open: true,
                    x: e.clientX,
                    y: e.clientY,
                    kind: "node",
                    targetNodeId: n.id,
                  });
                }}
              >
                {/* Box */}
                <rect
                  x={-n.w / 2}
                  y={-n.h / 2}
                  width={n.w}
                  height={n.h}
                  rx={corner}
                  ry={corner}
                  fill="#ffffff"
                />
                {n.fillColor && (
                  <rect
                    x={-n.w / 2}
                    y={-n.h / 2}
                    width={n.w}
                    height={n.h}
                    rx={corner}
                    ry={corner}
                    fill={n.fillColor}
                  />
                )}
                <rect
                  x={-n.w / 2}
                  y={-n.h / 2}
                  width={n.w}
                  height={n.h}
                  rx={corner}
                  ry={corner}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={strokeW}
                  vectorEffect="non-scaling-stroke"
                />

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
                      fontWeight={n.bold ? 700 : 500}
                      fill={isSelected ? "#0f172a" : "#111827"}
                    >
                      {line}
                    </text>
                  ))}
                </g>

                {/* Unsichtbares Input */}
                {isEditing && (
                  <foreignObject
                    x={-n.w / 2 + 8}
                    y={-n.h / 2 + 6}
                    width={n.w - 16}
                    height={n.h - 12}
                  >
                    <input
                      ref={editInputRef}
                      value={editingText}
                      onChange={(e) => {
                        const v = e.target.value;
                        setEditingText(v);
                        if (editingId != null) {
                          pushHistory();
                          setNodes((prev) =>
                            prev.map((nn) =>
                              nn.id === editingId
                                ? resizeNodeForLabel({
                                    ...nn,
                                    label: v,
                                  })
                                : nn
                            )
                          );
                        }
                      }}
                      onBlur={() => setEditingId(null)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") setEditingId(null);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      style={{
                        width: "100%",
                        height: "100%",
                        border: "none",
                        background: "transparent",
                        color: "transparent",
                        caretColor: isSelected
                          ? "#1976d2"
                          : "#000",
                        padding: 0,
                        margin: 0,
                        fontSize: L.fontSize,
                        lineHeight: `${L.lineHeight}px`,
                        textAlign: "center",
                        outline: "none",
                        fontFamily:
                          "Inter, system-ui, -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif",
                      }}
                    />
                  </foreignObject>
                )}
              </g>
            );
          })}

          {/* Marquee */}
          {marquee.active &&
            (() => {
              const { x1, y1, x2, y2 } = marquee;
              const x = Math.min(x1, x2);
              const y = Math.min(y1, y2);
              const w = Math.abs(x2 - x1);
              const h = Math.abs(y2 - y1);
              return (
                <rect
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  fill="#93c5fd"
                  fillOpacity={0.18}
                  stroke="#2563eb"
                  strokeDasharray="6 4"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })()}
        </g>
      </svg>

      {/* Rechtsklick-Menü */}
      {contextMenu.open && (
        <div
          style={{
            position: "fixed",
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 2000,
            background: "#ffffff",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(15,23,42,.18)",
            padding: 6,
            minWidth: 240,
            border: "1px solid rgba(15,23,42,.06)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Hintergrund */}
          {contextMenu.kind === "bg" && (
            <>
              <MenuItem
                label="➕ New Node"
                onClick={() => {
                  const id =
                    contextMenu.wx != null &&
                    contextMenu.wy != null
                      ? addStandalone({
                          x: contextMenu.wx,
                          y: contextMenu.wy,
                        })
                      : addStandalone();
                  selectOnly(id);
                  setContextMenu({
                    ...contextMenu,
                    open: false,
                  });
                }}
              />

              <div
                style={{
                  height: 1,
                  background: "rgba(15,23,42,.08)",
                  margin: "6px 0",
                }}
              />
              <div style={{ padding: "6px 10px" }}>
                <div
                  style={{
                    fontSize: 12,
                    opacity: 0.7,
                    marginBottom: 6,
                  }}
                >
                  Color
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  {[
                    { name: "Blue", color: "#90caf9" },
                    { name: "Green", color: "#a5d6a7" },
                    { name: "Yellow", color: "#ffe082" },
                    { name: "Red", color: "#ef9a9a" },
                  ].map((p) => (
                    <button
                      key={`bg-${p.color}`}
                      onClick={() => {
                        const ids = Array.from(selectedIds);
                        if (!ids.length) return;
                        const rgba = hexToRgba60(p.color);
                        pushHistory();
                        setNodes((prev) =>
                          prev.map((n) =>
                            ids.includes(n.id)
                              ? { ...n, fillColor: rgba }
                              : n
                          )
                        );
                        setContextMenu({
                          ...contextMenu,
                          open: false,
                        });
                      }}
                      style={{
                        width: 28,
                        height: 28,
                        border: "none",
                        background: "transparent",
                        padding: 0,
                        cursor: selectedIds.size
                          ? "pointer"
                          : "not-allowed",
                      }}
                    >
                      <span
                        style={{
                          display: "block",
                          width: 24,
                          height: 24,
                          borderRadius: 8,
                          background: p.color,
                        }}
                      />
                    </button>
                  ))}
                  <button
                    disabled={selectedIds.size === 0}
                    onClick={() => {
                      const ids = Array.from(selectedIds);
                      if (!ids.length) return;
                      pushHistory();
                      setNodes((prev) =>
                        prev.map((n) =>
                          ids.includes(n.id)
                            ? { ...n, fillColor: undefined }
                            : n
                        )
                      );
                      setContextMenu({
                        ...contextMenu,
                        open: false,
                      });
                    }}
                    style={{
                      background: "#e5e7eb",
                      color: "#111827",
                      border: "none",
                      padding: "6px 10px",
                      borderRadius: 8,
                      cursor: selectedIds.size
                        ? "pointer"
                        : "not-allowed",
                      fontSize: 12,
                    }}
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div
                style={{
                  height: 1,
                  background: "rgba(15,23,42,.08)",
                  margin: "6px 0",
                }}
              />
              <MenuItem
                label="🗑️ Delete"
                onClick={() => {
                  if (selectedIds.size > 0)
                    removeNodes(Array.from(selectedIds));
                  else if (selectedEdgeIds.size > 0)
                    removeEdges(Array.from(selectedEdgeIds));
                  setContextMenu({
                    ...contextMenu,
                    open: false,
                  });
                }}
                disabled={
                  selectedIds.size === 0 &&
                  selectedEdgeIds.size === 0
                }
              />
            </>
          )}

          {/* Knoten */}
          {contextMenu.kind === "node" && (
            <>
              <MenuItem
                label="✏️ Rename"
                onClick={() => {
                  if (contextMenu.targetNodeId != null) {
                    setEditingId(contextMenu.targetNodeId);
                    setEditingText(
                      nodes.find(
                        (n) =>
                          n.id === contextMenu.targetNodeId
                      )?.label || ""
                    );
                  }
                  setContextMenu({
                    ...contextMenu,
                    open: false,
                  });
                }}
              />
              <MenuItem
                label="➕ Child"
                onClick={() => {
                  if (contextMenu.targetNodeId != null) {
                    const id = addChild(contextMenu.targetNodeId);
                    selectOnly(id);
                  }
                  setContextMenu({
                    ...contextMenu,
                    open: false,
                  });
                }}
              />
              <MenuItem
                label="➕ Sibling"
                onClick={() => {
                  if (contextMenu.targetNodeId != null) {
                    const id = addSiblingOf(
                      contextMenu.targetNodeId
                    );
                    selectOnly(id);
                  }
                  setContextMenu({
                    ...contextMenu,
                    open: false,
                  });
                }}
              />
              <MenuItem
                label="⭐ Highlight"
                onClick={() => {
                  if (contextMenu.targetNodeId != null) {
                    const id = contextMenu.targetNodeId;
                    pushHistory();
                    setNodes((prev) =>
                      prev.map((n) =>
                        n.id === id
                          ? { ...n, bold: !n.bold }
                          : n
                      )
                    );
                  }
                  setContextMenu({
                    ...contextMenu,
                    open: false,
                  });
                }}
              />
              <div
                style={{
                  height: 1,
                  background: "rgba(15,23,42,.08)",
                  margin: "6px 0",
                }}
              />

              <div style={{ padding: "6px 10px" }}>
                <div
                  style={{
                    fontSize: 12,
                    opacity: 0.7,
                    marginBottom: 6,
                  }}
                >
                  Color
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  {[
                    { name: "Blue", color: "#90caf9" },
                    { name: "Green", color: "#a5d6a7" },
                    { name: "Yellow", color: "#ffe082" },
                    { name: "Red", color: "#ef9a9a" },
                  ].map((p) => (
                    <button
                      key={p.color}
                      title={p.name}
                      onClick={() => {
                        const ids =
                          selectedIds.size > 0
                            ? Array.from(selectedIds)
                            : contextMenu.targetNodeId != null
                            ? [contextMenu.targetNodeId]
                            : [];

                        if (!ids.length) return;

                        const rgba = hexToRgba60(p.color);
                        pushHistory();
                        setNodes((prev) =>
                          prev.map((n) =>
                            ids.includes(n.id)
                              ? { ...n, fillColor: rgba }
                              : n
                          )
                        );
                        setContextMenu({
                          ...contextMenu,
                          open: false,
                        });
                      }}
                      style={{
                        width: 28,
                        height: 28,
                        border: "none",
                        background: "transparent",
                        padding: 0,
                        cursor: "pointer",
                      }}
                    >
                      <span
                        style={{
                          display: "block",
                          width: 24,
                          height: 24,
                          borderRadius: 8,
                          background: p.color,
                        }}
                      />
                    </button>
                  ))}

                  <button
                    onClick={() => {
                      const ids =
                        selectedIds.size > 0
                          ? Array.from(selectedIds)
                          : contextMenu.targetNodeId != null
                          ? [contextMenu.targetNodeId]
                          : [];

                      if (!ids.length) return;

                      pushHistory();
                      setNodes((prev) =>
                        prev.map((n) =>
                          ids.includes(n.id)
                            ? { ...n, fillColor: undefined }
                            : n
                        )
                      );
                      setContextMenu({
                        ...contextMenu,
                        open: false,
                      });
                    }}
                    style={{
                      background: "#e5e7eb",
                      color: "#111827",
                      border: "none",
                      padding: "6px 10px",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  >
                    No Color
                  </button>
                </div>
              </div>

              <div
                style={{
                  height: 1,
                  background: "rgba(15,23,42,.08)",
                  margin: "6px 0",
                }}
              />
              <MenuItem
                label="🗑️ Delete"
                onClick={() => {
                  if (contextMenu.targetNodeId != null)
                    removeNodes([contextMenu.targetNodeId]);
                  setContextMenu({
                    ...contextMenu,
                    open: false,
                  });
                }}
              />
            </>
          )}

          {/* Kante */}
          {contextMenu.kind === "edge" && (
            <>
              <MenuItem
                label="╌╌╌ Toggle dashed"
                onClick={() => {
                  if (contextMenu.targetEdgeId != null) {
                    const id = contextMenu.targetEdgeId;
                    pushHistory();
                    setEdges((prev) =>
                      prev.map((ed) =>
                        ed.id === id
                          ? { ...ed, dashed: !ed.dashed }
                          : ed
                      )
                    );
                  }
                  setContextMenu({
                    ...contextMenu,
                    open: false,
                  });
                }}
              />
              <MenuItem
                label="✏️ Rename edge"
                onClick={() => {
                  if (contextMenu.targetEdgeId != null) {
                    const ed = edges.find(
                      (x) =>
                        x.id === contextMenu.targetEdgeId
                    );
                    const cur = ed?.label ?? "";
                    const next = window.prompt(
                      "Label for edge:",
                      cur
                    );
                    if (next !== null) {
                      pushHistory();
                      const id = contextMenu.targetEdgeId;
                      setEdges((prev) =>
                        prev.map((e) =>
                          e.id === id
                            ? {
                                ...e,
                                label:
                                  next.trim() || undefined,
                              }
                            : e
                        )
                      );
                    }
                  }
                  setContextMenu({
                    ...contextMenu,
                    open: false,
                  });
                }}
              />
              <div
                style={{
                  height: 1,
                  background: "rgba(15,23,42,.08)",
                  margin: "6px 0",
                }}
              />
              <MenuItem
                label="🗑️ Delete edge"
                onClick={() => {
                  if (contextMenu.targetEdgeId != null)
                    removeEdges([contextMenu.targetEdgeId]);
                  setContextMenu({
                    ...contextMenu,
                    open: false,
                  });
                }}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** --- MenuItem-Helper --- */
function MenuItem({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        width: "100%",
        textAlign: "left",
        padding: "8px 12px",
        border: "none",
        background: "transparent",
        cursor: disabled ? "not-allowed" : "pointer",
        borderRadius: 8,
        color: disabled ? "#9ca3af" : "#0f172a",
        fontSize: 13,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background =
          "rgba(37,99,235,.08)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background =
          "transparent";
      }}
    >
      {label}
    </button>
  );
}

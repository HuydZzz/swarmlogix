import { useState, useEffect, useRef, useCallback } from "react";

// ─── SIMULATION CONSTANTS ───
const MAP_W = 820;
const MAP_H = 500;
const AGENT_TYPES = {
  drone: { icon: "◈", color: "#FF6B00", speed: 3.5, capacity: 2, range: 180, label: "DRONE" },
  robot: { icon: "◉", color: "#FFFFFF", speed: 1.2, capacity: 5, range: 90, label: "ROBOT AMR" },
  bike: { icon: "◆", color: "#FF9D45", speed: 2.5, capacity: 8, range: 250, label: "E-BIKE" },
};
const VENDORS = ["RoyalFleet", "SwiftBot", "AeroLink", "UrbanFleet", "NexDrone"];
const ZONES = [
  { name: "CAMDEN", x: 100, y: 80, w: 200, h: 150 },
  { name: "CANARY WHARF", x: 380, y: 60, w: 220, h: 160 },
  { name: "GREENWICH", x: 500, y: 280, w: 200, h: 180 },
  { name: "SHOREDITCH", x: 80, y: 300, w: 220, h: 170 },
];

const uid = () => Math.random().toString(36).slice(2, 8);
const dist = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

// ─── SIMULATION ENGINE ───
class SwarmEngine {
  constructor() {
    this.agents = [];
    this.orders = [];
    this.auctions = [];
    this.handoffs = [];
    this.connections = [];
    this.eventLog = [];
    this.tick = 0;
    this.stats = { delivered: 0, auctionsRun: 0, handoffsCompleted: 0, heals: 0, alerts: 0 };
    this.paused = false;
    this.safetyZone = null;
  }

  init(count = 15) {
    this.agents = [];
    for (let i = 0; i < count; i++) {
      const typeKey = pick(Object.keys(AGENT_TYPES));
      const t = AGENT_TYPES[typeKey];
      this.agents.push({
        id: uid(), type: typeKey, vendor: pick(VENDORS),
        x: rand(40, MAP_W - 40), y: rand(40, MAP_H - 40),
        targetX: null, targetY: null, battery: rand(60, 100),
        capacity: t.capacity, load: 0, speed: t.speed * rand(0.85, 1.15),
        range: t.range, status: "idle", orderId: null,
        discoveredPeers: [], safetyMode: false,
      });
    }
    this.log("SYSTEM", `Swarm initialized: ${count} agents across ${VENDORS.length} vendors`);
    return this;
  }

  log(source, message, type = "info") {
    this.eventLog.unshift({ tick: this.tick, source, message, type, ts: Date.now() });
    if (this.eventLog.length > 120) this.eventLog.length = 120;
  }

  runDiscovery() {
    this.connections = [];
    for (const a of this.agents) {
      if (a.status === "offline") continue;
      a.discoveredPeers = [];
      for (const b of this.agents) {
        if (a.id === b.id || b.status === "offline") continue;
        if (dist(a, b) < a.range) {
          a.discoveredPeers.push(b.id);
          this.connections.push({ from: a.id, to: b.id, strength: 1 - dist(a, b) / a.range });
        }
      }
    }
  }

  maybeSpawnOrder() {
    if (this.orders.filter(o => o.status === "pending").length >= 5) return;
    if (Math.random() > 0.025) return;
    const order = {
      id: uid(), pickupX: rand(60, MAP_W - 60), pickupY: rand(60, MAP_H - 60),
      deliverX: rand(60, MAP_W - 60), deliverY: rand(60, MAP_H - 60),
      weight: rand(0.5, 6), status: "pending", assignedAgent: null,
      handoffAgent: null, createdAt: this.tick,
    };
    this.orders.push(order);
    this.log("ORDER", `New order ${order.id.slice(0, 4)} — ${order.weight.toFixed(1)}kg`, "order");
  }

  runAuctions() {
    const pending = this.orders.filter(o => o.status === "pending");
    for (const order of pending) {
      const candidates = this.agents.filter(a =>
        a.status === "idle" && !a.safetyMode && a.capacity >= order.weight &&
        a.battery > 20 && dist(a, { x: order.pickupX, y: order.pickupY }) < a.range * 1.5
      );
      if (candidates.length < 1) continue;
      order.status = "auctioning";
      const bids = candidates.map(a => {
        const d = dist(a, { x: order.pickupX, y: order.pickupY });
        const score = (1 - d / (a.range * 1.5)) * 0.4 + (a.battery / 100) * 0.3 + (1 - a.load / a.capacity) * 0.3;
        return { agent: a, score, dist: d };
      });
      bids.sort((a, b) => b.score - a.score);
      const winner = bids[0];
      this.auctions.unshift({
        id: uid(), orderId: order.id, tick: this.tick, winnerId: winner.agent.id,
        bids: bids.map(b => ({ agentId: b.agent.id, score: b.score.toFixed(3), vendor: b.agent.vendor })),
      });
      if (this.auctions.length > 30) this.auctions.length = 30;
      winner.agent.status = "delivering";
      winner.agent.orderId = order.id;
      winner.agent.targetX = order.pickupX;
      winner.agent.targetY = order.pickupY;
      winner.agent.load = order.weight;
      order.status = "assigned";
      order.assignedAgent = winner.agent.id;
      this.stats.auctionsRun++;
      this.log("AUCTION", `Order ${order.id.slice(0, 4)}: ${bids.length} bids → ${winner.agent.vendor}/${winner.agent.type} wins (${winner.score.toFixed(2)})`, "auction");
    }
  }

  moveAgents() {
    for (const a of this.agents) {
      if (a.status === "offline" || a.safetyMode) continue;
      a.battery = Math.max(0, a.battery - 0.008);
      if (a.battery <= 0) { this.triggerAgentFailure(a, "battery_dead"); continue; }
      if (a.targetX != null && a.targetY != null) {
        const d = dist(a, { x: a.targetX, y: a.targetY });
        if (d < a.speed * 1.5) { a.x = a.targetX; a.y = a.targetY; this.onArrival(a); }
        else {
          const angle = Math.atan2(a.targetY - a.y, a.targetX - a.x);
          a.x = clamp(a.x + Math.cos(angle) * a.speed, 10, MAP_W - 10);
          a.y = clamp(a.y + Math.sin(angle) * a.speed, 10, MAP_H - 10);
        }
      } else if (a.status === "idle" && Math.random() < 0.01) {
        a.targetX = clamp(a.x + rand(-100, 100), 20, MAP_W - 20);
        a.targetY = clamp(a.y + rand(-100, 100), 20, MAP_H - 20);
      }
    }
  }

  onArrival(a) {
    const order = this.orders.find(o => o.id === a.orderId);
    if (!order) { a.targetX = null; a.targetY = null; a.status = "idle"; return; }
    if (order.status === "assigned") {
      order.status = "in_transit"; a.targetX = order.deliverX; a.targetY = order.deliverY;
      this.log("DELIVER", `${a.vendor}/${a.type} picked up order ${order.id.slice(0, 4)}`, "deliver");
      const totalDist = dist({ x: order.pickupX, y: order.pickupY }, { x: order.deliverX, y: order.deliverY });
      if (totalDist > a.range * 0.8 || (a.type === "drone" && Math.random() < 0.3)) this.initiateHandoff(a, order);
    } else if (order.status === "in_transit" || order.status === "handoff") {
      order.status = "delivered"; a.status = "idle"; a.orderId = null; a.load = 0;
      a.targetX = null; a.targetY = null; this.stats.delivered++;
      this.log("DELIVER", `✓ Order ${order.id.slice(0, 4)} delivered by ${a.vendor}/${a.type}`, "success");
    }
  }

  initiateHandoff(fromAgent, order) {
    const midX = (fromAgent.x + order.deliverX) / 2, midY = (fromAgent.y + order.deliverY) / 2;
    const candidates = this.agents.filter(a =>
      a.id !== fromAgent.id && a.status === "idle" && !a.safetyMode &&
      a.capacity >= order.weight && dist(a, { x: midX, y: midY }) < 200
    );
    if (!candidates.length) return;
    const relay = candidates.sort((a, b) => dist(a, { x: order.deliverX, y: order.deliverY }) - dist(b, { x: order.deliverX, y: order.deliverY }))[0];
    const t = 0.4 + Math.random() * 0.2;
    const hx = lerp(fromAgent.x, order.deliverX, t), hy = lerp(fromAgent.y, order.deliverY, t);
    fromAgent.targetX = hx; fromAgent.targetY = hy;
    order.status = "handoff"; order.handoffAgent = relay.id;
    this.handoffs.push({ id: uid(), orderId: order.id, from: fromAgent.id, to: relay.id, x: hx, y: hy, tick: this.tick, status: "pending" });
    setTimeout(() => {
      if (order.status !== "handoff") return;
      relay.status = "delivering"; relay.orderId = order.id; relay.targetX = hx; relay.targetY = hy;
      relay.load = order.weight; order.status = "in_transit"; order.assignedAgent = relay.id;
      const hf = this.handoffs.find(h => h.orderId === order.id && h.status === "pending");
      if (hf) hf.status = "completed";
      this.stats.handoffsCompleted++;
      fromAgent.status = "idle"; fromAgent.orderId = null; fromAgent.load = 0; fromAgent.targetX = null; fromAgent.targetY = null;
      this.log("HANDOFF", `${fromAgent.vendor}/${fromAgent.type} → ${relay.vendor}/${relay.type} for ${order.id.slice(0, 4)}`, "handoff");
    }, 800);
  }

  triggerAgentFailure(agent, reason = "random") {
    if (agent.status === "offline") return;
    const hadOrder = agent.orderId;
    agent.status = "offline";
    const order = this.orders.find(o => o.id === hadOrder);
    this.log("FAULT", `⚠ ${agent.vendor}/${agent.type} offline (${reason})`, "error");
    if (order && order.status !== "delivered") {
      order.status = "pending"; order.assignedAgent = null; this.stats.heals++;
      this.log("HEAL", `Re-auctioning order ${order.id.slice(0, 4)}`, "heal");
    }
    agent.orderId = null; agent.load = 0; agent.targetX = null; agent.targetY = null;
    setTimeout(() => {
      agent.status = "idle"; agent.battery = rand(40, 70);
      this.log("HEAL", `${agent.vendor}/${agent.type} recovered (${agent.battery.toFixed(0)}%)`, "heal");
    }, rand(3000, 6000));
  }

  maybeFailAgent() {
    if (Math.random() > 0.004) return;
    const alive = this.agents.filter(a => a.status !== "offline");
    if (alive.length < 5) return;
    this.triggerAgentFailure(pick(alive), pick(["network_loss", "hardware_fault", "battery_critical"]));
  }

  triggerSafetyAlert(x, y, radius = 120) {
    this.safetyZone = { x, y, radius, startTick: this.tick };
    this.stats.alerts++;
    let frozen = 0;
    for (const a of this.agents) {
      if (a.status === "offline") continue;
      if (dist(a, { x, y }) < radius) { a.safetyMode = true; a.targetX = null; a.targetY = null; frozen++; }
    }
    this.log("SAFETY", `Safety mesh propagated — ${frozen} agents frozen`, "safety");
    setTimeout(() => {
      for (const a of this.agents) a.safetyMode = false;
      this.safetyZone = null;
      this.log("SAFETY", `Alert cleared — swarm resuming`, "safety");
    }, 4000);
  }

  maybeSafetyEvent() {
    if (Math.random() > 0.001 || this.safetyZone) return;
    this.triggerSafetyAlert(rand(100, MAP_W - 100), rand(100, MAP_H - 100), rand(80, 150));
  }

  update() {
    if (this.paused) return;
    this.tick++;
    this.runDiscovery();
    this.maybeSpawnOrder();
    this.runAuctions();
    this.moveAgents();
    this.maybeFailAgent();
    this.maybeSafetyEvent();
    this.orders = this.orders.filter(o => o.status !== "delivered" || this.tick - o.createdAt < 600);
  }
}

// ─── TASHI BRAND CONSTANTS ───
const O = "#FF6B00";
const MONO = "'Space Mono', 'Courier New', monospace";

// ─── MAP RENDERER ───
const SwarmMap = ({ engine }) => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = MAP_W * dpr;
    canvas.height = MAP_H * dpr;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#0A0A0A";
    ctx.fillRect(0, 0, MAP_W, MAP_H);

    // Dot grid
    for (let x = 20; x < MAP_W; x += 28) {
      for (let y = 20; y < MAP_H; y += 28) {
        ctx.beginPath();
        ctx.arc(x, y, 0.6, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,107,0,0.07)`;
        ctx.fill();
      }
    }

    // Zones
    for (const z of ZONES) {
      ctx.fillStyle = "rgba(255,107,0,0.015)";
      ctx.strokeStyle = "rgba(255,107,0,0.1)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.rect(z.x, z.y, z.w, z.h);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255,107,0,0.25)";
      ctx.font = `bold 8px ${MONO}`;
      ctx.fillText(z.name, z.x + 8, z.y + 15);
    }

    // Safety zone
    if (engine.safetyZone) {
      const sz = engine.safetyZone;
      const pulse = 0.3 + 0.2 * Math.sin(engine.tick * 0.15);
      ctx.beginPath();
      ctx.arc(sz.x, sz.y, sz.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,107,0,${pulse * 0.1})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(255,107,0,${pulse * 0.8})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = O;
      ctx.font = `bold 10px ${MONO}`;
      ctx.textAlign = "center";
      ctx.fillText("SAFETY ZONE", sz.x, sz.y - sz.radius - 6);
      ctx.textAlign = "start";
    }

    // Mesh connections
    for (const conn of engine.connections) {
      const from = engine.agents.find(a => a.id === conn.from);
      const to = engine.agents.find(a => a.id === conn.to);
      if (!from || !to) continue;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = `rgba(255,107,0,${conn.strength * 0.055})`;
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }

    // Orders
    for (const o of engine.orders) {
      if (o.status === "delivered") continue;
      ctx.beginPath();
      ctx.arc(o.pickupX, o.pickupY, 4, 0, Math.PI * 2);
      ctx.fillStyle = o.status === "pending" ? O : "rgba(255,107,0,0.25)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(o.deliverX, o.deliverY, 3, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(o.pickupX, o.pickupY);
      ctx.lineTo(o.deliverX, o.deliverY);
      ctx.strokeStyle = "rgba(255,107,0,0.07)";
      ctx.lineWidth = 0.5;
      ctx.setLineDash([2, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Handoff points
    for (const h of engine.handoffs.filter(h => h.status === "pending")) {
      ctx.beginPath();
      ctx.arc(h.x, h.y, 7, 0, Math.PI * 2);
      ctx.strokeStyle = O;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = O;
      ctx.font = `bold 7px ${MONO}`;
      ctx.textAlign = "center";
      ctx.fillText("HANDOFF", h.x, h.y - 10);
      ctx.textAlign = "start";
    }

    // Agents
    for (const a of engine.agents) {
      const t = AGENT_TYPES[a.type];
      const off = a.status === "offline";
      const safe = a.safetyMode;

      if (!off && a.status === "delivering") {
        ctx.beginPath();
        ctx.arc(a.x, a.y, 12, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,107,0,0.05)";
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(a.x, a.y, off ? 3 : 5, 0, Math.PI * 2);
      ctx.fillStyle = off ? "#333" : safe ? O : t.color;
      ctx.globalAlpha = off ? 0.35 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;

      if (a.status === "delivering") {
        ctx.beginPath();
        ctx.arc(a.x, a.y, 8, 0, Math.PI * 2);
        ctx.strokeStyle = O;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      if (!off) {
        const bw = 12, bh = 1.5, bx = a.x - bw / 2, by = a.y + 8;
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = a.battery > 30 ? O : "#ff3333";
        ctx.fillRect(bx, by, bw * (a.battery / 100), bh);
      }

      if (off) {
        ctx.strokeStyle = "#ff3333";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(a.x - 3, a.y - 3); ctx.lineTo(a.x + 3, a.y + 3);
        ctx.moveTo(a.x + 3, a.y - 3); ctx.lineTo(a.x - 3, a.y + 3);
        ctx.stroke();
      }

      if (safe) {
        const pulse = 0.5 + 0.5 * Math.sin(engine.tick * 0.2);
        ctx.beginPath();
        ctx.arc(a.x, a.y, 10, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,107,0,${pulse * 0.6})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Legend
    ctx.fillStyle = "rgba(10,10,10,0.92)";
    ctx.strokeStyle = "rgba(255,107,0,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(MAP_W - 125, MAP_H - 82, 118, 75);
    ctx.fill();
    ctx.stroke();
    ctx.font = `bold 7px ${MONO}`;
    ctx.fillStyle = O;
    ctx.fillText("LEGEND", MAP_W - 117, MAP_H - 67);
    let ly = MAP_H - 52;
    for (const [, t] of Object.entries(AGENT_TYPES)) {
      ctx.fillStyle = t.color;
      ctx.beginPath();
      ctx.arc(MAP_W - 113, ly - 2, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.font = `7px ${MONO}`;
      ctx.fillText(t.label, MAP_W - 104, ly);
      ly += 13;
    }
    ctx.fillStyle = O;
    ctx.beginPath();
    ctx.arc(MAP_W - 113, ly - 2, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.fillText("ORDER", MAP_W - 104, ly);
  });

  return <canvas ref={canvasRef} style={{ width: MAP_W, height: MAP_H, border: `1px solid rgba(255,107,0,0.12)` }} />;
};

// ─── MAIN APP ───
export default function SwarmLogixDashboard() {
  const engineRef = useRef(null);
  const [, forceUpdate] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [tab, setTab] = useState("map");
  const intervalRef = useRef(null);

  if (!engineRef.current) engineRef.current = new SwarmEngine().init(15);
  const engine = engineRef.current;

  const startSim = useCallback(() => {
    if (intervalRef.current) return;
    engine.paused = false; setIsRunning(true);
    intervalRef.current = setInterval(() => { engine.update(); forceUpdate(n => n + 1); }, 50);
  }, [engine]);
  const stopSim = useCallback(() => {
    engine.paused = true; setIsRunning(false);
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  }, [engine]);
  const resetSim = useCallback(() => { stopSim(); engineRef.current = new SwarmEngine().init(15); forceUpdate(n => n + 1); }, [stopSim]);
  const triggerFailure = useCallback(() => {
    const alive = engine.agents.filter(a => a.status !== "offline");
    if (alive.length > 3) engine.triggerAgentFailure(pick(alive), "manual_kill");
    forceUpdate(n => n + 1);
  }, [engine]);
  const triggerSafety = useCallback(() => { engine.triggerSafetyAlert(rand(100, MAP_W - 100), rand(100, MAP_H - 100)); forceUpdate(n => n + 1); }, [engine]);
  const addAgent = useCallback(() => {
    const typeKey = pick(Object.keys(AGENT_TYPES));
    const t = AGENT_TYPES[typeKey];
    engine.agents.push({ id: uid(), type: typeKey, vendor: pick(VENDORS), x: rand(40, MAP_W - 40), y: rand(40, MAP_H - 40), targetX: null, targetY: null, battery: rand(70, 100), capacity: t.capacity, load: 0, speed: t.speed * rand(0.85, 1.15), range: t.range, status: "idle", orderId: null, discoveredPeers: [], safetyMode: false });
    engine.log("SYSTEM", `New ${typeKey} joined from ${engine.agents[engine.agents.length - 1].vendor}`);
    forceUpdate(n => n + 1);
  }, [engine]);
  useEffect(() => () => { if (intervalRef.current) clearInterval(intervalRef.current); }, []);

  const alive = engine.agents.filter(a => a.status !== "offline");
  const logC = { info: "#444", order: O, auction: "#FF9D45", deliver: "#aaa", success: O, handoff: "#FF9D45", error: "#ff3333", heal: "#666", safety: O };
  const stC = { idle: "#444", delivering: O, offline: "#ff3333" };

  return (
    <div style={{ fontFamily: MONO, background: "#0D0D0D", color: "#fff", minHeight: "100vh", padding: "24px 28px" }}>
      <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />
      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,107,0,0.15); border-radius: 2px; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
      `}</style>

      {/* HEADER */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
            <div style={{ width: 36, height: 36, border: `2px solid ${O}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, color: O, fontWeight: 700 }}>◈</div>
            <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "0.06em", lineHeight: 1 }}>
              SWARM<span style={{ color: O }}>LOGIX</span>
            </h1>
          </div>
          <p style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: "0.16em", textTransform: "uppercase" }}>
            P2P Last-Mile Coordination · London Metro · Built on Vertex 2.0 by Tashi
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!isRunning ? (
            <button onClick={startSim} style={{ padding: "10px 24px", fontSize: 11, fontWeight: 700, fontFamily: MONO, letterSpacing: "0.12em", border: `2px solid ${O}`, background: O, color: "#000", cursor: "pointer" }}>
              ▶ JOIN THE SWARM
            </button>
          ) : (
            <button onClick={stopSim} style={{ padding: "10px 24px", fontSize: 11, fontWeight: 700, fontFamily: MONO, letterSpacing: "0.12em", border: `2px solid ${O}`, background: "transparent", color: O, cursor: "pointer" }}>
              ⏸ PAUSE
            </button>
          )}
          <button onClick={resetSim} style={{ padding: "10px 20px", fontSize: 11, fontWeight: 700, fontFamily: MONO, letterSpacing: "0.12em", border: "1px solid rgba(255,255,255,0.12)", background: "transparent", color: "rgba(255,255,255,0.35)", cursor: "pointer" }}>
            ↺ RESET
          </button>
        </div>
      </div>

      {/* STATS */}
      <div style={{ display: "flex", gap: 1, marginBottom: 20 }}>
        {[
          { label: "ACTIVE NODES", value: alive.length, hl: true },
          { label: "DELIVERIES", value: engine.stats.delivered },
          { label: "AUCTIONS", value: engine.stats.auctionsRun },
          { label: "HANDOFFS", value: engine.stats.handoffsCompleted },
          { label: "SELF-HEALS", value: engine.stats.heals },
          { label: "SAFETY ALERTS", value: engine.stats.alerts },
        ].map((s, i) => (
          <div key={s.label} style={{
            flex: 1, padding: "14px 16px",
            background: s.hl ? "rgba(255,107,0,0.06)" : "rgba(255,255,255,0.015)",
            borderLeft: i === 0 ? `2px solid ${O}` : "none",
            borderTop: `1px solid ${s.hl ? "rgba(255,107,0,0.15)" : "rgba(255,255,255,0.03)"}`,
            borderBottom: `1px solid ${s.hl ? "rgba(255,107,0,0.15)" : "rgba(255,255,255,0.03)"}`,
          }}>
            <div style={{ fontSize: 7, color: s.hl ? O : "rgba(255,255,255,0.2)", letterSpacing: "0.2em", marginBottom: 6 }}>{s.label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: s.hl ? O : "#fff" }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* CONTROLS */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
        {[
          { label: "+ NODE", action: addAgent, accent: true },
          { label: "⚡ KILL", action: triggerFailure },
          { label: "◈ SAFETY", action: triggerSafety },
        ].map(b => (
          <button key={b.label} onClick={b.action} style={{
            padding: "7px 16px", fontSize: 9, fontWeight: 700, fontFamily: MONO, letterSpacing: "0.1em",
            border: b.accent ? `1px solid ${O}` : "1px solid rgba(255,255,255,0.08)",
            background: "transparent", color: b.accent ? O : "rgba(255,255,255,0.3)", cursor: "pointer",
          }}>{b.label}</button>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex" }}>
          {["map", "agents", "auctions"].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: "7px 18px", fontSize: 8, fontWeight: 700, fontFamily: MONO,
              letterSpacing: "0.14em", textTransform: "uppercase",
              border: "1px solid rgba(255,255,255,0.05)",
              borderRight: t !== "auctions" ? "none" : undefined,
              background: tab === t ? "rgba(255,107,0,0.08)" : "transparent",
              color: tab === t ? O : "rgba(255,255,255,0.2)", cursor: "pointer",
              borderBottom: tab === t ? `2px solid ${O}` : "2px solid transparent",
            }}>{t}</button>
          ))}
        </div>
      </div>

      {/* MAIN */}
      <div style={{ display: "flex", gap: 1 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {tab === "map" && <SwarmMap engine={engine} />}
          {tab === "agents" && (
            <div style={{ background: "rgba(255,255,255,0.01)", border: `1px solid rgba(255,107,0,0.08)`, maxHeight: MAP_H, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                <thead>
                  <tr>
                    {["ID", "TYPE", "VENDOR", "STATUS", "BATTERY", "LOAD", "PEERS"].map(h => (
                      <th key={h} style={{ padding: "10px 12px", textAlign: "left", color: O, fontWeight: 700, fontSize: 7, letterSpacing: "0.18em", borderBottom: `1px solid rgba(255,107,0,0.12)`, position: "sticky", top: 0, background: "#0D0D0D" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {engine.agents.map(a => (
                    <tr key={a.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.02)" }}>
                      <td style={{ padding: "7px 12px", color: "rgba(255,255,255,0.3)" }}>{a.id}</td>
                      <td style={{ padding: "7px 12px" }}><span style={{ color: AGENT_TYPES[a.type].color, fontWeight: 700, fontSize: 9 }}>{AGENT_TYPES[a.type].label}</span></td>
                      <td style={{ padding: "7px 12px", color: "rgba(255,255,255,0.45)" }}>{a.vendor}</td>
                      <td style={{ padding: "7px 12px" }}>
                        <span style={{ padding: "2px 8px", fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", border: `1px solid ${(stC[a.status] || "#444")}40`, color: a.safetyMode ? O : (stC[a.status] || "#444") }}>
                          {a.safetyMode ? "◈ FROZEN" : a.status.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ padding: "7px 12px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <div style={{ width: 36, height: 3, background: "rgba(255,255,255,0.05)" }}>
                            <div style={{ width: `${a.battery}%`, height: "100%", background: a.battery > 30 ? O : "#ff3333" }} />
                          </div>
                          <span style={{ fontSize: 8, color: "rgba(255,255,255,0.25)" }}>{a.battery.toFixed(0)}%</span>
                        </div>
                      </td>
                      <td style={{ padding: "7px 12px", color: "rgba(255,255,255,0.25)", fontSize: 9 }}>{a.load.toFixed(1)}/{a.capacity}kg</td>
                      <td style={{ padding: "7px 12px", color: "rgba(255,255,255,0.25)", fontSize: 9 }}>{a.discoveredPeers.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tab === "auctions" && (
            <div style={{ background: "rgba(255,255,255,0.01)", border: `1px solid rgba(255,107,0,0.08)`, padding: 16, maxHeight: MAP_H, overflow: "auto" }}>
              {engine.auctions.length === 0 ? (
                <div style={{ color: "rgba(255,255,255,0.12)", textAlign: "center", padding: 40, fontSize: 9, letterSpacing: "0.12em" }}>NO AUCTIONS YET. START THE SWARM.</div>
              ) : engine.auctions.slice(0, 15).map(auc => (
                <div key={auc.id} style={{ marginBottom: 10, padding: 12, background: "rgba(255,107,0,0.02)", borderLeft: `2px solid ${O}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontSize: 9, fontWeight: 700, color: O, letterSpacing: "0.08em" }}>AUCTION #{auc.id.slice(0, 4)} · ORDER {auc.orderId.slice(0, 4)}</span>
                    <span style={{ fontSize: 8, color: "rgba(255,255,255,0.12)" }}>TICK {auc.tick}</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {auc.bids.map(bid => (
                      <div key={bid.agentId} style={{
                        padding: "3px 10px", fontSize: 9,
                        border: bid.agentId === auc.winnerId ? `1px solid ${O}` : "1px solid rgba(255,255,255,0.04)",
                        color: bid.agentId === auc.winnerId ? O : "rgba(255,255,255,0.25)",
                        background: bid.agentId === auc.winnerId ? "rgba(255,107,0,0.06)" : "transparent",
                      }}>{bid.vendor} · {bid.score} {bid.agentId === auc.winnerId && "✓"}</div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* EVENT LOG */}
        <div style={{ width: 340, marginLeft: 1, background: "rgba(255,255,255,0.01)", borderLeft: `2px solid ${O}`, padding: 14, maxHeight: MAP_H + 4, overflow: "auto", flexShrink: 0 }}>
          <div style={{ fontSize: 7, fontWeight: 700, letterSpacing: "0.2em", color: O, marginBottom: 12, paddingBottom: 8, borderBottom: `1px solid rgba(255,107,0,0.12)` }}>
            MESH EVENT LOG
          </div>
          {engine.eventLog.map((entry, i) => (
            <div key={`${entry.tick}-${i}`} style={{ display: "flex", gap: 8, fontSize: 9, padding: "3px 0", borderBottom: "1px solid rgba(255,255,255,0.015)", animation: i === 0 ? "fadeIn 0.3s ease-out" : undefined }}>
              <span style={{ color: "rgba(255,255,255,0.1)", minWidth: 30 }}>{entry.tick}</span>
              <span style={{ color: logC[entry.type] || "#444", minWidth: 52, fontWeight: 700 }}>[{entry.source}]</span>
              <span style={{ color: "rgba(255,255,255,0.45)" }}>{entry.message}</span>
            </div>
          ))}
          {engine.eventLog.length === 0 && (
            <div style={{ color: "rgba(255,255,255,0.08)", fontSize: 9, textAlign: "center", padding: 30, letterSpacing: "0.1em" }}>PRESS START TO INITIALIZE</div>
          )}
        </div>
      </div>

      {/* PROTOCOL CARDS */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 1, marginTop: 20 }}>
        {[
          { n: "01", t: "P2P DISCOVERY", d: "Agents broadcast state via Vertex mesh. Peers within range auto-connect. No central registry." },
          { n: "02", t: "AUCTION PROTOCOL", d: "Orders trigger local P2P auctions. Agents bid on proximity, battery, capacity. Winner in ms." },
          { n: "03", t: "MULTI-HOP HANDOFF", d: "Long-distance orders relayed: Drone to Robot for indoor. Negotiated peer-to-peer." },
          { n: "04", t: "SELF-HEALING", d: "Agent drops? Order re-auctioned instantly. No single point of failure. No manual intervention." },
          { n: "05", t: "SAFETY MESH", d: "One node detects hazard. Alert propagates. All agents in zone freeze in milliseconds." },
        ].map(p => (
          <div key={p.n} style={{ padding: "18px 16px", background: "rgba(255,107,0,0.02)", borderTop: `2px solid ${O}` }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: "rgba(255,107,0,0.08)", lineHeight: 1, marginBottom: 8 }}>{p.n}</div>
            <div style={{ fontSize: 9, fontWeight: 700, color: O, letterSpacing: "0.1em", marginBottom: 6 }}>{p.t}</div>
            <div style={{ fontSize: 9, lineHeight: 1.6, color: "rgba(255,255,255,0.25)" }}>{p.d}</div>
          </div>
        ))}
      </div>

      {/* FOOTER */}
      <div style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid rgba(255,107,0,0.08)`, display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 8, color: "rgba(255,255,255,0.12)", letterSpacing: "0.14em" }}>SWARMLOGIX · VERTEX SWARM CHALLENGE 2026 · BUILT ON TASHI NETWORK</span>
        <span style={{ fontSize: 8, color: O, letterSpacing: "0.14em", fontWeight: 700 }}>COLLECTIVE INTELLIGENCE FOR AUTONOMOUS SYSTEMS</span>
      </div>
    </div>
  );
}

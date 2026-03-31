import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ─── SIMULATION CONSTANTS ───
const MAP_W = 800;
const MAP_H = 520;
const AGENT_TYPES = {
  drone: { icon: "◈", color: "#00e5ff", speed: 3.5, capacity: 2, range: 180, label: "Drone" },
  robot: { icon: "◉", color: "#76ff03", speed: 1.2, capacity: 5, range: 90, label: "Robot AMR" },
  bike: { icon: "◆", color: "#ff9100", speed: 2.5, capacity: 8, range: 250, label: "E-Bike" },
};
const VENDORS = ["RoyalFleet", "SwiftBot", "AeroLink", "UrbanFleet", "NexDrone"];
const ZONES = [
  { name: "Camden", x: 100, y: 80, w: 200, h: 150 },
  { name: "Canary Wharf", x: 380, y: 60, w: 220, h: 160 },
  { name: "Greenwich", x: 500, y: 280, w: 200, h: 180 },
  { name: "Shoreditch", x: 80, y: 300, w: 220, h: 170 },
];

// ─── UTILITY FUNCTIONS ───
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
    this.safetyAlerts = [];
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
        id: uid(),
        type: typeKey,
        vendor: pick(VENDORS),
        x: rand(40, MAP_W - 40),
        y: rand(40, MAP_H - 40),
        targetX: null,
        targetY: null,
        battery: rand(60, 100),
        capacity: t.capacity,
        load: 0,
        speed: t.speed * rand(0.85, 1.15),
        range: t.range,
        status: "idle", // idle | moving | delivering | auctioning | failing | offline
        orderId: null,
        discoveredPeers: [],
        lastBroadcast: 0,
        safetyMode: false,
      });
    }
    this.log("SYSTEM", `Swarm initialized: ${count} agents from ${VENDORS.length} vendors`);
    return this;
  }

  log(source, message, type = "info") {
    this.eventLog.unshift({ tick: this.tick, source, message, type, ts: Date.now() });
    if (this.eventLog.length > 120) this.eventLog.length = 120;
  }

  // ─── P2P DISCOVERY ───
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

  // ─── ORDER GENERATION ───
  maybeSpawnOrder() {
    if (this.orders.filter((o) => o.status === "pending").length >= 5) return;
    if (Math.random() > 0.025) return;
    const order = {
      id: uid(),
      pickupX: rand(60, MAP_W - 60),
      pickupY: rand(60, MAP_H - 60),
      deliverX: rand(60, MAP_W - 60),
      deliverY: rand(60, MAP_H - 60),
      weight: rand(0.5, 6),
      status: "pending", // pending | auctioning | assigned | in_transit | handoff | delivered
      assignedAgent: null,
      handoffAgent: null,
      createdAt: this.tick,
    };
    this.orders.push(order);
    this.log("ORDER", `New order ${order.id.slice(0, 4)} — ${order.weight.toFixed(1)}kg`, "order");
  }

  // ─── AUCTION PROTOCOL ───
  runAuctions() {
    const pending = this.orders.filter((o) => o.status === "pending");
    for (const order of pending) {
      const candidates = this.agents.filter(
        (a) =>
          a.status === "idle" &&
          !a.safetyMode &&
          a.capacity >= order.weight &&
          a.battery > 20 &&
          dist(a, { x: order.pickupX, y: order.pickupY }) < a.range * 1.5
      );
      if (candidates.length < 1) continue;

      order.status = "auctioning";
      const bids = candidates.map((a) => {
        const d = dist(a, { x: order.pickupX, y: order.pickupY });
        const score = (1 - d / (a.range * 1.5)) * 0.4 + (a.battery / 100) * 0.3 + (1 - a.load / a.capacity) * 0.3;
        return { agent: a, score, dist: d };
      });
      bids.sort((a, b) => b.score - a.score);

      const winner = bids[0];
      const auction = {
        id: uid(),
        orderId: order.id,
        bids: bids.map((b) => ({ agentId: b.agent.id, score: b.score.toFixed(3), vendor: b.agent.vendor })),
        winnerId: winner.agent.id,
        tick: this.tick,
      };
      this.auctions.unshift(auction);
      if (this.auctions.length > 30) this.auctions.length = 30;

      winner.agent.status = "delivering";
      winner.agent.orderId = order.id;
      winner.agent.targetX = order.pickupX;
      winner.agent.targetY = order.pickupY;
      winner.agent.load = order.weight;
      order.status = "assigned";
      order.assignedAgent = winner.agent.id;
      this.stats.auctionsRun++;

      this.log(
        "AUCTION",
        `Order ${order.id.slice(0, 4)}: ${bids.length} bids → ${winner.agent.vendor}/${winner.agent.type} wins (score ${winner.score.toFixed(2)})`,
        "auction"
      );
    }
  }

  // ─── MOVEMENT & DELIVERY ───
  moveAgents() {
    for (const a of this.agents) {
      if (a.status === "offline" || a.safetyMode) continue;
      a.battery = Math.max(0, a.battery - 0.008);
      if (a.battery <= 0) {
        this.triggerAgentFailure(a, "battery_dead");
        continue;
      }

      if (a.targetX != null && a.targetY != null) {
        const d = dist(a, { x: a.targetX, y: a.targetY });
        if (d < a.speed * 1.5) {
          a.x = a.targetX;
          a.y = a.targetY;
          this.onArrival(a);
        } else {
          const angle = Math.atan2(a.targetY - a.y, a.targetX - a.x);
          a.x += Math.cos(angle) * a.speed;
          a.y += Math.sin(angle) * a.speed;
          a.x = clamp(a.x, 10, MAP_W - 10);
          a.y = clamp(a.y, 10, MAP_H - 10);
        }
      } else if (a.status === "idle") {
        // wander
        if (Math.random() < 0.01) {
          a.targetX = clamp(a.x + rand(-100, 100), 20, MAP_W - 20);
          a.targetY = clamp(a.y + rand(-100, 100), 20, MAP_H - 20);
        }
      }
    }
  }

  onArrival(a) {
    const order = this.orders.find((o) => o.id === a.orderId);
    if (!order) {
      a.targetX = null;
      a.targetY = null;
      a.status = "idle";
      return;
    }

    if (order.status === "assigned") {
      // Arrived at pickup, now go to delivery
      order.status = "in_transit";
      a.targetX = order.deliverX;
      a.targetY = order.deliverY;
      this.log("DELIVER", `${a.vendor}/${a.type} picked up order ${order.id.slice(0, 4)}`, "deliver");

      // Check if handoff is needed (long distance or drone→robot for indoor)
      const totalDist = dist({ x: order.pickupX, y: order.pickupY }, { x: order.deliverX, y: order.deliverY });
      if (totalDist > a.range * 0.8 || (a.type === "drone" && Math.random() < 0.3)) {
        this.initiateHandoff(a, order);
      }
    } else if (order.status === "in_transit" || order.status === "handoff") {
      // Delivered!
      order.status = "delivered";
      a.status = "idle";
      a.orderId = null;
      a.load = 0;
      a.targetX = null;
      a.targetY = null;
      this.stats.delivered++;
      this.log("DELIVER", `✓ Order ${order.id.slice(0, 4)} delivered by ${a.vendor}/${a.type}!`, "success");
    }
  }

  // ─── MULTI-HOP HANDOFF ───
  initiateHandoff(fromAgent, order) {
    const midX = (fromAgent.x + order.deliverX) / 2;
    const midY = (fromAgent.y + order.deliverY) / 2;
    const candidates = this.agents.filter(
      (a) =>
        a.id !== fromAgent.id &&
        a.status === "idle" &&
        !a.safetyMode &&
        a.capacity >= order.weight &&
        dist(a, { x: midX, y: midY }) < 200
    );
    if (candidates.length === 0) return;

    const relay = candidates.sort((a, b) => dist(a, { x: order.deliverX, y: order.deliverY }) - dist(b, { x: order.deliverX, y: order.deliverY }))[0];

    // Set handoff point
    const handoffX = lerp(fromAgent.x, order.deliverX, 0.4 + Math.random() * 0.2);
    const handoffY = lerp(fromAgent.y, order.deliverY, 0.4 + Math.random() * 0.2);
    fromAgent.targetX = handoffX;
    fromAgent.targetY = handoffY;

    // Mark handoff
    order.status = "handoff";
    order.handoffAgent = relay.id;
    this.handoffs.push({
      id: uid(),
      orderId: order.id,
      from: fromAgent.id,
      to: relay.id,
      x: handoffX,
      y: handoffY,
      tick: this.tick,
      status: "pending",
    });

    // After a delay, relay picks up
    setTimeout(() => {
      if (order.status !== "handoff") return;
      relay.status = "delivering";
      relay.orderId = order.id;
      relay.targetX = handoffX;
      relay.targetY = handoffY;
      relay.load = order.weight;
      order.status = "in_transit";
      order.assignedAgent = relay.id;
      const hf = this.handoffs.find((h) => h.orderId === order.id && h.status === "pending");
      if (hf) hf.status = "completed";
      this.stats.handoffsCompleted++;
      fromAgent.status = "idle";
      fromAgent.orderId = null;
      fromAgent.load = 0;
      fromAgent.targetX = null;
      fromAgent.targetY = null;

      this.log(
        "HANDOFF",
        `${fromAgent.vendor}/${fromAgent.type} → ${relay.vendor}/${relay.type} for order ${order.id.slice(0, 4)}`,
        "handoff"
      );
    }, 800);
  }

  // ─── SELF-HEALING ───
  triggerAgentFailure(agent, reason = "random") {
    if (agent.status === "offline") return;
    const hadOrder = agent.orderId;
    agent.status = "offline";
    const order = this.orders.find((o) => o.id === hadOrder);

    this.log("FAULT", `⚠ ${agent.vendor}/${agent.type} went offline (${reason})`, "error");

    if (order && order.status !== "delivered") {
      order.status = "pending";
      order.assignedAgent = null;
      this.log("HEAL", `Re-auctioning order ${order.id.slice(0, 4)} after agent failure`, "heal");
      this.stats.heals++;
    }

    agent.orderId = null;
    agent.load = 0;
    agent.targetX = null;
    agent.targetY = null;

    // Agent recovers after some time
    setTimeout(() => {
      agent.status = "idle";
      agent.battery = rand(40, 70);
      this.log("HEAL", `${agent.vendor}/${agent.type} back online (battery ${agent.battery.toFixed(0)}%)`, "heal");
    }, rand(3000, 6000));
  }

  maybeFailAgent() {
    if (Math.random() > 0.004) return;
    const alive = this.agents.filter((a) => a.status !== "offline");
    if (alive.length < 5) return;
    this.triggerAgentFailure(pick(alive), pick(["network_loss", "hardware_fault", "battery_critical"]));
  }

  // ─── SAFETY MESH ───
  triggerSafetyAlert(x, y, radius = 120) {
    this.safetyZone = { x, y, radius, startTick: this.tick };
    this.stats.alerts++;

    let frozen = 0;
    for (const a of this.agents) {
      if (a.status === "offline") continue;
      if (dist(a, { x, y }) < radius) {
        a.safetyMode = true;
        a.targetX = null;
        a.targetY = null;
        frozen++;
      }
    }
    this.log("SAFETY", `🛡️ Safety alert propagated — ${frozen} agents frozen in ${Math.floor(radius)}m radius`, "safety");

    // Clear after some time
    setTimeout(() => {
      for (const a of this.agents) a.safetyMode = false;
      this.safetyZone = null;
      this.log("SAFETY", `Safety alert cleared — swarm resuming`, "safety");
    }, 4000);
  }

  maybeSafetyEvent() {
    if (Math.random() > 0.001 || this.safetyZone) return;
    this.triggerSafetyAlert(rand(100, MAP_W - 100), rand(100, MAP_H - 100), rand(80, 150));
  }

  // ─── MAIN UPDATE ───
  update() {
    if (this.paused) return;
    this.tick++;
    this.runDiscovery();
    this.maybeSpawnOrder();
    this.runAuctions();
    this.moveAgents();
    this.maybeFailAgent();
    this.maybeSafetyEvent();

    // Clean old orders
    this.orders = this.orders.filter((o) => o.status !== "delivered" || this.tick - o.createdAt < 600);
  }
}

// ─── REACT COMPONENTS ───

const TypeBadge = ({ type }) => {
  const t = AGENT_TYPES[type];
  return (
    <span style={{ color: t.color, fontWeight: 700, fontSize: 11, letterSpacing: "0.05em" }}>
      {t.icon} {t.label}
    </span>
  );
};

const StatCard = ({ label, value, accent }) => (
  <div
    style={{
      background: "rgba(255,255,255,0.03)",
      border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: 8,
      padding: "10px 14px",
      flex: 1,
      minWidth: 100,
    }}
  >
    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 4 }}>
      {label}
    </div>
    <div style={{ fontSize: 22, fontWeight: 800, color: accent || "#fff", fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
  </div>
);

const LogEntry = ({ entry }) => {
  const colors = {
    info: "#6b7280",
    order: "#facc15",
    auction: "#a78bfa",
    deliver: "#38bdf8",
    success: "#4ade80",
    handoff: "#fb923c",
    error: "#f87171",
    heal: "#2dd4bf",
    safety: "#f472b6",
  };
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        fontSize: 11,
        fontFamily: "'JetBrains Mono', monospace",
        padding: "3px 0",
        borderBottom: "1px solid rgba(255,255,255,0.03)",
        animation: "fadeSlide 0.3s ease-out",
      }}
    >
      <span style={{ color: "rgba(255,255,255,0.2)", minWidth: 40 }}>{entry.tick}</span>
      <span style={{ color: colors[entry.type] || "#888", minWidth: 60, fontWeight: 700 }}>[{entry.source}]</span>
      <span style={{ color: "rgba(255,255,255,0.7)" }}>{entry.message}</span>
    </div>
  );
};

// ─── MAP RENDERER (Canvas) ───
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

    // Background
    ctx.fillStyle = "#0a0e17";
    ctx.fillRect(0, 0, MAP_W, MAP_H);

    // Grid
    ctx.strokeStyle = "rgba(255,255,255,0.03)";
    ctx.lineWidth = 0.5;
    for (let x = 0; x < MAP_W; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, MAP_H);
      ctx.stroke();
    }
    for (let y = 0; y < MAP_H; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(MAP_W, y);
      ctx.stroke();
    }

    // Zones
    for (const z of ZONES) {
      ctx.fillStyle = "rgba(255,255,255,0.015)";
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(z.x, z.y, z.w, z.h, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.fillText(z.name, z.x + 8, z.y + 16);
    }

    // Safety zone
    if (engine.safetyZone) {
      const sz = engine.safetyZone;
      const pulse = 0.3 + 0.2 * Math.sin(engine.tick * 0.15);
      ctx.beginPath();
      ctx.arc(sz.x, sz.y, sz.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(244, 114, 182, ${pulse * 0.15})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(244, 114, 182, ${pulse})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#f472b6";
      ctx.font = "bold 11px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText("⚠ SAFETY ZONE", sz.x, sz.y - sz.radius - 8);
      ctx.textAlign = "start";
    }

    // Connections (P2P mesh)
    for (const conn of engine.connections) {
      const from = engine.agents.find((a) => a.id === conn.from);
      const to = engine.agents.find((a) => a.id === conn.to);
      if (!from || !to) continue;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = `rgba(100,180,255,${conn.strength * 0.07})`;
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }

    // Orders (pending)
    for (const o of engine.orders) {
      if (o.status === "delivered") continue;
      // Pickup
      ctx.beginPath();
      ctx.arc(o.pickupX, o.pickupY, 5, 0, Math.PI * 2);
      ctx.fillStyle = o.status === "pending" ? "#facc15" : "rgba(250,204,21,0.3)";
      ctx.fill();
      // Delivery
      ctx.beginPath();
      ctx.arc(o.deliverX, o.deliverY, 4, 0, Math.PI * 2);
      ctx.strokeStyle = "#4ade80";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Line
      ctx.beginPath();
      ctx.moveTo(o.pickupX, o.pickupY);
      ctx.lineTo(o.deliverX, o.deliverY);
      ctx.strokeStyle = "rgba(250,204,21,0.1)";
      ctx.lineWidth = 0.5;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Handoff points
    for (const h of engine.handoffs.filter((h) => h.status === "pending")) {
      ctx.beginPath();
      ctx.arc(h.x, h.y, 8, 0, Math.PI * 2);
      ctx.strokeStyle = "#fb923c";
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#fb923c";
      ctx.font = "8px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText("HANDOFF", h.x, h.y - 12);
      ctx.textAlign = "start";
    }

    // Agents
    for (const a of engine.agents) {
      const t = AGENT_TYPES[a.type];
      const isOffline = a.status === "offline";
      const isSafe = a.safetyMode;

      // Glow for active agents
      if (!isOffline && a.status === "delivering") {
        ctx.beginPath();
        ctx.arc(a.x, a.y, 14, 0, Math.PI * 2);
        ctx.fillStyle = `${t.color}15`;
        ctx.fill();
      }

      // Agent body
      ctx.beginPath();
      ctx.arc(a.x, a.y, isOffline ? 4 : 6, 0, Math.PI * 2);
      ctx.fillStyle = isOffline ? "#374151" : isSafe ? "#f472b6" : t.color;
      ctx.globalAlpha = isOffline ? 0.4 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;

      // Status ring
      if (a.status === "delivering") {
        ctx.beginPath();
        ctx.arc(a.x, a.y, 9, 0, Math.PI * 2);
        ctx.strokeStyle = t.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Battery indicator
      if (!isOffline) {
        const bw = 14;
        const bh = 2;
        const bx = a.x - bw / 2;
        const by = a.y + 9;
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = a.battery > 30 ? "#4ade80" : a.battery > 15 ? "#facc15" : "#f87171";
        ctx.fillRect(bx, by, bw * (a.battery / 100), bh);
      }

      // Offline X
      if (isOffline) {
        ctx.strokeStyle = "#f87171";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(a.x - 4, a.y - 4);
        ctx.lineTo(a.x + 4, a.y + 4);
        ctx.moveTo(a.x + 4, a.y - 4);
        ctx.lineTo(a.x - 4, a.y + 4);
        ctx.stroke();
      }

      // Safety freeze indicator
      if (isSafe) {
        const pulse = 0.5 + 0.5 * Math.sin(engine.tick * 0.2);
        ctx.beginPath();
        ctx.arc(a.x, a.y, 11, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(244, 114, 182, ${pulse})`;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Legend overlay
    ctx.fillStyle = "rgba(10,14,23,0.85)";
    ctx.beginPath();
    ctx.roundRect(MAP_W - 145, MAP_H - 90, 138, 82, 6);
    ctx.fill();
    ctx.font = "bold 9px 'JetBrains Mono', monospace";
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillText("LEGEND", MAP_W - 135, MAP_H - 73);
    let ly = MAP_H - 58;
    for (const [key, t] of Object.entries(AGENT_TYPES)) {
      ctx.fillStyle = t.color;
      ctx.font = "12px 'JetBrains Mono', monospace";
      ctx.fillText(t.icon, MAP_W - 135, ly);
      ctx.font = "9px 'JetBrains Mono', monospace";
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillText(t.label, MAP_W - 118, ly);
      ly += 15;
    }
    ctx.fillStyle = "#facc15";
    ctx.beginPath();
    ctx.arc(MAP_W - 130, ly - 4, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "9px 'JetBrains Mono', monospace";
    ctx.fillText("Order", MAP_W - 118, ly);
  });

  return (
    <canvas
      ref={canvasRef}
      style={{ width: MAP_W, height: MAP_H, borderRadius: 10, border: "1px solid rgba(255,255,255,0.06)" }}
    />
  );
};

// ─── MAIN APP ───
export default function SwarmLogixDashboard() {
  const engineRef = useRef(null);
  const [, forceUpdate] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [tab, setTab] = useState("map");
  const intervalRef = useRef(null);

  if (!engineRef.current) {
    engineRef.current = new SwarmEngine().init(15);
  }
  const engine = engineRef.current;

  const startSim = useCallback(() => {
    if (intervalRef.current) return;
    engine.paused = false;
    setIsRunning(true);
    intervalRef.current = setInterval(() => {
      engine.update();
      forceUpdate((n) => n + 1);
    }, 50);
  }, [engine]);

  const stopSim = useCallback(() => {
    engine.paused = true;
    setIsRunning(false);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, [engine]);

  const resetSim = useCallback(() => {
    stopSim();
    engineRef.current = new SwarmEngine().init(15);
    forceUpdate((n) => n + 1);
  }, [stopSim]);

  const triggerFailure = useCallback(() => {
    const alive = engine.agents.filter((a) => a.status !== "offline");
    if (alive.length > 3) engine.triggerAgentFailure(pick(alive), "manual_kill");
    forceUpdate((n) => n + 1);
  }, [engine]);

  const triggerSafety = useCallback(() => {
    engine.triggerSafetyAlert(rand(100, MAP_W - 100), rand(100, MAP_H - 100));
    forceUpdate((n) => n + 1);
  }, [engine]);

  const addAgent = useCallback(() => {
    const typeKey = pick(Object.keys(AGENT_TYPES));
    const t = AGENT_TYPES[typeKey];
    engine.agents.push({
      id: uid(),
      type: typeKey,
      vendor: pick(VENDORS),
      x: rand(40, MAP_W - 40),
      y: rand(40, MAP_H - 40),
      targetX: null,
      targetY: null,
      battery: rand(70, 100),
      capacity: t.capacity,
      load: 0,
      speed: t.speed * rand(0.85, 1.15),
      range: t.range,
      status: "idle",
      orderId: null,
      discoveredPeers: [],
      lastBroadcast: 0,
      safetyMode: false,
    });
    engine.log("SYSTEM", `New ${typeKey} joined from ${engine.agents[engine.agents.length - 1].vendor}`, "info");
    forceUpdate((n) => n + 1);
  }, [engine]);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const aliveAgents = engine.agents.filter((a) => a.status !== "offline");
  const activeOrders = engine.orders.filter((o) => o.status !== "delivered");

  const tabStyle = (t) => ({
    padding: "6px 16px",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    transition: "all 0.2s",
    background: tab === t ? "rgba(255,255,255,0.1)" : "transparent",
    color: tab === t ? "#fff" : "rgba(255,255,255,0.35)",
  });

  const btnStyle = (accent) => ({
    padding: "7px 16px",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.06em",
    border: `1px solid ${accent}40`,
    borderRadius: 6,
    cursor: "pointer",
    background: `${accent}15`,
    color: accent,
    transition: "all 0.2s",
  });

  return (
    <div
      style={{
        fontFamily: "'Outfit', 'Satoshi', sans-serif",
        background: "#080c14",
        color: "#fff",
        minHeight: "100vh",
        padding: "20px 24px",
      }}
    >
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700;800&family=Outfit:wght@300;400;600;700;800&display=swap" rel="stylesheet" />
      <style>{`
        @keyframes fadeSlide {
          from { opacity: 0; transform: translateY(-6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
      `}</style>

      {/* HEADER */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "linear-gradient(135deg, #00e5ff, #76ff03)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 16,
                fontWeight: 900,
              }}
            >
              ◈
            </div>
            <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>
              Swarm<span style={{ color: "#00e5ff" }}>Logix</span>
            </h1>
          </div>
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 3, letterSpacing: "0.04em" }}>
            P2P Last-Mile Delivery Coordination · London Metro · Vertex Swarm Challenge 2026
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!isRunning ? (
            <button onClick={startSim} style={btnStyle("#4ade80")}>
              ▶ Start
            </button>
          ) : (
            <button onClick={stopSim} style={btnStyle("#facc15")}>
              ⏸ Pause
            </button>
          )}
          <button onClick={resetSim} style={btnStyle("#6b7280")}>
            ↺ Reset
          </button>
        </div>
      </div>

      {/* STATS ROW */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <StatCard label="Active Agents" value={aliveAgents.length} accent="#00e5ff" />
        <StatCard label="Deliveries" value={engine.stats.delivered} accent="#4ade80" />
        <StatCard label="Auctions" value={engine.stats.auctionsRun} accent="#a78bfa" />
        <StatCard label="Handoffs" value={engine.stats.handoffsCompleted} accent="#fb923c" />
        <StatCard label="Self-Heals" value={engine.stats.heals} accent="#2dd4bf" />
        <StatCard label="Safety Alerts" value={engine.stats.alerts} accent="#f472b6" />
      </div>

      {/* CONTROLS */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <button onClick={addAgent} style={btnStyle("#00e5ff")}>
          + Add Agent
        </button>
        <button onClick={triggerFailure} style={btnStyle("#f87171")}>
          ⚡ Kill Agent
        </button>
        <button onClick={triggerSafety} style={btnStyle("#f472b6")}>
          🛡 Safety Alert
        </button>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 4, background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: 3 }}>
          <button onClick={() => setTab("map")} style={tabStyle("map")}>
            Map
          </button>
          <button onClick={() => setTab("agents")} style={tabStyle("agents")}>
            Agents
          </button>
          <button onClick={() => setTab("auctions")} style={tabStyle("auctions")}>
            Auctions
          </button>
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div style={{ display: "flex", gap: 16 }}>
        {/* LEFT: MAP / AGENTS / AUCTIONS */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {tab === "map" && <SwarmMap engine={engine} />}

          {tab === "agents" && (
            <div
              style={{
                background: "rgba(255,255,255,0.02)",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.06)",
                maxHeight: MAP_H,
                overflow: "auto",
              }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                    {["ID", "Type", "Vendor", "Status", "Battery", "Load", "Peers"].map((h) => (
                      <th
                        key={h}
                        style={{
                          padding: "10px 12px",
                          textAlign: "left",
                          color: "rgba(255,255,255,0.35)",
                          fontWeight: 700,
                          fontSize: 9,
                          textTransform: "uppercase",
                          letterSpacing: "0.1em",
                          position: "sticky",
                          top: 0,
                          background: "#0d111b",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {engine.agents.map((a) => {
                    const statusColors = {
                      idle: "#6b7280",
                      delivering: "#38bdf8",
                      offline: "#f87171",
                      moving: "#a78bfa",
                      failing: "#f87171",
                    };
                    return (
                      <tr key={a.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                        <td style={{ padding: "8px 12px", fontFamily: "'JetBrains Mono', monospace", color: "rgba(255,255,255,0.5)" }}>
                          {a.id}
                        </td>
                        <td style={{ padding: "8px 12px" }}>
                          <TypeBadge type={a.type} />
                        </td>
                        <td style={{ padding: "8px 12px", color: "rgba(255,255,255,0.6)" }}>{a.vendor}</td>
                        <td style={{ padding: "8px 12px" }}>
                          <span
                            style={{
                              display: "inline-block",
                              padding: "2px 8px",
                              borderRadius: 4,
                              fontSize: 10,
                              fontWeight: 700,
                              background: `${statusColors[a.status] || "#6b7280"}20`,
                              color: statusColors[a.status] || "#6b7280",
                            }}
                          >
                            {a.safetyMode ? "🛡 FROZEN" : a.status.toUpperCase()}
                          </span>
                        </td>
                        <td style={{ padding: "8px 12px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <div
                              style={{
                                width: 40,
                                height: 4,
                                borderRadius: 2,
                                background: "rgba(255,255,255,0.1)",
                                overflow: "hidden",
                              }}
                            >
                              <div
                                style={{
                                  width: `${a.battery}%`,
                                  height: "100%",
                                  borderRadius: 2,
                                  background: a.battery > 30 ? "#4ade80" : a.battery > 15 ? "#facc15" : "#f87171",
                                }}
                              />
                            </div>
                            <span
                              style={{
                                fontFamily: "'JetBrains Mono', monospace",
                                fontSize: 10,
                                color: "rgba(255,255,255,0.4)",
                              }}
                            >
                              {a.battery.toFixed(0)}%
                            </span>
                          </div>
                        </td>
                        <td
                          style={{
                            padding: "8px 12px",
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 10,
                            color: "rgba(255,255,255,0.4)",
                          }}
                        >
                          {a.load.toFixed(1)}/{a.capacity}kg
                        </td>
                        <td
                          style={{
                            padding: "8px 12px",
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 10,
                            color: "rgba(255,255,255,0.4)",
                          }}
                        >
                          {a.discoveredPeers.length}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {tab === "auctions" && (
            <div
              style={{
                background: "rgba(255,255,255,0.02)",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.06)",
                padding: 16,
                maxHeight: MAP_H,
                overflow: "auto",
              }}
            >
              {engine.auctions.length === 0 ? (
                <div style={{ color: "rgba(255,255,255,0.25)", textAlign: "center", padding: 40, fontSize: 12 }}>
                  No auctions yet. Start the simulation to see P2P bidding.
                </div>
              ) : (
                engine.auctions.slice(0, 15).map((auc) => (
                  <div
                    key={auc.id}
                    style={{
                      marginBottom: 12,
                      padding: 12,
                      background: "rgba(167,139,250,0.04)",
                      borderRadius: 8,
                      border: "1px solid rgba(167,139,250,0.1)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#a78bfa" }}>
                        Auction #{auc.id.slice(0, 4)} · Order {auc.orderId.slice(0, 4)}
                      </span>
                      <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)" }}>Tick {auc.tick}</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {auc.bids.map((bid, i) => (
                        <div
                          key={bid.agentId}
                          style={{
                            padding: "4px 10px",
                            borderRadius: 4,
                            fontSize: 10,
                            fontFamily: "'JetBrains Mono', monospace",
                            background: bid.agentId === auc.winnerId ? "rgba(74,222,128,0.15)" : "rgba(255,255,255,0.03)",
                            border: bid.agentId === auc.winnerId ? "1px solid rgba(74,222,128,0.3)" : "1px solid rgba(255,255,255,0.05)",
                            color: bid.agentId === auc.winnerId ? "#4ade80" : "rgba(255,255,255,0.4)",
                          }}
                        >
                          {bid.vendor} · {bid.score} {bid.agentId === auc.winnerId && "✓"}
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* RIGHT: EVENT LOG */}
        <div
          style={{
            width: 360,
            background: "rgba(255,255,255,0.02)",
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.06)",
            padding: 14,
            maxHeight: MAP_H + 4,
            overflow: "auto",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              color: "rgba(255,255,255,0.3)",
              marginBottom: 10,
            }}
          >
            Event Log · P2P Mesh Activity
          </div>
          {engine.eventLog.map((entry, i) => (
            <LogEntry key={`${entry.tick}-${i}`} entry={entry} />
          ))}
          {engine.eventLog.length === 0 && (
            <div style={{ color: "rgba(255,255,255,0.15)", fontSize: 11, textAlign: "center", padding: 30 }}>
              Press Start to begin simulation
            </div>
          )}
        </div>
      </div>

      {/* PROTOCOL INFO */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
          marginTop: 20,
        }}
      >
        {[
          {
            title: "P2P Discovery",
            desc: "Agents broadcast position & capacity via Vertex mesh. Peers within range auto-connect — no central registry.",
            color: "#38bdf8",
          },
          {
            title: "Auction Protocol",
            desc: "Orders trigger local P2P auctions. Agents bid based on distance, battery, and capacity. Winner assigned in ms.",
            color: "#a78bfa",
          },
          {
            title: "Multi-Hop Handoff",
            desc: "Long-distance orders are relayed: Drone→Robot for indoor, or chained across zones. Negotiated P2P.",
            color: "#fb923c",
          },
          {
            title: "Self-Healing",
            desc: "Agent drops? Its order returns to pending and is re-auctioned instantly. No single point of failure.",
            color: "#2dd4bf",
          },
          {
            title: "Safety Mesh",
            desc: "One node detects hazard → alert propagates through mesh → all agents in zone freeze in milliseconds.",
            color: "#f472b6",
          },
        ].map((p) => (
          <div
            key={p.title}
            style={{
              padding: 16,
              borderRadius: 10,
              background: `${p.color}06`,
              border: `1px solid ${p.color}18`,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, color: p.color, marginBottom: 4 }}>{p.title}</div>
            <div style={{ fontSize: 11, lineHeight: 1.5, color: "rgba(255,255,255,0.4)" }}>{p.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

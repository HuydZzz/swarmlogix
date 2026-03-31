"""
SwarmLogix — P2P Last-Mile Delivery Coordination Engine
========================================================
Vertex Swarm Challenge 2026

Core simulation of decentralized delivery swarm with:
  - P2P Discovery Protocol
  - Auction-based Task Assignment
  - Multi-hop Handoff
  - Self-Healing Recovery
  - Safety Mesh Propagation

Usage:
    python swarmlogix_engine.py              # Run interactive simulation
    python swarmlogix_engine.py --agents 20  # Custom agent count
    python swarmlogix_engine.py --headless   # No TUI, JSON output
"""

import json
import time
import math
import random
import asyncio
import argparse
import uuid
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional
from collections import defaultdict


# ════════════════════════════════════════════════════════════════
# DOMAIN MODELS
# ════════════════════════════════════════════════════════════════

class AgentType(str, Enum):
    DRONE = "drone"
    ROBOT = "robot"
    EBIKE = "ebike"

class AgentStatus(str, Enum):
    IDLE = "idle"
    DELIVERING = "delivering"
    OFFLINE = "offline"
    FROZEN = "frozen"

class OrderStatus(str, Enum):
    PENDING = "pending"
    AUCTIONING = "auctioning"
    ASSIGNED = "assigned"
    IN_TRANSIT = "in_transit"
    HANDOFF = "handoff"
    DELIVERED = "delivered"

AGENT_SPECS = {
    AgentType.DRONE:  {"speed": 3.5, "capacity": 2.0,  "range": 180, "battery_drain": 0.012},
    AgentType.ROBOT:  {"speed": 1.2, "capacity": 5.0,  "range": 90,  "battery_drain": 0.006},
    AgentType.EBIKE:  {"speed": 2.5, "capacity": 8.0,  "range": 250, "battery_drain": 0.008},
}

VENDORS = ["RoyalFleet", "SwiftBot", "AeroLink", "UrbanFleet", "NexDrone"]


@dataclass
class Position:
    x: float
    y: float

    def distance_to(self, other: "Position") -> float:
        return math.sqrt((self.x - other.x) ** 2 + (self.y - other.y) ** 2)


@dataclass
class Agent:
    id: str
    agent_type: AgentType
    vendor: str
    position: Position
    battery: float = 100.0
    capacity: float = 5.0
    load: float = 0.0
    speed: float = 2.0
    comm_range: float = 150.0
    status: AgentStatus = AgentStatus.IDLE
    order_id: Optional[str] = None
    target: Optional[Position] = None
    discovered_peers: list = field(default_factory=list)
    safety_mode: bool = False
    battery_drain: float = 0.008

    def move_toward(self, target: Position, dt: float = 1.0) -> bool:
        """Move toward target. Returns True if arrived."""
        d = self.position.distance_to(target)
        if d < self.speed * 1.5:
            self.position.x = target.x
            self.position.y = target.y
            return True
        angle = math.atan2(target.y - self.position.y, target.x - self.position.x)
        self.position.x += math.cos(angle) * self.speed * dt
        self.position.y += math.sin(angle) * self.speed * dt
        self.battery = max(0, self.battery - self.battery_drain)
        return False


@dataclass
class Order:
    id: str
    pickup: Position
    delivery: Position
    weight: float
    status: OrderStatus = OrderStatus.PENDING
    assigned_agent: Optional[str] = None
    handoff_agent: Optional[str] = None
    created_at: int = 0


@dataclass
class AuctionBid:
    agent_id: str
    vendor: str
    agent_type: str
    score: float
    distance: float


@dataclass
class AuctionResult:
    id: str
    order_id: str
    bids: list
    winner_id: str
    tick: int


@dataclass
class HandoffEvent:
    id: str
    order_id: str
    from_agent: str
    to_agent: str
    handoff_point: Position
    tick: int
    completed: bool = False


@dataclass
class SafetyAlert:
    id: str
    position: Position
    radius: float
    tick: int
    active: bool = True
    frozen_count: int = 0


@dataclass
class EventLog:
    tick: int
    source: str
    message: str
    event_type: str = "info"


# ════════════════════════════════════════════════════════════════
# SWARM ENGINE
# ════════════════════════════════════════════════════════════════

class SwarmEngine:
    """
    Core SwarmLogix coordination engine.
    
    Implements 5 decentralized protocols:
    1. P2P Discovery — agents broadcast state, discover peers within range
    2. Auction Protocol — orders are bid on locally, no central dispatcher
    3. Multi-Hop Handoff — long deliveries relayed between agents
    4. Self-Healing — failed agents' orders re-auctioned automatically
    5. Safety Mesh — hazard alerts propagate through the mesh instantly
    """

    MAP_W = 800
    MAP_H = 520

    def __init__(self):
        self.agents: list[Agent] = []
        self.orders: list[Order] = []
        self.auctions: list[AuctionResult] = []
        self.handoffs: list[HandoffEvent] = []
        self.safety_alerts: list[SafetyAlert] = []
        self.connections: list[dict] = []
        self.event_log: list[EventLog] = []
        self.tick = 0
        self.stats = {
            "delivered": 0,
            "auctions_run": 0,
            "handoffs_completed": 0,
            "self_heals": 0,
            "safety_alerts": 0,
        }

    def init_swarm(self, count: int = 15) -> "SwarmEngine":
        """Initialize swarm with random multi-vendor agents."""
        for _ in range(count):
            agent_type = random.choice(list(AgentType))
            spec = AGENT_SPECS[agent_type]
            agent = Agent(
                id=uuid.uuid4().hex[:8],
                agent_type=agent_type,
                vendor=random.choice(VENDORS),
                position=Position(
                    random.uniform(40, self.MAP_W - 40),
                    random.uniform(40, self.MAP_H - 40),
                ),
                battery=random.uniform(60, 100),
                capacity=spec["capacity"],
                speed=spec["speed"] * random.uniform(0.85, 1.15),
                comm_range=spec["range"],
                battery_drain=spec["battery_drain"],
            )
            self.agents.append(agent)

        self._log("SYSTEM", f"Swarm initialized: {count} agents from {len(VENDORS)} vendors")
        return self

    # ─── PROTOCOL 1: P2P DISCOVERY ───────────────────────────

    def run_discovery(self):
        """Each agent discovers peers within communication range."""
        self.connections.clear()
        for agent in self.agents:
            if agent.status == AgentStatus.OFFLINE:
                continue
            agent.discovered_peers.clear()
            for peer in self.agents:
                if agent.id == peer.id or peer.status == AgentStatus.OFFLINE:
                    continue
                d = agent.position.distance_to(peer.position)
                if d < agent.comm_range:
                    agent.discovered_peers.append(peer.id)
                    self.connections.append({
                        "from": agent.id,
                        "to": peer.id,
                        "strength": round(1 - d / agent.comm_range, 3),
                    })

    # ─── PROTOCOL 2: AUCTION-BASED TASK ASSIGNMENT ───────────

    def run_auctions(self):
        """Pending orders trigger local P2P auctions among nearby idle agents."""
        pending = [o for o in self.orders if o.status == OrderStatus.PENDING]
        for order in pending:
            candidates = [
                a for a in self.agents
                if a.status == AgentStatus.IDLE
                and not a.safety_mode
                and a.capacity >= order.weight
                and a.battery > 20
                and a.position.distance_to(order.pickup) < a.comm_range * 1.5
            ]
            if not candidates:
                continue

            order.status = OrderStatus.AUCTIONING

            # Calculate bid scores
            bids = []
            for a in candidates:
                d = a.position.distance_to(order.pickup)
                max_d = a.comm_range * 1.5
                score = (
                    (1 - d / max_d) * 0.4
                    + (a.battery / 100) * 0.3
                    + (1 - a.load / a.capacity) * 0.3
                )
                bids.append(AuctionBid(
                    agent_id=a.id,
                    vendor=a.vendor,
                    agent_type=a.agent_type.value,
                    score=round(score, 4),
                    distance=round(d, 1),
                ))

            bids.sort(key=lambda b: b.score, reverse=True)
            winner_bid = bids[0]
            winner = next(a for a in self.agents if a.id == winner_bid.agent_id)

            # Record auction
            result = AuctionResult(
                id=uuid.uuid4().hex[:8],
                order_id=order.id,
                bids=[{"agent_id": b.agent_id, "vendor": b.vendor, "score": b.score} for b in bids],
                winner_id=winner.id,
                tick=self.tick,
            )
            self.auctions.insert(0, result)
            if len(self.auctions) > 50:
                self.auctions = self.auctions[:50]

            # Assign
            winner.status = AgentStatus.DELIVERING
            winner.order_id = order.id
            winner.target = order.pickup
            winner.load = order.weight
            order.status = OrderStatus.ASSIGNED
            order.assigned_agent = winner.id
            self.stats["auctions_run"] += 1

            self._log(
                "AUCTION",
                f"Order {order.id[:4]}: {len(bids)} bids → {winner.vendor}/{winner.agent_type.value} wins (score {winner_bid.score})",
                "auction",
            )

    # ─── PROTOCOL 3: MULTI-HOP HANDOFF ──────────────────────

    def _try_handoff(self, agent: Agent, order: Order):
        """Attempt to find a relay agent for long-distance delivery."""
        total_dist = Position(order.pickup.x, order.pickup.y).distance_to(order.delivery)
        need_handoff = (
            total_dist > agent.comm_range * 0.8
            or (agent.agent_type == AgentType.DRONE and random.random() < 0.3)
        )
        if not need_handoff:
            return

        mid = Position(
            (agent.position.x + order.delivery.x) / 2,
            (agent.position.y + order.delivery.y) / 2,
        )
        candidates = [
            a for a in self.agents
            if a.id != agent.id
            and a.status == AgentStatus.IDLE
            and not a.safety_mode
            and a.capacity >= order.weight
            and a.position.distance_to(mid) < 200
        ]
        if not candidates:
            return

        relay = min(candidates, key=lambda a: a.position.distance_to(order.delivery))
        t = 0.4 + random.random() * 0.2
        handoff_point = Position(
            agent.position.x + (order.delivery.x - agent.position.x) * t,
            agent.position.y + (order.delivery.y - agent.position.y) * t,
        )

        agent.target = handoff_point
        order.status = OrderStatus.HANDOFF
        order.handoff_agent = relay.id

        event = HandoffEvent(
            id=uuid.uuid4().hex[:8],
            order_id=order.id,
            from_agent=agent.id,
            to_agent=relay.id,
            handoff_point=handoff_point,
            tick=self.tick,
        )
        self.handoffs.append(event)
        self._log(
            "HANDOFF",
            f"Planned: {agent.vendor}/{agent.agent_type.value} → {relay.vendor}/{relay.agent_type.value} for order {order.id[:4]}",
            "handoff",
        )

    def _complete_handoff(self, agent: Agent, order: Order):
        """Complete handoff: transfer order to relay agent."""
        hf = next(
            (h for h in self.handoffs if h.order_id == order.id and not h.completed),
            None,
        )
        if not hf:
            return

        relay = next((a for a in self.agents if a.id == hf.to_agent), None)
        if not relay or relay.status == AgentStatus.OFFLINE:
            order.status = OrderStatus.IN_TRANSIT
            agent.target = order.delivery
            return

        hf.completed = True
        relay.status = AgentStatus.DELIVERING
        relay.order_id = order.id
        relay.target = order.delivery
        relay.load = order.weight
        order.status = OrderStatus.IN_TRANSIT
        order.assigned_agent = relay.id

        agent.status = AgentStatus.IDLE
        agent.order_id = None
        agent.load = 0
        agent.target = None

        self.stats["handoffs_completed"] += 1
        self._log(
            "HANDOFF",
            f"✓ {agent.vendor}/{agent.agent_type.value} → {relay.vendor}/{relay.agent_type.value} completed for order {order.id[:4]}",
            "handoff",
        )

    # ─── PROTOCOL 4: SELF-HEALING ────────────────────────────

    def trigger_agent_failure(self, agent: Agent, reason: str = "random"):
        """Simulate agent failure and automatic recovery."""
        if agent.status == AgentStatus.OFFLINE:
            return

        had_order = agent.order_id
        agent.status = AgentStatus.OFFLINE
        agent.target = None
        self._log("FAULT", f"⚠ {agent.vendor}/{agent.agent_type.value} offline ({reason})", "error")

        # Re-auction the order
        order = next((o for o in self.orders if o.id == had_order), None)
        if order and order.status != OrderStatus.DELIVERED:
            order.status = OrderStatus.PENDING
            order.assigned_agent = None
            self.stats["self_heals"] += 1
            self._log("HEAL", f"Re-auctioning order {order.id[:4]} after agent failure", "heal")

        agent.order_id = None
        agent.load = 0
        return agent

    def _maybe_fail_agent(self):
        """Random agent failure (simulates network loss, hardware fault, etc.)."""
        if random.random() > 0.004:
            return
        alive = [a for a in self.agents if a.status != AgentStatus.OFFLINE]
        if len(alive) < 5:
            return
        reason = random.choice(["network_loss", "hardware_fault", "battery_critical"])
        self.trigger_agent_failure(random.choice(alive), reason)

    # ─── PROTOCOL 5: SAFETY MESH ────────────────────────────

    def trigger_safety_alert(self, x: float, y: float, radius: float = 120.0):
        """One node detects hazard → alert propagates → fleet freezes."""
        pos = Position(x, y)
        frozen = 0
        for agent in self.agents:
            if agent.status == AgentStatus.OFFLINE:
                continue
            if agent.position.distance_to(pos) < radius:
                agent.safety_mode = True
                agent.target = None
                frozen += 1

        alert = SafetyAlert(
            id=uuid.uuid4().hex[:8],
            position=pos,
            radius=radius,
            tick=self.tick,
            frozen_count=frozen,
        )
        self.safety_alerts.append(alert)
        self.stats["safety_alerts"] += 1
        self._log(
            "SAFETY",
            f"🛡️ Alert propagated — {frozen} agents frozen in {radius:.0f}m radius",
            "safety",
        )
        return alert

    def _clear_safety_alerts(self):
        """Clear expired safety alerts (after ~80 ticks)."""
        for alert in self.safety_alerts:
            if alert.active and self.tick - alert.tick > 80:
                alert.active = False
                for agent in self.agents:
                    agent.safety_mode = False
                self._log("SAFETY", "Alert cleared — swarm resuming", "safety")

    # ─── ORDER GENERATION ────────────────────────────────────

    def _maybe_spawn_order(self):
        """Randomly generate delivery orders."""
        pending = sum(1 for o in self.orders if o.status == OrderStatus.PENDING)
        if pending >= 5 or random.random() > 0.03:
            return
        order = Order(
            id=uuid.uuid4().hex[:8],
            pickup=Position(random.uniform(60, self.MAP_W - 60), random.uniform(60, self.MAP_H - 60)),
            delivery=Position(random.uniform(60, self.MAP_W - 60), random.uniform(60, self.MAP_H - 60)),
            weight=round(random.uniform(0.5, 6.0), 1),
            created_at=self.tick,
        )
        self.orders.append(order)
        self._log("ORDER", f"New order {order.id[:4]} — {order.weight}kg", "order")

    # ─── MOVEMENT ────────────────────────────────────────────

    def _move_agents(self):
        """Update all agent positions."""
        for agent in self.agents:
            if agent.status == AgentStatus.OFFLINE or agent.safety_mode:
                continue

            agent.battery = max(0, agent.battery - agent.battery_drain * 0.5)
            if agent.battery <= 0:
                self.trigger_agent_failure(agent, "battery_dead")
                continue

            if agent.target:
                arrived = agent.move_toward(agent.target)
                if arrived:
                    self._on_arrival(agent)
            elif agent.status == AgentStatus.IDLE:
                # Random wander
                if random.random() < 0.01:
                    agent.target = Position(
                        max(20, min(self.MAP_W - 20, agent.position.x + random.uniform(-80, 80))),
                        max(20, min(self.MAP_H - 20, agent.position.y + random.uniform(-80, 80))),
                    )

    def _on_arrival(self, agent: Agent):
        """Handle agent arriving at target."""
        order = next((o for o in self.orders if o.id == agent.order_id), None)
        if not order:
            agent.target = None
            agent.status = AgentStatus.IDLE
            return

        if order.status == OrderStatus.ASSIGNED:
            # At pickup → head to delivery
            order.status = OrderStatus.IN_TRANSIT
            agent.target = order.delivery
            self._log("DELIVER", f"{agent.vendor}/{agent.agent_type.value} picked up order {order.id[:4]}", "deliver")
            self._try_handoff(agent, order)

        elif order.status == OrderStatus.HANDOFF:
            # At handoff point → transfer to relay
            self._complete_handoff(agent, order)

        elif order.status == OrderStatus.IN_TRANSIT:
            # At delivery → done!
            order.status = OrderStatus.DELIVERED
            agent.status = AgentStatus.IDLE
            agent.order_id = None
            agent.load = 0
            agent.target = None
            self.stats["delivered"] += 1
            self._log("DELIVER", f"✓ Order {order.id[:4]} delivered by {agent.vendor}/{agent.agent_type.value}!", "success")

    # ─── MAIN LOOP ───────────────────────────────────────────

    def update(self):
        """Single simulation tick."""
        self.tick += 1
        self.run_discovery()
        self._maybe_spawn_order()
        self.run_auctions()
        self._move_agents()
        self._maybe_fail_agent()
        self._clear_safety_alerts()

        # Occasional safety event
        if random.random() < 0.001 and not any(a.active for a in self.safety_alerts):
            self.trigger_safety_alert(
                random.uniform(100, self.MAP_W - 100),
                random.uniform(100, self.MAP_H - 100),
                random.uniform(80, 150),
            )

        # Clean delivered orders
        self.orders = [
            o for o in self.orders
            if o.status != OrderStatus.DELIVERED or self.tick - o.created_at < 600
        ]

    def get_state(self) -> dict:
        """Serialize current state for API/visualization."""
        return {
            "tick": self.tick,
            "stats": self.stats,
            "agents": [
                {
                    "id": a.id,
                    "type": a.agent_type.value,
                    "vendor": a.vendor,
                    "x": round(a.position.x, 1),
                    "y": round(a.position.y, 1),
                    "battery": round(a.battery, 1),
                    "status": a.status.value,
                    "safety_mode": a.safety_mode,
                    "peers": len(a.discovered_peers),
                    "load": round(a.load, 1),
                    "capacity": a.capacity,
                }
                for a in self.agents
            ],
            "orders": [
                {
                    "id": o.id,
                    "status": o.status.value,
                    "weight": o.weight,
                    "pickup": {"x": round(o.pickup.x, 1), "y": round(o.pickup.y, 1)},
                    "delivery": {"x": round(o.delivery.x, 1), "y": round(o.delivery.y, 1)},
                }
                for o in self.orders
                if o.status != OrderStatus.DELIVERED
            ],
            "connections": len(self.connections),
            "recent_events": [
                {"tick": e.tick, "source": e.source, "message": e.message, "type": e.event_type}
                for e in self.event_log[:20]
            ],
        }

    def _log(self, source: str, message: str, event_type: str = "info"):
        self.event_log.insert(0, EventLog(self.tick, source, message, event_type))
        if len(self.event_log) > 200:
            self.event_log = self.event_log[:200]


# ════════════════════════════════════════════════════════════════
# VERTEX SDK INTEGRATION LAYER (Placeholder for real Vertex)
# ════════════════════════════════════════════════════════════════

class VertexPeerNode:
    """
    Adapter for Vertex 2.0 SDK.
    
    In production, this wraps the real Vertex P2P discovery and messaging.
    For the hackathon simulation, it delegates to SwarmEngine.
    
    Replace this class with actual Vertex SDK calls:
        from vertex_sdk import VertexNode, PeerDiscovery, MessageBus
    """

    def __init__(self, agent_id: str, engine: SwarmEngine):
        self.agent_id = agent_id
        self.engine = engine
        self.peers = []

    async def broadcast_state(self, state: dict):
        """Broadcast agent state to Vertex mesh."""
        # In production: self.vertex_node.broadcast(state)
        pass

    async def discover_peers(self) -> list[str]:
        """Discover nearby peers via Vertex."""
        agent = next((a for a in self.engine.agents if a.id == self.agent_id), None)
        if agent:
            return agent.discovered_peers
        return []

    async def send_bid(self, order_id: str, bid_score: float):
        """Send auction bid via Vertex P2P messaging."""
        # In production: self.vertex_node.send(order_id, {"bid": bid_score})
        pass

    async def propagate_safety_alert(self, alert: dict):
        """Propagate safety alert through Vertex mesh."""
        # In production: self.vertex_node.broadcast_urgent(alert)
        pass


# ════════════════════════════════════════════════════════════════
# CLI RUNNER
# ════════════════════════════════════════════════════════════════

def run_interactive(agent_count: int = 15):
    """Run simulation with terminal output."""
    engine = SwarmEngine().init_swarm(agent_count)

    print("\n" + "═" * 60)
    print("  SwarmLogix — P2P Delivery Coordination Simulation")
    print("  Vertex Swarm Challenge 2026")
    print("═" * 60)
    print(f"\n  Agents: {agent_count} | Vendors: {len(VENDORS)}")
    print(f"  Map: {engine.MAP_W}x{engine.MAP_H}")
    print(f"\n  Running 500 ticks...")
    print("─" * 60)

    for _ in range(500):
        engine.update()

        # Print important events
        if engine.event_log and engine.event_log[0].tick == engine.tick:
            evt = engine.event_log[0]
            color = {
                "auction": "\033[95m",
                "deliver": "\033[94m",
                "success": "\033[92m",
                "handoff": "\033[93m",
                "error": "\033[91m",
                "heal": "\033[96m",
                "safety": "\033[95m",
                "order": "\033[93m",
            }.get(evt.event_type, "\033[90m")
            print(f"  {color}[{evt.tick:>4}] [{evt.source:<8}] {evt.message}\033[0m")

        time.sleep(0.02)

    # Final stats
    state = engine.get_state()
    print("\n" + "═" * 60)
    print("  FINAL STATS")
    print("═" * 60)
    for key, val in state["stats"].items():
        print(f"  {key:<22}: {val}")
    print(f"  {'active_agents':<22}: {sum(1 for a in engine.agents if a.status != AgentStatus.OFFLINE)}")
    print(f"  {'total_connections':<22}: {state['connections']}")
    print("═" * 60 + "\n")

    return engine


def run_headless(agent_count: int = 15, ticks: int = 500):
    """Run simulation and output JSON state."""
    engine = SwarmEngine().init_swarm(agent_count)
    for _ in range(ticks):
        engine.update()
    print(json.dumps(engine.get_state(), indent=2))
    return engine


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SwarmLogix P2P Delivery Simulation")
    parser.add_argument("--agents", type=int, default=15, help="Number of agents")
    parser.add_argument("--headless", action="store_true", help="JSON output only")
    parser.add_argument("--ticks", type=int, default=500, help="Simulation ticks")
    args = parser.parse_args()

    if args.headless:
        run_headless(args.agents, args.ticks)
    else:
        run_interactive(args.agents)

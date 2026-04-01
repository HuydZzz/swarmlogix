"""
SwarmLogix API Server
=====================
Serves real-time swarm state over WebSocket and HTTP.
Connect the React dashboard or any client to observe the swarm.

Usage:
    pip install websockets aiohttp
    python api_server.py --agents 20 --port 8765
"""

import json
import asyncio
import argparse
from swarmlogix_engine import SwarmEngine


class SwarmAPIServer:
    def __init__(self, agent_count: int = 15, tick_rate: float = 0.05):
        self.engine = SwarmEngine().init_swarm(agent_count)
        self.tick_rate = tick_rate
        self.clients: set = set()
        self.running = False

    async def simulation_loop(self):
        """Main simulation loop — updates engine and broadcasts state."""
        self.running = True
        print(f"[SwarmLogix] Simulation running at {1/self.tick_rate:.0f} tps")
        while self.running:
            self.engine.update()
            state = self.engine.get_state()
            message = json.dumps(state)

            # Broadcast to all connected clients
            if self.clients:
                await asyncio.gather(
                    *[self._safe_send(client, message) for client in self.clients],
                    return_exceptions=True,
                )
            await asyncio.sleep(self.tick_rate)

    async def _safe_send(self, ws, message):
        try:
            await ws.send(message)
        except Exception:
            self.clients.discard(ws)

    async def handle_client(self, websocket):
        """Handle incoming WebSocket connection."""
        self.clients.add(websocket)
        client_id = id(websocket)
        print(f"[SwarmLogix] Client {client_id} connected ({len(self.clients)} total)")

        try:
            async for message in websocket:
                # Handle commands from dashboard
                try:
                    cmd = json.loads(message)
                    action = cmd.get("action")

                    if action == "kill_agent":
                        alive = [a for a in self.engine.agents if a.status.value != "offline"]
                        if alive:
                            import random
                            self.engine.trigger_agent_failure(random.choice(alive), "manual_kill")

                    elif action == "safety_alert":
                        import random
                        self.engine.trigger_safety_alert(
                            random.uniform(100, 700),
                            random.uniform(100, 420),
                        )

                    elif action == "add_agent":
                        # Hot-add agent to running swarm
                        self.engine.init_swarm(1)

                    elif action == "pause":
                        self.running = False

                    elif action == "resume":
                        asyncio.create_task(self.simulation_loop())

                except json.JSONDecodeError:
                    pass

        except Exception:
            pass
        finally:
            self.clients.discard(websocket)
            print(f"[SwarmLogix] Client {client_id} disconnected ({len(self.clients)} total)")

    async def start(self, host: str = "0.0.0.0", port: int = 8765):
        """Start WebSocket server and simulation."""
        try:
            import websockets
        except ImportError:
            print("[SwarmLogix] Install websockets: pip install websockets")
            print("[SwarmLogix] Falling back to headless mode...")
            for _ in range(500):
                self.engine.update()
            print(json.dumps(self.engine.get_state(), indent=2))
            return

        print(f"\n{'═' * 50}")
        print(f"  SwarmLogix API Server")
        print(f"  WebSocket: ws://{host}:{port}")
        print(f"{'═' * 50}\n")

        async with websockets.serve(self.handle_client, host, port):
            await self.simulation_loop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SwarmLogix API Server")
    parser.add_argument("--agents", type=int, default=15)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--tick-rate", type=float, default=0.05)
    args = parser.parse_args()

    server = SwarmAPIServer(args.agents, args.tick_rate)
    asyncio.run(server.start(port=args.port))

# CHANGELOG

All notable changes to SwarmLogix are documented here.

## [0.3.0] - 2026-04-15

### Added
- Multi-zone routing optimization — agents now calculate optimal paths across London zones
- Weighted auction scoring v2 — added traffic density and delivery urgency as bid factors
- Agent reputation system — agents build trust scores based on delivery success rate
- Vertex consensus latency monitoring — real-time tracking of BFT finality times
- Fleet capacity dashboard widget — shows aggregate fleet utilization across vendors

### Improved
- Auction convergence speed reduced from ~50ms to ~12ms average
- Handoff success rate improved to 94.7% (was 88.2%)
- Safety mesh propagation now sub-50ms for 20-node swarms
- Battery drain model updated with realistic curves per agent type

### Fixed
- Edge case where simultaneous handoff requests could deadlock two agents
- Safety zone radius calculation now accounts for agent velocity vectors
- Memory leak in event log when running simulations beyond 10,000 ticks

## [0.2.0] - 2026-04-11

### Added
- Tashi Vertex consensus integration (Rust) — real P2P BFT coordination
- SwarmMessage protocol with 11 message types via Vertex transactions
- 3-node Vertex swarm demo with automatic keypair generation
- `run_swarm.sh` launcher for quick multi-node testing
- Vercel deployment with live dashboard at swarmlogix.vercel.app

### Improved
- Dashboard redesigned with Tashi brand identity (orange #FF6B00, Space Mono)
- README updated with Vertex SDK integration documentation

## [0.1.0] - 2026-04-01

### Added
- Initial SwarmLogix engine with 5 core P2P protocols
- Python simulation engine with 15+ multi-vendor agents
- Interactive React dashboard with real-time Canvas visualization
- Protocol validation test suite (34/34 tests passing)
- WebSocket API server for real-time state streaming
- Architecture documentation
- London metro zones: Camden, Canary Wharf, Greenwich, Shoreditch

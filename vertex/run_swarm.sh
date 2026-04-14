#!/bin/bash
# SwarmLogix — Launch 3-node Vertex P2P Swarm
# Run from the vertex/ directory: ./run_swarm.sh

set -e

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  SWARMLOGIX · 3-Node Vertex Swarm Launcher      ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# Build first
echo "  Building SwarmLogix..."
cargo build --release --examples 2>&1 | tail -1
echo ""

# Generate 3 keypairs
echo "  Generating Vertex keypairs..."
KEY1=$(cargo run --release --example key-generate 2>/dev/null)
KEY1_SECRET=$(echo "$KEY1" | grep "Secret:" | awk '{print $2}')
KEY1_PUBLIC=$(echo "$KEY1" | grep "Public:" | awk '{print $2}')

KEY2=$(cargo run --release --example key-generate 2>/dev/null)
KEY2_SECRET=$(echo "$KEY2" | grep "Secret:" | awk '{print $2}')
KEY2_PUBLIC=$(echo "$KEY2" | grep "Public:" | awk '{print $2}')

KEY3=$(cargo run --release --example key-generate 2>/dev/null)
KEY3_SECRET=$(echo "$KEY3" | grep "Secret:" | awk '{print $2}')
KEY3_PUBLIC=$(echo "$KEY3" | grep "Public:" | awk '{print $2}')

echo "  ✓ 3 keypairs generated"
echo ""
echo "  Launching swarm nodes..."
echo "  ─────────────────────────────────────"

# Launch 3 nodes in background
cargo run --release --example swarm-node -- \
  -B 127.0.0.1:9001 -K "$KEY1_SECRET" \
  -P "$KEY2_PUBLIC@127.0.0.1:9002" \
  -P "$KEY3_PUBLIC@127.0.0.1:9003" \
  --agent-type drone --vendor RoyalFleet --agent-id drone-001 &
PID1=$!

cargo run --release --example swarm-node -- \
  -B 127.0.0.1:9002 -K "$KEY2_SECRET" \
  -P "$KEY1_PUBLIC@127.0.0.1:9001" \
  -P "$KEY3_PUBLIC@127.0.0.1:9003" \
  --agent-type robot --vendor SwiftBot --agent-id robot-002 &
PID2=$!

cargo run --release --example swarm-node -- \
  -B 127.0.0.1:9003 -K "$KEY3_SECRET" \
  -P "$KEY1_PUBLIC@127.0.0.1:9001" \
  -P "$KEY2_PUBLIC@127.0.0.1:9002" \
  --agent-type ebike --vendor AeroLink --agent-id ebike-003 &
PID3=$!

echo "  ✓ 3 nodes launched (PIDs: $PID1, $PID2, $PID3)"
echo ""
echo "  Press Ctrl+C to stop all nodes"

# Cleanup on exit
trap "kill $PID1 $PID2 $PID3 2>/dev/null; echo '  Swarm stopped.'" EXIT

# Wait for all
wait

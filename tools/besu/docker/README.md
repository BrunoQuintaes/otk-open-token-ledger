# Besu IBFT Local Harness (U4.4)

This harness expects a prepared network layout (genesis + node keys) under:
- tools/besu/docker/network/node1
- tools/besu/docker/network/node2
- tools/besu/docker/network/node3
- tools/besu/docker/network/node4

Required files:
- tools/besu/docker/network/node*/genesis.json (same for all nodes)
- tools/besu/docker/network/node*/data/key (node private key)
- tools/besu/docker/network/node*/data/nodekey (p2p key) OR Besu-generated at first run
- tools/besu/docker/network/node*/data/ (data dir)

U4.4 goal: bring up IBFT chain (Berlin-safe), verify blocks, deploy contracts via node1 RPC :8545.

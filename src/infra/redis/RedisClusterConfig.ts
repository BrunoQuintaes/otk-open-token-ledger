/**
 * MR-02 — RedisClusterConfig
 *
 * Redis Cluster configuration for cross-region state sharing.
 * Activated by setting OTK_REDIS_CLUSTER=true in the environment.
 *
 * Node list format (OTK_REDIS_CLUSTER_NODES):
 *   Comma-separated list of host:port pairs.
 *   Example: "redis-0.example.com:6380,redis-1.example.com:6380"
 *
 * @module infra/redis/RedisClusterConfig
 * @since W9-C (MR-02)
 */

export interface RedisClusterNode {
  host: string;
  port: number;
}

/**
 * Parse the OTK_REDIS_CLUSTER_NODES environment variable into an array of
 * RedisClusterNode objects.
 *
 * Returns an empty array when the variable is unset or contains no valid
 * host:port entries.
 */
export function getClusterNodes(): RedisClusterNode[] {
  const raw = process.env['OTK_REDIS_CLUSTER_NODES'];
  if (!raw) return [];

  const nodes: RedisClusterNode[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.lastIndexOf(':');
    if (colonIdx <= 0) continue;
    const host = trimmed.slice(0, colonIdx).trim();
    const portStr = trimmed.slice(colonIdx + 1).trim();
    const port = parseInt(portStr, 10);
    if (host && !isNaN(port) && port > 0 && port < 65536) {
      nodes.push({ host, port });
    }
  }
  return nodes;
}

/**
 * Returns true when Redis Cluster mode is enabled via OTK_REDIS_CLUSTER=true.
 */
export function isClusterEnabled(): boolean {
  return process.env['OTK_REDIS_CLUSTER'] === 'true';
}

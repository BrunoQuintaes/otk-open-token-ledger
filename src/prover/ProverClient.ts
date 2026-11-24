/**
 * ProverClient — HTTP client for ProverDaemon (S5.1)
 *
 * Thin async wrapper for POST /prove + GET /status/:jobId polling.
 * Used by OTKSDK.submitReceipt() to obtain real ZK proofs without
 * bundling snarkjs into the SDK layer.
 *
 * Default URL: OTK_PROVER_URL env var || 'http://localhost:3001'
 *
 * @module prover/ProverClient
 * @since Wave 4 (4A-PACK-4A01 / S5.1)
 */

import type { ProofInput } from './ProofQueue.js';

export interface ProverProofResult {
  proof: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  };
  publicSignals: string[];
  proveMs: number;
  /** Key file basename without .zkey extension (S5.2) */
  keyVersion?: string;
  /** Circuit version used: 'v1' | 'v2' (S5.2) */
  circuitVersion?: string;
}

export interface ProverJobResult {
  jobId: string;
  status: 'pending' | 'processing' | 'done' | 'failed' | 'dead_letter';
  result?: ProverProofResult;
  txHash?: string;
  error?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface ProverPollOpts {
  /** Max wait time in ms before throwing (default: 120_000) */
  timeoutMs?: number;
  /** Polling interval in ms (default: 500) */
  pollIntervalMs?: number;
}

export class ProverClient {
  private readonly _baseUrl: string;

  constructor(baseUrl?: string) {
    this._baseUrl = (
      baseUrl ?? process.env['OTK_PROVER_URL'] ?? 'http://localhost:3001'
    ).replace(/\/$/, '');
  }

  /**
   * Submit a proof request to the ProverDaemon.
   * Returns the jobId for status polling.
   */
  async submit(input: ProofInput): Promise<string> {
    const res = await fetch(`${this._baseUrl}/prove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ProverClient.submit: HTTP ${res.status} — ${body}`);
    }
    const data = (await res.json()) as { jobId: string };
    return data.jobId;
  }

  /**
   * Poll job status until terminal state (done/failed/dead_letter) or timeout.
   */
  async poll(jobId: string, opts?: ProverPollOpts): Promise<ProverJobResult> {
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const pollIntervalMs = opts?.pollIntervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const res = await fetch(`${this._baseUrl}/status/${encodeURIComponent(jobId)}`);
      if (!res.ok) {
        throw new Error(`ProverClient.poll: HTTP ${res.status}`);
      }
      const job = (await res.json()) as ProverJobResult;

      if (
        job.status === 'done' ||
        job.status === 'failed' ||
        job.status === 'dead_letter'
      ) {
        return job;
      }

      await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
    }

    throw new Error(
      `ProverClient.poll: timeout after ${timeoutMs}ms waiting for job ${jobId}`,
    );
  }

  /**
   * Submit + poll in one call. Returns the completed job.
   * Throws if the job fails or times out.
   */
  async prove(input: ProofInput, pollOpts?: ProverPollOpts): Promise<ProverJobResult> {
    const jobId = await this.submit(input);
    return this.poll(jobId, pollOpts);
  }

  /** Check daemon health. */
  async health(): Promise<{
    status: string;
    circuits: Record<string, string>;
    queueSize: number;
  }> {
    const res = await fetch(`${this._baseUrl}/health`);
    if (!res.ok) {
      throw new Error(`ProverClient.health: HTTP ${res.status}`);
    }
    return (await res.json()) as { status: string; circuits: Record<string, string>; queueSize: number };
  }
}

/** Factory: creates ProverClient from OTK_PROVER_URL env var. */
export function createProverClientFromEnv(): ProverClient {
  return new ProverClient(process.env['OTK_PROVER_URL']);
}

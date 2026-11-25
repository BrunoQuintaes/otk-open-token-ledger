/**
 * UsageLedger — append-only JSONL writer + CSV snapshot exporter (U7.8)
 *
 * Stores one UsageEvent per line as JSONL (newline-delimited JSON).
 * Provides CSV export for dissertation evidence / spreadsheet analysis.
 *
 * SECURITY: Rejects events containing forbidden fields (apiKey, prompt, headers, etc.)
 *
 * The forbidden-key check looks at top-level keys only. Writes are synchronous file appends with no
 * locking, so one process per ledger file is assumed. Read by the economics reports
 * (`src/pricing/economics/CostReconciliation.ts`, `EconomicReport.ts`).
 *
 * @module src/metering/ledger/UsageLedger
 */
import fs from "node:fs";
import path from "node:path";
import { UsageEvent } from "./UsageEvent.js";

/** Fields that must never appear in a ledger entry */
const FORBIDDEN_KEYS = [
  "apiKey", "api_key", "authorization", "headers",
  "prompt", "rawResponse", "raw_response", "key", "secret", "token",
] as const;

/** Append-only JSONL ledger of {@link UsageEvent} records, with a CSV export. */
export class UsageLedger {
  /**
   * Binds the ledger to one JSONL file; nothing is read or written until the first call.
   *
   * @param jsonlPath - Path of the JSONL file (created on first append).
   */
  constructor(private readonly jsonlPath: string) {}

  /**
   * Append a single UsageEvent to the JSONL ledger.
   * Creates the file (and parent directories) on first write.
   *
   * @param event - The event to store; not mutated.
   * @throws {Error} If any forbidden field is present in the event (nothing is written then).
   */
  append(event: UsageEvent): void {
    const asRecord = event as Record<string, unknown>;
    for (const k of FORBIDDEN_KEYS) {
      if (k in asRecord) {
        throw new Error(`UsageLedger: forbidden field detected in event: "${k}"`);
      }
    }

    const line = JSON.stringify(event) + "\n";
    fs.mkdirSync(path.dirname(this.jsonlPath), { recursive: true });
    fs.appendFileSync(this.jsonlPath, line, { encoding: "utf8" });
  }

  /**
   * Export the full ledger as a CSV file.
   *
   * Overwrites `csvPath` and creates its parent directories. Absent optional fields become empty cells.
   *
   * @param csvPath - Destination CSV path.
   * @throws {Error} If the JSONL ledger file does not exist, or a line is not valid JSON.
   */
  exportCsv(csvPath: string): void {
    if (!fs.existsSync(this.jsonlPath)) {
      throw new Error(`UsageLedger: JSONL ledger not found at ${this.jsonlPath}`);
    }

    const lines = fs.readFileSync(this.jsonlPath, "utf8")
      .split("\n")
      .filter(Boolean);
    const events = lines.map((l) => JSON.parse(l) as UsageEvent);

    const header = [
      "iso", "tsUnix", "provider", "model",
      "inputTokens", "outputTokens", "totalTokens",
      "latencyMs", "costUnits", "currency", "cost", "requestId", "sessionTag",
    ].join(",");

    const rows = events.map((e) =>
      [
        e.iso, e.tsUnix, e.provider, e.model,
        e.inputTokens, e.outputTokens, e.totalTokens,
        e.latencyMs, e.costUnits,
        e.currency ?? "", e.cost?.toString() ?? "",
        e.requestId ?? "", e.sessionTag ?? "",
      ]
        .map(csvEscape)
        .join(",")
    );

    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    fs.writeFileSync(csvPath, [header, ...rows].join("\n") + "\n", "utf8");
  }
}

// Quotes a cell only when it contains a comma, a quote or a newline (RFC 4180 style).
function csvEscape(v: string | number): string {
  const s = String(v ?? "");
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

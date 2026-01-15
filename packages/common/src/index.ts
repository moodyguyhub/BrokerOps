import { z } from "zod";
import { v4 as uuidv4 } from "uuid";

export const TraceId = z.string().min(8);

export function newTraceId(): string {
  return uuidv4();
}

export const OrderRequestSchema = z.object({
  clientOrderId: z.string().min(3),
  symbol: z.string().min(1),
  side: z.enum(["BUY", "SELL"]),
  qty: z.number().int().positive(),
  price: z.number().positive().optional()
});

export type OrderRequest = z.infer<typeof OrderRequestSchema>;

export type RiskDecision =
  | { decision: "ALLOW"; reasonCode: string; policyVersion: string }
  | { decision: "BLOCK"; reasonCode: string; policyVersion: string };

export type AuditEvent = {
  traceId: string;
  eventType: string;
  eventVersion: string;
  payload: unknown;
  prevHash: string | null;
  hash: string;      // sha256(prevHash + canonical_json(payload))
  createdAt: string; // ISO
};

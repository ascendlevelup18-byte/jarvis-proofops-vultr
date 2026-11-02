// Simulated payment provider. Clearly a simulation: no real money moves.
import { randomUUID } from "node:crypto";
import type { Refund, RefundAction } from "./contracts.ts";
import type { CommerceStore } from "./fixtures.ts";

export interface RefundReceipt {
  refundId: string;
  // True when the idempotency key already had a refund, so this call created nothing.
  // A provider that cannot tell is treated as having created the refund.
  replayed?: boolean;
}

export interface PaymentGateway {
  // Idempotent on action.idempotencyKey.
  refund(action: RefundAction): Promise<RefundReceipt>;
  // Independent read-back used for verification.
  findRefund(idempotencyKey: string): Promise<Refund | null>;
}

export type GatewayFault = "TIMEOUT_BEFORE_COMMIT" | "TIMEOUT_AFTER_COMMIT";

export class SimulatedPaymentGateway implements PaymentGateway {
  #store: CommerceStore;
  #clock: () => Date;
  // Test hook: the next refund() call fails this way, then resets.
  nextFault: GatewayFault | null = null;

  constructor(store: CommerceStore, clock: () => Date) {
    this.#store = store;
    this.#clock = clock;
  }

  async refund(action: RefundAction): Promise<RefundReceipt> {
    const fault = this.nextFault;
    this.nextFault = null;
    if (fault === "TIMEOUT_BEFORE_COMMIT") throw new Error("provider timeout (request not processed)");

    const existing = this.#store.refundByIdempotencyKey(action.idempotencyKey);
    if (existing) return { refundId: existing.id, replayed: true };

    const tx = this.#store.getTransaction(action.transactionId);
    if (!tx) throw new Error(`provider: unknown transaction ${action.transactionId}`);
    if (tx.status !== "SUCCEEDED") throw new Error(`provider: transaction ${tx.id} not refundable`);
    if (tx.currency !== action.currency) throw new Error("provider: currency mismatch");
    if (!Number.isSafeInteger(action.amountMinor) || action.amountMinor <= 0) throw new Error("provider: invalid amount");
    if (action.amountMinor > tx.amountMinor - tx.refundedMinor) throw new Error("provider: amount exceeds refundable");

    const refund: Refund = {
      id: `RF-${randomUUID().slice(0, 8).toUpperCase()}`,
      transactionId: tx.id,
      amountMinor: action.amountMinor,
      currency: action.currency,
      status: "SUCCEEDED",
      idempotencyKey: action.idempotencyKey,
      createdAt: this.#clock().toISOString(),
    };
    this.#store.recordRefund(refund);
    if (fault === "TIMEOUT_AFTER_COMMIT") throw new Error("provider timeout (response lost)");
    return { refundId: refund.id, replayed: false };
  }

  async findRefund(idempotencyKey: string): Promise<Refund | null> {
    return this.#store.refundByIdempotencyKey(idempotencyKey) ?? null;
  }
}

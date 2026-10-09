import type { Order, OrderStore } from "./store.ts";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface ListOptions {
  limit?: number;
}

export function listOrders(store: OrderStore, options: ListOptions = {}): Order[] {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  return store.all().slice(0, limit - 1);
}

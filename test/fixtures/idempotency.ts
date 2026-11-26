import assert from "node:assert/strict";

export interface IdempotencyRouteResponse {
  status: number;
  body: unknown;
}

export interface IdempotencyConformanceOptions<TSnapshot> {
  expectedStatus: number;
  invoke(opId: string): Promise<IdempotencyRouteResponse>;
  invokeConflicting(opId: string): Promise<IdempotencyRouteResponse>;
  snapshot(): TSnapshot | Promise<TSnapshot>;
  opId: string;
}

/**
 * Reusable conformance check for structurally idempotent mutating routes:
 *  1. First call with `opId` succeeds with `expectedStatus`.
 *  2. Second call with the same `opId` and identical payload returns the exact
 *     same status and body with zero additional persisted side effects.
 *  3. Third call with the same `opId` and mutated payload returns `409 Conflict`
 *     with zero additional persisted side effects.
 */
export async function assertIdempotentRoute<TSnapshot>(
  options: IdempotencyConformanceOptions<TSnapshot>,
): Promise<{
  first: IdempotencyRouteResponse;
  replay: IdempotencyRouteResponse;
  conflict: IdempotencyRouteResponse;
}> {
  const first = await options.invoke(options.opId);
  assert.equal(first.status, options.expectedStatus);
  const afterFirst = await options.snapshot();

  const replay = await options.invoke(options.opId);
  assert.equal(replay.status, first.status);
  assert.deepEqual(replay.body, first.body);
  assert.deepEqual(await options.snapshot(), afterFirst);

  const conflict = await options.invokeConflicting(options.opId);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await options.snapshot(), afterFirst);

  return { first, replay, conflict };
}

import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const logPath = process.env.WEBAGENT_REGRESSION_OBSERVER;
const fixedNow = Number(
  process.env.WEBAGENT_REGRESSION_NOW ?? Date.UTC(2026, 8, 13, 21, 0, 0),
);
const require = createRequire(import.meta.url);

let uuidCounter = 0;
let byteCounter = 0;
const crypto: typeof import("node:crypto") = require("node:crypto");
crypto.randomUUID = () => {
  uuidCounter += 1;
  const hex = uuidCounter.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
};
crypto.randomBytes = ((
  size: number,
  callback?: (error: null, bytes: Buffer) => void,
) => {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) {
    byteCounter += 1;
    bytes[index] = byteCounter % 251;
  }
  if (callback) {
    queueMicrotask(() => {
      callback(null, bytes);
    });
    return undefined;
  }
  return bytes;
}) as typeof crypto.randomBytes;
syncBuiltinESMExports();

Math.random = () => {
  byteCounter += 1;
  return (byteCounter % 10_000) / 10_000;
};

const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) {
      super(fixedNow);
    } else {
      super(args[0] as string | number);
    }
  }
  static now(): number {
    return fixedNow;
  }
}
globalThis.Date = FixedDate as DateConstructor;

function record(entry: Record<string, unknown>): void {
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

if (process.env.WEBAGENT_REGRESSION_SQL === "1") {
  type TransactionFunction = ((...args: unknown[]) => unknown) & {
    deferred: (...args: unknown[]) => unknown;
    immediate: (...args: unknown[]) => unknown;
    exclusive: (...args: unknown[]) => unknown;
  };
  const BetterSqlite3: {
    prototype: {
      prepare(sql: string): Record<string, unknown>;
      transaction(fn: (...args: unknown[]) => unknown): TransactionFunction;
    };
  } = require("better-sqlite3");
  let transactionDepth = 0;
  let transactionId = 0;

  // eslint-disable-next-line @typescript-eslint/unbound-method -- the wrapper intentionally preserves the database receiver
  const transaction = BetterSqlite3.prototype.transaction;
  BetterSqlite3.prototype.transaction = function (fn) {
    const wrapped = Reflect.apply<
      unknown,
      [(...args: unknown[]) => unknown],
      TransactionFunction
    >(transaction, this, [fn]);
    return trackTransaction(wrapped);
  };

  function trackTransaction(wrapped: TransactionFunction): TransactionFunction {
    const invoke = (call: (...args: unknown[]) => unknown) =>
      function (this: unknown, ...args: unknown[]) {
        if (transactionDepth === 0) transactionId += 1;
        transactionDepth += 1;
        try {
          return Reflect.apply(call, this, args);
        } finally {
          transactionDepth -= 1;
        }
      };
    const tracked = invoke(wrapped) as TransactionFunction;
    tracked.deferred = invoke(wrapped.deferred);
    tracked.immediate = invoke(wrapped.immediate);
    tracked.exclusive = invoke(wrapped.exclusive);
    return tracked;
  }

  // eslint-disable-next-line @typescript-eslint/unbound-method -- the wrapper intentionally preserves the database receiver
  const prepare = BetterSqlite3.prototype.prepare;
  BetterSqlite3.prototype.prepare = function (sql: string) {
    const statement = Reflect.apply<unknown, [string], Record<string, unknown>>(
      prepare,
      this,
      [sql],
    );
    for (const method of ["run", "get", "all", "iterate"] as const) {
      const original = statement[method];
      if (typeof original !== "function") continue;
      statement[method] = (...args: unknown[]) => {
        const normalized = sql.trimStart();
        // `readonly` (not `reader`): `INSERT/UPDATE … RETURNING` returns rows but still writes.
        if (statement.readonly === true) {
          record({ kind: "read" });
        } else {
          const group = transactionDepth > 0 ? transactionId : ++transactionId;
          record({
            kind: "write",
            transaction: group,
            method,
            sql: normalized,
            args,
          });
        }
        return Reflect.apply(original, statement, args);
      };
    }
    return statement;
  };
}

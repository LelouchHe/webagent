/**
 * A value that may change while someone is looking at it.
 *
 * The consumer only renders what `read()` returns and re-reads when told to.
 * Where the value comes from, and when it is refreshed, is the source's own
 * business: a source may, for example, answer with what it already has and
 * refresh itself when a watch starts.
 */

/** What a source holds right now. */
export type LiveState<T> = T | "loading" | { error: string };

export interface LiveSource<T> {
  read(): LiveState<T>;
  /** Call `onChange` whenever `read()` may differ; returns how to stop. */
  watch(onChange: () => void): () => void;
}

export function isLiveSource<T>(value: unknown): value is LiveSource<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LiveSource<T>).read === "function" &&
    typeof (value as LiveSource<T>).watch === "function"
  );
}

/** A source whose value is `derive` applied to another source's value. */
export function deriveLive<A, B>(
  source: LiveSource<A>,
  derive: (value: A) => B,
): LiveSource<B> {
  return {
    read(): LiveState<B> {
      const state = source.read();
      if (state === "loading") return "loading";
      if (isLiveError(state)) return { error: state.error };
      return derive(state);
    },
    watch: (onChange) => source.watch(onChange),
  };
}

/** A source whose error reads as an empty list, for a picker that has rows of
 *  its own to show. Loading still reads as loading. */
export function errorsAsEmpty<T>(source: LiveSource<T[]>): LiveSource<T[]> {
  return {
    read() {
      const state = source.read();
      return isLiveError(state) ? [] : state;
    },
    watch: (onChange) => source.watch(onChange),
  };
}

/**
 * A source that also reports a change when `subscribe` fires. `subscribe`
 * registers a listener and returns its stop; a watch takes both and stops both,
 * so the extra signal cannot outlive the menu scope that took it.
 */
export function alsoOn<T>(
  source: LiveSource<T>,
  subscribe: (onChange: () => void) => () => void,
): LiveSource<T> {
  return {
    read: () => source.read(),
    watch(onChange) {
      const stopSource = source.watch(onChange);
      const stopSignal = subscribe(onChange);
      return () => {
        stopSignal();
        stopSource();
      };
    },
  };
}

/**
 * A source for a one-shot read that starts when the caller builds it. There is
 * no cache: a new source is made for every input, exactly like the Promise it
 * replaces. `watch` starts nothing; it only reports the settled value or error.
 */
export function onceSource<T>(load: () => Promise<T>): LiveSource<T> {
  let state: LiveState<T> = "loading";
  const listeners = new Set<() => void>();
  const settle = (next: LiveState<T>): void => {
    state = next;
    for (const onChange of [...listeners]) onChange();
  };
  load().then(
    (value) => {
      settle(value);
    },
    (err: unknown) => {
      settle({
        error:
          err instanceof Error && err.message ? err.message : "load failed",
      });
    },
  );
  return {
    read: () => state,
    watch(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };
}

/**
 * A source that shows the last value a load resolved with, and loads when a
 * watch starts. A load starts only when none is in flight, so two loads never
 * overlap. A failure is shown only while there is no value: after a successful
 * load, a later failure keeps the value.
 */
export function refreshingSource<T>(load: () => Promise<T>): LiveSource<T> {
  let value: T | undefined;
  let hasValue = false;
  let error: string | null = null;
  let inFlight: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const onChange of [...listeners]) onChange();
  }

  function startLoad(): void {
    const request = load()
      .then(
        (next) => {
          value = next;
          hasValue = true;
          error = null;
          notify();
        },
        (err: unknown) => {
          if (hasValue) return;
          error =
            err instanceof Error && err.message ? err.message : "load failed";
          notify();
        },
      )
      .finally(() => {
        if (inFlight === request) inFlight = null;
      });
    inFlight = request;
  }

  return {
    read(): LiveState<T> {
      if (hasValue) return value as T;
      return error !== null ? { error } : "loading";
    },
    watch(onChange) {
      listeners.add(onChange);
      if (inFlight === null) startLoad();
      return () => {
        listeners.delete(onChange);
      };
    },
  };
}

function isLiveError(state: unknown): state is { error: string } {
  return (
    typeof state === "object" &&
    state !== null &&
    !Array.isArray(state) &&
    "error" in state
  );
}

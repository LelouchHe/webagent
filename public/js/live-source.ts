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

function isLiveError(state: unknown): state is { error: string } {
  return (
    typeof state === "object" &&
    state !== null &&
    !Array.isArray(state) &&
    "error" in state
  );
}

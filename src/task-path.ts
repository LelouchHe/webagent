/** Server-side syntax primitives for task-target commands. */

export type TaskCommandMarker = "+" | "@" | "@!";

export interface TaskPath {
  /** Whether the path starts from the resolver's root rather than its current node. */
  absolute: boolean;
  /** Decoded path components. Dot components remain for the resolver to interpret. */
  segments: string[];
}

export interface ParsedTaskCommand {
  marker: TaskCommandMarker;
  /** The decoded first shell-style word following the marker. */
  target: string;
  path: TaskPath;
  /** Unmodified source following the target word, including its separating whitespace. */
  remainder: string;
}

/** An invalid command head is rejected rather than being guessed as ordinary input. */
export class TaskPathParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskPathParseError";
  }
}

type ParsedShellWord = {
  value: string;
  end: number;
};

function isWhitespace(char: string): boolean {
  return /\s/u.test(char);
}

function skipWhitespace(source: string, offset: number): number {
  let cursor = offset;
  while (cursor < source.length && isWhitespace(source[cursor])) cursor++;
  return cursor;
}

/**
 * Parse one deliberately small shell-style word.
 *
 * Quotes and backslash escapes exist only as input syntax. This is not a shell:
 * variables, command substitution, globbing, comments, and operators are all
 * ordinary characters.
 */
function parseShellWord(source: string, start: number): ParsedShellWord {
  let cursor = start;
  let value = "";
  let consumed = false;

  while (cursor < source.length && !isWhitespace(source[cursor])) {
    const char = source[cursor];
    if (char === "\\") {
      if (cursor + 1 >= source.length) {
        throw new TaskPathParseError("Target ends with an incomplete escape");
      }
      value += source[cursor + 1];
      cursor += 2;
      consumed = true;
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      cursor++;
      consumed = true;
      let closed = false;
      while (cursor < source.length) {
        const quoted = source[cursor];
        if (quoted === quote) {
          cursor++;
          closed = true;
          break;
        }
        if (quote === '"' && quoted === "\\") {
          if (cursor + 1 >= source.length) {
            throw new TaskPathParseError(
              "Target ends with an incomplete escape inside double quotes",
            );
          }
          value += source[cursor + 1];
          cursor += 2;
          continue;
        }
        value += quoted;
        cursor++;
      }
      if (!closed) {
        throw new TaskPathParseError("Target contains an unterminated quote");
      }
      continue;
    }

    value += char;
    cursor++;
    consumed = true;
  }

  if (!consumed || value.length === 0) {
    throw new TaskPathParseError("Task command requires a non-empty target");
  }
  return { value, end: cursor };
}

/**
 * Decode a slash-separated path without resolving it against a task tree or
 * filesystem. Consecutive separators are normalized; `.` and `..` remain so
 * the receiving resolver can enforce its own root and visibility policy.
 */
export function parseTaskPath(target: string): TaskPath {
  // An empty target is a bare `+`/`@`: the caller lists its default scope
  // instead of resolving a path.
  if (!target) return { absolute: false, segments: [] };
  const absolute = target.startsWith("/");
  const segments = target.split("/").filter(Boolean);
  return { absolute, segments };
}

/**
 * Parse the command marker and its target word. Policy and path resolution are
 * intentionally outside this module; callers retain the raw remainder as the
 * eventual message body or creation brief.
 */
export function parseTaskCommand(source: string): ParsedTaskCommand {
  const markerStart = skipWhitespace(source, 0);
  let marker: TaskCommandMarker;
  let targetStart: number;
  if (source.startsWith("@!", markerStart)) {
    marker = "@!";
    targetStart = markerStart + 2;
  } else if (source[markerStart] === "+" || source[markerStart] === "@") {
    marker = source[markerStart];
    targetStart = markerStart + 1;
  } else {
    throw new TaskPathParseError("Task command must start with +, @, or @!");
  }

  const start = skipWhitespace(source, targetStart);
  if (start >= source.length) {
    return {
      marker,
      target: "",
      path: { absolute: false, segments: [] },
      remainder: source.slice(targetStart),
    };
  }
  const word = parseShellWord(source, start);
  return {
    marker,
    target: word.value,
    path: parseTaskPath(word.value),
    remainder: source.slice(word.end),
  };
}

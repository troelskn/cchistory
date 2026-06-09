import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { JSONLStreamParser } from './jsonl-stream-parser.js';
import { StreamMerger } from './stream-merger.js';
import type { ClaudeCommand } from './types.js';

/** Maximum bytes read per file-system read while draining a growing file. */
const READ_CHUNK_BYTES = 1024 * 1024;

export interface FollowOptions {
  /** Poll interval in milliseconds for detecting appended data. */
  pollMs?: number;
  /**
   * Flush orphaned pending commands (a Bash tool_use whose tool_result never
   * arrived) after this many milliseconds of inactivity. Set to 0 to disable.
   */
  idleFlushMs?: number;
  /** Abort to stop following and let the generator return cleanly. */
  signal?: AbortSignal;
}

const DEFAULT_POLL_MS = 300;
const DEFAULT_IDLE_FLUSH_MS = 10_000;

/**
 * A resumable byte cursor over a single growing JSONL file.
 *
 * Unlike the readline-based parser (which terminates at EOF), a FileTail keeps
 * its read offset, partial-line buffer, multi-byte decoder, and the parser's
 * pending tool_use/tool_result state between reads. Each call to `drain()`
 * consumes whatever has been appended since the previous call and yields the
 * commands found, leaving the cursor ready for the next append.
 */
export class FileTail {
  private offset: number;
  private leftover = '';
  private lineNumber = 0;
  private readonly decoder = new StringDecoder('utf8');
  private readonly parser = new JSONLStreamParser();

  constructor(
    public readonly filePath: string,
    startOffset = 0
  ) {
    this.offset = startOffset;
  }

  /**
   * Read and parse everything appended since the last drain, up to the file's
   * current size. Returns once caught up; partial trailing lines (no newline
   * yet) are buffered until a later drain completes them.
   */
  async *drain(signal?: AbortSignal): AsyncGenerator<ClaudeCommand> {
    let size: number;
    try {
      size = (await stat(this.filePath)).size;
    } catch {
      // File vanished (deleted/rotated away) - nothing to read this round.
      return;
    }

    // Truncation/rotation: the file shrank, so start over from the top.
    if (size < this.offset) {
      this.offset = 0;
      this.leftover = '';
    }

    if (size <= this.offset) return;

    const handle = await open(this.filePath, 'r');
    try {
      while (this.offset < size && !signal?.aborted) {
        const length = Math.min(size - this.offset, READ_CHUNK_BYTES);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;

        const chunk =
          this.leftover + this.decoder.write(buffer.subarray(0, bytesRead));
        const parts = chunk.split('\n');
        // The final element is an incomplete line (no trailing newline yet).
        this.leftover = parts.pop() ?? '';

        for (const part of parts) {
          this.lineNumber++;
          yield* this.parser.processLine(part, this.lineNumber, this.filePath);
        }
      }
    } finally {
      await handle.close();
    }
  }

  /** Flush any unmatched pending commands as unknown-outcome (idle/orphan flush). */
  flushPending(): Generator<ClaudeCommand> {
    return this.parser.flushPending();
  }
}

/**
 * Sleep for `ms`, resolving early if `signal` aborts.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      resolve();
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** List the `.jsonl` files in a project directory (absolute paths). */
async function listJsonlFiles(projectPath: string): Promise<string[]> {
  try {
    const files = await readdir(projectPath);
    return files
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => join(projectPath, file));
  } catch {
    return [];
  }
}

/**
 * Drain all existing JSONL files in a project once, in modification-time order,
 * registering a FileTail for each so the live phase can resume from exactly
 * where catch-up stopped (no gap, no duplicates).
 *
 * Mirrors JSONLStreamParser.createProjectStream so the historical output of
 * follow mode matches non-follow output.
 *
 * `settledBefore` (epoch ms) decides which files are treated as completed
 * sessions: a file untouched at or before it is settled, so any Bash tool_use
 * still awaiting its tool_result is flushed here, in chronological catch-up
 * order. More recently modified files are left pending — they may belong to a
 * live session, so the idle flush in the live loop handles them once they go
 * quiet (a late tool_result can still match in the meantime).
 */
async function* projectCatchup(
  projectPath: string,
  registry: Map<string, FileTail>,
  settledBefore: number,
  signal?: AbortSignal
): AsyncGenerator<ClaudeCommand> {
  const jsonlFiles = await listJsonlFiles(projectPath);

  const fileStats = await Promise.all(
    jsonlFiles.map(async (path) => {
      try {
        return { path, mtime: (await stat(path)).mtime.getTime() };
      } catch {
        return { path, mtime: 0 };
      }
    })
  );
  fileStats.sort((a, b) => a.mtime - b.mtime);

  for (const { path, mtime } of fileStats) {
    const tail = new FileTail(path, 0);
    registry.set(path, tail);
    yield* tail.drain(signal);

    // Flush orphaned pending commands only for files that have been quiet long
    // enough to look like closed sessions. Liveness is judged by mtime age, not
    // by "is this the newest file": there may be zero live sessions (flush them
    // all, newest included) or several concurrent ones (defer them all, so no
    // in-flight command is flushed as unknown before its real result arrives).
    if (mtime <= settledBefore) {
      yield* tail.flushPending();
    }
  }
}

/**
 * Register a FileTail for any `.jsonl` files that have appeared since the last
 * scan (new Claude Code sessions started while following).
 */
async function discoverNewFiles(
  projectPaths: string[],
  registry: Map<string, FileTail>
): Promise<void> {
  for (const projectPath of projectPaths) {
    for (const path of await listJsonlFiles(projectPath)) {
      if (!registry.has(path)) {
        registry.set(path, new FileTail(path, 0));
      }
    }
  }
}

/** Drain every registered tail once, in registration order. */
async function* drainRegistry(
  registry: Map<string, FileTail>,
  signal?: AbortSignal
): AsyncGenerator<ClaudeCommand> {
  for (const tail of registry.values()) {
    if (signal?.aborted) return;
    yield* tail.drain(signal);
  }
}

/** Flush unmatched pending commands across every registered tail. */
function* flushRegistry(
  registry: Map<string, FileTail>
): Generator<ClaudeCommand> {
  for (const tail of registry.values()) {
    yield* tail.flushPending();
  }
}

/**
 * After catch-up, watch the registered files (and any newly created ones) for
 * appended commands, yielding them in arrival order until aborted.
 */
async function* liveLoop(
  projectPaths: string[],
  registry: Map<string, FileTail>,
  options: FollowOptions
): AsyncGenerator<ClaudeCommand> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const idleFlushMs = options.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS;
  const signal = options.signal;

  let lastActivity = Date.now();
  let flushed = false;

  while (!signal?.aborted) {
    await discoverNewFiles(projectPaths, registry);

    let produced = false;
    for await (const command of drainRegistry(registry, signal)) {
      produced = true;
      yield command;
    }

    if (produced) {
      lastActivity = Date.now();
      flushed = false;
    } else if (
      !flushed &&
      idleFlushMs > 0 &&
      Date.now() - lastActivity > idleFlushMs
    ) {
      // No new data for a while: surface any commands still awaiting a result.
      yield* flushRegistry(registry);
      flushed = true;
    }

    if (signal?.aborted) break;
    await delay(pollMs, signal);
  }
}

/**
 * Stream commands like `tail -f`: first drain all existing history, then stay
 * open and yield new commands as Claude Code appends them, until `signal`
 * aborts.
 *
 * Catch-up preserves chronological ordering (single project by file mtime,
 * multiple projects via the chronological merger). The live phase yields in
 * arrival order across files, matching `tail -f file1 file2` semantics.
 */
export async function* createFollowStream(
  projectPaths: string[],
  options: FollowOptions = {}
): AsyncGenerator<ClaudeCommand> {
  const registry = new Map<string, FileTail>();
  const signal = options.signal;
  const idleFlushMs = options.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS;

  // Files last modified at or before this instant are treated as settled
  // (closed sessions) during catch-up; more recently touched ones are deferred
  // to the live loop. Computed once so every project shares one reference time.
  const settledBefore = Date.now() - idleFlushMs;

  // Phase 1: catch up on existing history.
  if (projectPaths.length === 1) {
    yield* projectCatchup(projectPaths[0], registry, settledBefore, signal);
  } else if (projectPaths.length > 1) {
    const merger = new StreamMerger();
    const catchupStreams = projectPaths.map((path) =>
      projectCatchup(path, registry, settledBefore, signal)
    );
    yield* merger.chronologicalMerge(catchupStreams);
  }

  // Phase 2: follow for new appends and new sessions.
  yield* liveLoop(projectPaths, registry, options);
}

import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFollowStream, FileTail } from '../follow-tailer.js';
import type { ClaudeCommand } from '../types.js';

// --- fixtures -------------------------------------------------------------

let seq = 0;

/** A JSONL line for a Bash tool_use. Omitting `id` makes it yield immediately. */
function bashLine(
  command: string,
  opts: { id?: string; timestamp?: string } = {}
): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'Bash',
          ...(opts.id ? { id: opts.id } : {}),
          input: { command },
        },
      ],
    },
    timestamp:
      opts.timestamp ??
      `2025-06-07T12:00:${String(seq++).padStart(2, '0')}.000Z`,
    cwd: '/Users/test/project',
  });
}

/** A JSONL line for a tool_result, matching a previous tool_use by id. */
function resultLine(toolUseId: string, isError = false): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, is_error: isError },
      ],
    },
    timestamp: '2025-06-07T12:30:00.000Z',
  });
}

// --- helpers --------------------------------------------------------------

async function collect(
  gen: AsyncGenerator<ClaudeCommand> | Generator<ClaudeCommand>
): Promise<ClaudeCommand[]> {
  const out: ClaudeCommand[] = [];
  for await (const cmd of gen) out.push(cmd);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition not met before timeout');
    }
    await sleep(10);
  }
}

/** Consume a follow stream in the background into a growing array. */
function background(gen: AsyncGenerator<ClaudeCommand>) {
  const commands: ClaudeCommand[] = [];
  const done = (async () => {
    for await (const cmd of gen) commands.push(cmd);
  })();
  return { commands, done };
}

// --- tests ----------------------------------------------------------------

describe('FileTail', () => {
  let testDir: string;

  beforeEach(async () => {
    seq = 0;
    testDir = join(tmpdir(), `cchistory-follow-${Date.now()}-${seq}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('drains data appended since the previous read', async () => {
    const file = join(testDir, 'a.jsonl');
    await writeFile(file, '');
    const tail = new FileTail(file, 0);

    expect(await collect(tail.drain())).toHaveLength(0);

    await appendFile(file, `${bashLine('echo one')}\n`);
    expect((await collect(tail.drain())).map((c) => c.command)).toEqual([
      'echo one',
    ]);

    // A second drain with no new data yields nothing.
    expect(await collect(tail.drain())).toHaveLength(0);

    await appendFile(file, `${bashLine('echo two')}\n`);
    expect((await collect(tail.drain())).map((c) => c.command)).toEqual([
      'echo two',
    ]);
  });

  it('buffers a partial line until the newline arrives', async () => {
    const file = join(testDir, 'a.jsonl');
    await writeFile(file, '');
    const tail = new FileTail(file, 0);

    const full = bashLine('echo split');
    const half = Math.floor(full.length / 2);

    await appendFile(file, full.slice(0, half));
    expect(await collect(tail.drain())).toHaveLength(0); // incomplete line

    await appendFile(file, `${full.slice(half)}\n`);
    expect((await collect(tail.drain())).map((c) => c.command)).toEqual([
      'echo split',
    ]);
  });

  it('resets from the top when the file is truncated', async () => {
    const file = join(testDir, 'a.jsonl');
    await writeFile(file, `${bashLine('echo a')}\n${bashLine('echo b')}\n`);
    const tail = new FileTail(file, 0);
    expect((await collect(tail.drain())).map((c) => c.command)).toEqual([
      'echo a',
      'echo b',
    ]);

    // Rewrite with smaller content -> size < offset -> reset and re-read.
    await writeFile(file, `${bashLine('echo c')}\n`);
    expect((await collect(tail.drain())).map((c) => c.command)).toEqual([
      'echo c',
    ]);
  });

  it('flushPending surfaces an orphaned pending command', async () => {
    const file = join(testDir, 'a.jsonl');
    await writeFile(file, `${bashLine('echo waiting', { id: 'tool-1' })}\n`);
    const tail = new FileTail(file, 0);

    // Has a tool_use id but no tool_result yet -> held pending.
    expect(await collect(tail.drain())).toHaveLength(0);

    expect([...tail.flushPending()].map((c) => c.command)).toEqual([
      'echo waiting',
    ]);
  });

  it('emits a command once its tool_result arrives', async () => {
    const file = join(testDir, 'a.jsonl');
    await writeFile(file, `${bashLine('echo paired', { id: 'tool-9' })}\n`);
    const tail = new FileTail(file, 0);
    expect(await collect(tail.drain())).toHaveLength(0);

    await appendFile(file, `${resultLine('tool-9')}\n`);
    const cmds = await collect(tail.drain());
    expect(cmds.map((c) => c.command)).toEqual(['echo paired']);
    expect(cmds[0].success).toBe(true);
  });
});

describe('createFollowStream', () => {
  let testDir: string;
  let controller: AbortController;

  beforeEach(async () => {
    seq = 0;
    testDir = join(tmpdir(), `cchistory-follow-stream-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    controller = new AbortController();
  });

  afterEach(async () => {
    controller.abort();
    await rm(testDir, { recursive: true, force: true });
  });

  it('replays history, then yields new commands as they are appended', async () => {
    const file = join(testDir, 's1.jsonl');
    await writeFile(file, `${bashLine('echo h1')}\n`);

    const gen = createFollowStream([testDir], {
      pollMs: 20,
      idleFlushMs: 0,
      signal: controller.signal,
    });
    const { commands, done } = background(gen);

    await waitFor(() => commands.length >= 1);
    await appendFile(file, `${bashLine('echo h2')}\n`);
    await waitFor(() => commands.length >= 2);

    controller.abort();
    await done;

    expect(commands.map((c) => c.command)).toEqual(['echo h1', 'echo h2']);
  });

  it('picks up a session file created after following starts', async () => {
    await writeFile(join(testDir, 's1.jsonl'), `${bashLine('echo old')}\n`);

    const gen = createFollowStream([testDir], {
      pollMs: 20,
      idleFlushMs: 0,
      signal: controller.signal,
    });
    const { commands, done } = background(gen);

    await waitFor(() => commands.length >= 1);
    await writeFile(
      join(testDir, 's2.jsonl'),
      `${bashLine('echo brand-new')}\n`
    );
    await waitFor(() => commands.length >= 2);

    controller.abort();
    await done;

    expect(commands.map((c) => c.command)).toContain('echo brand-new');
  });

  it('merges catch-up history from multiple projects chronologically', async () => {
    const dirA = join(testDir, 'projA');
    const dirB = join(testDir, 'projB');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });

    await writeFile(
      join(dirA, 's.jsonl'),
      `${bashLine('echo a-first', { timestamp: '2025-06-07T12:00:00.000Z' })}\n`
    );
    await writeFile(
      join(dirB, 's.jsonl'),
      `${bashLine('echo b-second', { timestamp: '2025-06-07T12:05:00.000Z' })}\n`
    );

    const gen = createFollowStream([dirA, dirB], {
      pollMs: 20,
      idleFlushMs: 0,
      signal: controller.signal,
    });
    const { commands, done } = background(gen);

    await waitFor(() => commands.length >= 2);
    controller.abort();
    await done;

    expect(commands.slice(0, 2).map((c) => c.command)).toEqual([
      'echo a-first',
      'echo b-second',
    ]);
  });

  it('idle-flushes an unmatched pending command while following', async () => {
    const file = join(testDir, 's1.jsonl');
    await writeFile(file, `${bashLine('echo orphan', { id: 'tool-x' })}\n`);

    const gen = createFollowStream([testDir], {
      pollMs: 20,
      idleFlushMs: 60,
      signal: controller.signal,
    });
    const { commands, done } = background(gen);

    await waitFor(() => commands.length >= 1);
    controller.abort();
    await done;

    expect(commands.map((c) => c.command)).toEqual(['echo orphan']);
  });

  it('flushes orphaned pending commands during catch-up, not in the live phase', async () => {
    // Scenario: an old session file has a tool_use with an ID but no matching
    // tool_result (interrupted/long-running command). A newer session file has
    // a normal command. The orphaned command should appear in chronological
    // catch-up order — before the newer command — not deferred to the idle
    // flush in the live loop.
    const file1 = join(testDir, 's1.jsonl');
    const file2 = join(testDir, 's2.jsonl');

    // Old session: orphaned tool_use (has id, no tool_result)
    await writeFile(
      file1,
      `${bashLine('echo orphan', { id: 'tool-orphan', timestamp: '2025-06-07T11:00:00.000Z' })}\n`
    );
    // Newer session: normal command (no id, yields immediately)
    await writeFile(
      file2,
      `${bashLine('echo newer', { timestamp: '2025-06-07T12:00:00.000Z' })}\n`
    );

    // Set file mtimes so s1 is older than s2
    const { utimes } = await import('node:fs/promises');
    await utimes(
      file1,
      new Date('2025-06-07T11:00:00Z'),
      new Date('2025-06-07T11:00:00Z')
    );
    await utimes(
      file2,
      new Date('2025-06-07T12:00:00Z'),
      new Date('2025-06-07T12:00:00Z')
    );

    const gen = createFollowStream([testDir], {
      pollMs: 20,
      idleFlushMs: 0, // disable idle flush so we can tell where commands come from
      signal: controller.signal,
    });
    const { commands, done } = background(gen);

    // Wait for both commands to appear during catch-up
    await waitFor(() => commands.length >= 2, 3000);
    controller.abort();
    await done;

    // The orphaned command should have been flushed at the end of its file
    // during catch-up, so it appears before the newer command.
    expect(commands.map((c) => c.command)).toEqual([
      'echo orphan',
      'echo newer',
    ]);
  });

  it('flushes a settled file orphan during catch-up even when it is the newest file (no live session)', async () => {
    // Claude is not running: every file is old, including the most recently
    // modified one. Liveness is judged by mtime age, not file rank, so the
    // newest file is still treated as a closed session and its orphan surfaces
    // during catch-up — not left stranded waiting for a result that never comes.
    const file = join(testDir, 's1.jsonl');
    await writeFile(file, `${bashLine('echo stale', { id: 'tool-stale' })}\n`);
    const { utimes } = await import('node:fs/promises');
    await utimes(
      file,
      new Date('2025-06-07T11:00:00Z'),
      new Date('2025-06-07T11:00:00Z')
    );

    const gen = createFollowStream([testDir], {
      pollMs: 20,
      idleFlushMs: 0, // idle flush disabled — catch-up is the only path
      signal: controller.signal,
    });
    const { commands, done } = background(gen);

    await waitFor(() => commands.length >= 1, 1000);
    controller.abort();
    await done;

    expect(commands.map((c) => c.command)).toEqual(['echo stale']);
  });

  it('does not flush a concurrent live session orphan during catch-up', async () => {
    // Two sessions run concurrently -> two recently-written files. The older
    // (but still live) one holds an in-flight command. A "newest file is the
    // only live one" rule would flush it prematurely as a success; mtime-age
    // liveness defers it so the real tool_result decides its status.
    const liveA = join(testDir, 'a.jsonl'); // in-flight command
    const liveB = join(testDir, 'b.jsonl'); // more recently active
    await writeFile(liveA, `${bashLine('echo running', { id: 'tool-run' })}\n`);
    await writeFile(liveB, `${bashLine('echo other')}\n`); // no id -> immediate

    const gen = createFollowStream([testDir], {
      pollMs: 20,
      idleFlushMs: 10_000, // long window: live loop won't idle-flush in-test
      signal: controller.signal,
    });
    const { commands, done } = background(gen);

    // The complete command appears; the in-flight one must stay held.
    await waitFor(() => commands.length >= 1);
    await sleep(100);
    expect(commands.map((c) => c.command)).toEqual(['echo other']);

    // The real result arrives (an error) and matches the held command.
    await appendFile(liveA, `${resultLine('tool-run', true)}\n`);
    await waitFor(() => commands.length >= 2);
    controller.abort();
    await done;

    const running = commands.find((c) => c.command === 'echo running');
    expect(running).toBeDefined();
    expect(running?.success).toBe(false); // matched the real result, not flushed
  });

  it('does not emit a command twice when its result arrives after the idle flush', async () => {
    // A command that runs longer than idleFlushMs: its tool_use is followed by a
    // quiet gap, so the idle flush surfaces it with an unknown outcome. When the
    // real tool_result finally lands (here: an error), it must NOT produce a
    // second copy, nor retroactively rewrite the already-emitted status — the
    // pending entry was cleared by the flush, so the late result is a no-op.
    const file = join(testDir, 's1.jsonl');
    await writeFile(file, `${bashLine('echo slow', { id: 'tool-slow' })}\n`);

    const gen = createFollowStream([testDir], {
      pollMs: 20,
      idleFlushMs: 60, // shorter than the command's run time
      signal: controller.signal,
    });
    const { commands, done } = background(gen);

    // Idle flush fires after the quiet window and surfaces the orphan once.
    await waitFor(() => commands.length >= 1);
    expect(commands.map((c) => c.command)).toEqual(['echo slow']);
    expect(commands[0].success).toBeUndefined(); // unknown, not assumed success

    // The command finishes much later and its real result (an error) arrives.
    await appendFile(file, `${resultLine('tool-slow', true)}\n`);
    // Give the live loop several poll cycles to drain the appended result.
    await sleep(150);

    controller.abort();
    await done;

    // Still exactly one occurrence, still the flushed status — no duplicate and
    // no retroactive correction from the late result.
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toBe('echo slow');
    expect(commands[0].success).toBeUndefined();
  });

  it('stops promptly when the signal is aborted', async () => {
    await writeFile(join(testDir, 's1.jsonl'), `${bashLine('echo only')}\n`);
    const gen = createFollowStream([testDir], {
      pollMs: 20,
      idleFlushMs: 0,
      signal: controller.signal,
    });
    const { commands, done } = background(gen);

    await waitFor(() => commands.length >= 1);
    controller.abort();
    await done; // resolves -> generator returned cleanly

    expect(commands.map((c) => c.command)).toEqual(['echo only']);
  });
});

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

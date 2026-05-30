import type { ClaudeCommand } from './types.js';

export interface ProjectInfo {
  name: string;
  actualPath: string;
  claudePath: string;
  encodedName: string;
  lastModified: Date;
}

export class OutputFormatter {
  private sigpipeDetected = false;

  /**
   * Format a single command line for shell history-like output
   */
  formatCommandLine(
    command: ClaudeCommand,
    index: number,
    isGlobal: boolean
  ): string {
    return this.buildLine(
      index.toString().padStart(4),
      command,
      isGlobal,
      command.command
    );
  }

  /**
   * Format a command into one or more output lines.
   *
   * When `multiline` is enabled, multi-command shells (joined by the parser with
   * a literal `\n` marker) are split into one line per command, each sharing the
   * parent history index with a `.N` sub-index (e.g. 1610.1, 1610.2). Single
   * commands still get a `.1` suffix so the numbering is uniform. When disabled,
   * a single line is returned with the commands kept on one line (default).
   */
  formatCommandLines(
    command: ClaudeCommand,
    index: number,
    isGlobal: boolean,
    multiline: boolean
  ): string[] {
    if (!multiline) {
      return [this.formatCommandLine(command, index, isGlobal)];
    }

    const baseLabel = index.toString().padStart(4);
    // The parser joins multi-line commands with a literal `\n` marker.
    const parts = command.command.split('\\n');
    return parts.map((part, i) =>
      this.buildLine(`${baseLabel}.${i + 1}`, command, isGlobal, part)
    );
  }

  /**
   * Build a single output line from a pre-rendered index label and command text,
   * adding the `[project]` prefix when rendering global (cross-project) output.
   */
  private buildLine(
    label: string,
    command: ClaudeCommand,
    isGlobal: boolean,
    text: string
  ): string {
    if (isGlobal && command.projectPath) {
      // Extract project name from path for global view
      const projectName = this.extractProjectName(command.projectPath);
      const projectPrefix = `[${projectName.padEnd(15)}] `;
      return `${label}  ${projectPrefix}${text}`;
    }

    return `${label}  ${text}`;
  }

  /**
   * Format project list (non-streaming output)
   */
  formatProjectList(projects: ProjectInfo[]): string {
    if (projects.length === 0) {
      return 'No Claude projects found in ~/.claude/projects/';
    }

    const lines = projects.map((project) => {
      const projectName = project.name; // Already basename from actualPath
      const nameColumn = projectName.padEnd(20);
      const pathColumn = `(${project.actualPath})`;
      return `${nameColumn} ${pathColumn}`;
    });

    return lines.join('\n');
  }

  /**
   * Write line to stdout with SIGPIPE detection
   * Returns false if pipe was closed (should stop processing)
   */
  writeLineWithSigpipeCheck(line: string): boolean {
    if (this.sigpipeDetected) {
      return false;
    }

    try {
      process.stdout.write(`${line}\n`);
      return true;
    } catch (error) {
      // Handle EPIPE (broken pipe) - downstream process closed
      if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
        this.sigpipeDetected = true;
        return false;
      }

      // Handle other stdout errors
      console.error(`Error writing to stdout: ${(error as Error).message}`, {
        file: 'stderr',
      });
      return false;
    }
  }

  /**
   * Check if SIGPIPE has been detected
   */
  isSigpipeDetected(): boolean {
    return this.sigpipeDetected;
  }

  /**
   * Reset SIGPIPE detection state (useful for testing)
   */
  resetSigpipeState(): void {
    this.sigpipeDetected = false;
  }

  /**
   * Extract a short project name from full path
   * /Users/test/dev/codetracker -> codetracker
   * /Users/test/dev/cchistory -> cchistory
   */
  private extractProjectName(projectPath: string): string {
    // Should only receive decoded paths like "/Users/test/dev/codetracker"
    return projectPath.split('/').pop() || projectPath;
  }
}

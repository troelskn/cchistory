# cchistory

[![npm version](https://badge.fury.io/js/cchistory.svg)](https://badge.fury.io/js/cchistory)

Like the shell `history` command but for your Claude Code sessions.

<div>
  <img src="https://github.com/eckardt/cchistory/blob/main/docs/demo.gif?raw=true">
</div>

## Why cchistory?

When Claude Code runs shell commands, they don't appear in your shell history. This makes it hard to:
- Re-run useful commands from past sessions
- Build on previous work
- Learn from command patterns Claude uses
- Copy command sequences for documentation

```bash
$ cchistory | tail -5
  46  git status
  47  git pull origin main
  48  git log --oneline -5
  49  docker-compose up -d
  50  curl -I localhost:8080/health
```

## 📦 Installation

### npm (recommended)
```bash
npm install -g cchistory
```

### npx (try without installing)
```bash
npx cchistory --help
```

### From source
```bash
git clone https://github.com/eckardt/cchistory
cd cchistory
npm install
npm run build
npm link
```

## Usage

```bash
cchistory                    # Current project history
cchistory --global           # All projects
cchistory --list-projects    # See all available projects
cchistory --multiline        # Split multi-command shells onto separate lines
cchistory | grep docker      # Find Docker commands  
cchistory | tail -5          # Last 5 commands
cchistory my-app | tail -10  # Last 10 from specific project
cchistory ~/code/my-app      # Project by full path
```

## ✨ Features

- 🔍 Extract all Bash commands Claude executed across projects
- 🗂️ Filter by specific project or search globally  
- 📊 Standard Unix tool compatibility (`grep`, `awk`, `sort`)
- ⚡ Fast streaming parser for large conversation logs
- 🚀 Zero-config - works with existing Claude Code setup

## How It Works

Claude Code stores conversation history in `~/.claude/projects/`. This tool:

1. Finds your Claude projects
2. Streams through conversation logs  
3. Extracts shell commands Claude executed
4. Formats them like traditional shell history

## 📋 Example Output

```bash
$ cchistory --global | head -10
   1  [web-scraper    ] npm install puppeteer
   2  [web-scraper    ] mkdir src tests
   3  [api-project    ] docker-compose up -d
   4  [api-project    ] curl -X POST localhost:3000/api/test
   5  [frontend       ] npm run dev
   6  [frontend       ] git add .
   7  [backend        ] npm test
   8  [backend        ] git commit -m "fix: validation"
   9  [deployment     ] kubectl apply -f deployment.yaml
  10  [deployment     ] kubectl get pods
```

## Advanced Usage

```bash
# Find all npm commands across projects
cchistory --global | grep npm

# Get last 20 Docker commands
cchistory --global | grep docker | tail -20

# Count commands by type
cchistory --global | sed 's/.*] //' | awk '{print $1}' | sort | uniq -c | sort -nr | head -10
```

## Command Sources

Extracts commands from:
- **Bash tool usage**: Commands Claude executes via the Bash tool
- **User "!" commands**: Commands you run with `! command` in Claude

## Requirements

- Node.js 20+ 
- Claude Code with conversation history in `~/.claude/projects/`

**Note**: Claude Code automatically cleans up conversation transcripts based on the `cleanupPeriodDays` setting (default: 30 days). Commands older than this period won't appear in cchistory output. You can adjust this retention period in [Claude Code's settings](https://docs.anthropic.com/en/docs/claude-code/settings) if needed.

## Options

```
cchistory [project-name]    # Show history for specific project (by name or path)
cchistory --global          # Show history from all projects  
cchistory --list-projects   # List all available Claude projects
cchistory -m, --multiline   # Split multi-command shells onto separate lines
cchistory --include-failed  # Include failed command executions
cchistory --help            # Show usage info
```

## Output Format

Each line shows:
```
[sequence] [project-name] command
```

- **sequence**: Command number (oldest first)
- **project-name**: Which Claude project ran the command
- **command**: The actual shell command

When Claude runs several commands in one shell, they are shown on a single line in zsh history format with `\n` separating them.

Use `-m` / `--multiline` to break them onto separate lines instead. Each line keeps the parent's history index with a `.N` sub-index so it's clear they ran in the same shell:

```
1610.1  cd /Users/you/projects/foobar
1610.2  git add README.md
1610.3  git commit -m "yolo"
```

> Note: splitting happens on the `\n` separator, so a command whose own text literally contains `\n` (e.g. `printf 'a\nb'`) will also be broken at that point.

## Unix Philosophy

`cchistory` does one thing well: extract shell commands. Use it with standard Unix tools:

- `grep` for filtering
- `head`/`tail` for limiting output  
- `awk` for field processing
- `sort`/`uniq` for analysis
- Pipe to files for documentation

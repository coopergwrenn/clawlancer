# Code Execution Quick Reference

## Python Patterns

### Virtual Environment Setup

```bash
cd ~/project
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install requests pandas matplotlib pillow openpyxl
pip freeze > requirements.txt
```

### Install from requirements.txt

```bash
source .venv/bin/activate
pip install -r requirements.txt
```

### Common Libraries by Task

| Task | Library | Install |
|---|---|---|
| HTTP requests | requests | `pip install requests` |
| Data analysis | pandas | `pip install pandas` |
| Charts | matplotlib | `pip install matplotlib` |
| Image processing | Pillow | `pip install pillow` |
| Excel files | openpyxl | `pip install openpyxl` |
| Web scraping | beautifulsoup4 | `pip install beautifulsoup4 lxml` |
| API server | fastapi + uvicorn | `pip install fastapi uvicorn` |
| PostgreSQL | psycopg2-binary | `pip install psycopg2-binary` |
| PDF generation | reportlab | `pip install reportlab` |
| PDF reading | pdfplumber | `pip install pdfplumber` |
| YAML parsing | pyyaml | `pip install pyyaml` |

## Node.js Patterns

### Project Initialization

```bash
mkdir ~/project/my-app && cd ~/project/my-app
npm init -y
npm install express axios dotenv
```

### Package Management

```bash
npm install <package>            # Add dependency
npm install -D <package>         # Add dev dependency
npm ls                           # List installed
npm outdated                     # Check for updates
npm audit                        # Security check
```

### TypeScript Setup

```bash
npm install -D typescript @types/node ts-node
npx tsc --init
```

**tsconfig.json essentials:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true
  },
  "include": ["src/**/*"]
}
```

**Run TypeScript directly:**
```bash
npx ts-node src/index.ts
```

## Shell Scripting Patterns

### Argument Parsing

```bash
#!/bin/bash
set -euo pipefail

VERBOSE=false
OUTPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verbose|-v) VERBOSE=true; shift ;;
    --output|-o) OUTPUT="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [--verbose] [--output FILE]"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if $VERBOSE; then echo "Verbose mode enabled"; fi
if [ -n "$OUTPUT" ]; then echo "Output file: $OUTPUT"; fi
```

### Error Handling

```bash
#!/bin/bash
set -euo pipefail

LOG_FILE="$HOME/logs/$(basename "$0" .sh).log"
mkdir -p "$(dirname "$LOG_FILE")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }
die() { log "ERROR: $*"; exit 1; }

trap 'die "Script failed at line $LINENO"' ERR

log "Starting..."
# ... your logic ...
log "Done."
```

### Logging Pattern

```bash
LOG_DIR="$HOME/logs"
mkdir -p "$LOG_DIR"

exec > >(tee -a "$LOG_DIR/script.log") 2>&1

echo "[$(date)] Script started"
echo "[$(date)] Processing..."
echo "[$(date)] Script finished"
```

## Process Management

### Background Jobs with PID Tracking

```bash
PID_DIR="$HOME/pids"
mkdir -p "$PID_DIR"

# Start
nohup python3 ~/scripts/worker.py > ~/logs/worker.log 2>&1 &
echo $! > "$PID_DIR/worker.pid"

# Check
if kill -0 $(cat "$PID_DIR/worker.pid") 2>/dev/null; then
  echo "Running"
else
  echo "Stopped"
fi

# Stop
kill $(cat "$PID_DIR/worker.pid") && rm "$PID_DIR/worker.pid"
```

### Graceful Shutdown (Python)

```python
import signal
import sys

running = True

def handle_signal(signum, frame):
    global running
    print(f"Received signal {signum}, shutting down gracefully...")
    running = False

signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)

while running:
    # ... do work ...
    pass

print("Clean shutdown complete.")
sys.exit(0)
```

### Graceful Shutdown (Node.js)

```javascript
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => process.exit(0));
});
```

## File I/O Patterns

### Atomic Write (Python)

```python
import tempfile, os, json

def atomic_write(path, data):
    """Write data to file atomically (no partial writes)."""
    dir_name = os.path.dirname(path) or '.'
    with tempfile.NamedTemporaryFile(mode='w', dir=dir_name, suffix='.tmp', delete=False) as tmp:
        json.dump(data, tmp, indent=2)
        tmp_path = tmp.name
    os.rename(tmp_path, path)
```

### Temp Files

```python
import tempfile

# Temp file (auto-deleted when closed)
with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=True) as tmp:
    tmp.write("a,b,c\n1,2,3\n")
    tmp.flush()
    # Use tmp.name while open

# Temp directory
with tempfile.TemporaryDirectory() as tmpdir:
    # Use tmpdir path, auto-cleaned on exit
    pass
```

### Large File Streaming (Python)

```python
import csv

# Process CSV without loading into memory
with open("huge.csv", "r") as f:
    reader = csv.DictReader(f)
    for i, row in enumerate(reader):
        # Process one row at a time
        if i % 100000 == 0:
            print(f"Processed {i} rows...")
```

### Large File Streaming (pandas)

```python
import pandas as pd

chunks = pd.read_csv("huge.csv", chunksize=10000)
results = []
for chunk in chunks:
    # Process each chunk
    results.append(chunk.groupby("category")["value"].sum())

final = pd.concat(results).groupby(level=0).sum()
```

## Networking Patterns

### Python requests

```python
import requests

# GET
resp = requests.get("https://api.example.com/data", timeout=10)
resp.raise_for_status()
data = resp.json()

# POST
resp = requests.post("https://api.example.com/data",
    json={"key": "value"},
    headers={"Authorization": "Bearer TOKEN"},
    timeout=10
)

# Download file
with requests.get(url, stream=True) as r:
    r.raise_for_status()
    with open("file.zip", "wb") as f:
        for chunk in r.iter_content(chunk_size=8192):
            f.write(chunk)
```

### curl (Shell)

```bash
# GET with JSON parsing
curl -s "https://api.example.com/data" | jq '.items[]'

# POST JSON
curl -s -X POST "https://api.example.com/data" \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}'

# Download file
curl -sL -o output.zip "https://example.com/file.zip"

# With auth
curl -s -H "Authorization: Bearer $TOKEN" "https://api.example.com/me"
```

### Port Management

```bash
# Check what's using a port
lsof -i :3000

# Kill process on a port
lsof -ti :3000 | xargs kill -9

# Find an available port
python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()"
```

## Troubleshooting Quick Reference

| Problem | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError` | Not in venv or not installed | `source .venv/bin/activate && pip install X` |
| `EADDRINUSE` | Port already in use | `lsof -ti :PORT \| xargs kill` then restart |
| `MemoryError` | File too large for RAM | Use chunked reading or streaming |
| `Permission denied` | No sudo available | Use `--user` flag or user-level paths |
| `matplotlib display error` | No display on headless VM | Add `matplotlib.use('Agg')` before import |
| `ECONNREFUSED` | Server not started or wrong port | Check process is running, check port binding |
| Script exits silently | `set -e` caught an error | Add `trap` for error logging, check log file |

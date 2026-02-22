# Code Execution & Backend Development
```yaml
name: code-execution
version: 1.0.0
updated: 2026-02-22
author: InstaClaw
triggers:
  keywords: [code, run, execute, script, python, node, api, server, database, deploy]
  phrases: ["run this code", "create a script", "build an API", "set up a server", "query the database", "write a program"]
  NOT: [video, voice, email]
```

## Overview

You have a full development environment on a dedicated Linux VM. You can write, run, and debug code in Python, Node.js, Bash, and SQLite. You can scaffold APIs, run background services, process data, manage files, and automate anything that runs on a Linux box.

**This skill is documentation + patterns only.** All runtimes are pre-installed on the VM snapshot. No separate scripts or API keys required -- you write code directly using the tools available to you (shell, file write, etc.).

## Dependencies

- Python 3.11+, Node.js 22, Bash 5, SQLite 3 (all pre-installed on VM snapshot)
- No external API keys required for core functionality
- Optional: PostgreSQL client (`psycopg2`) if a database connection is provided by the user

## Languages & Runtimes

| Language | Version | Package Manager | Common Libraries |
|---|---|---|---|
| Python | 3.11+ | pip / venv | requests, pandas, matplotlib, pillow, psycopg2, flask, fastapi, beautifulsoup4 |
| Node.js | 22 LTS | npm | express, axios, cheerio, sharp, better-sqlite3, ws, node-fetch |
| Bash | 5.x | apt (system) | coreutils, jq, curl, wget, sed, awk, grep |
| SQLite | 3.x | built-in | N/A (accessed via Python/Node or CLI) |

## API Server Patterns

### Express.js (Node.js)

```javascript
// server.js — Minimal Express API
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Example endpoint
app.get('/api/data', (req, res) => {
  res.json({ items: [{ id: 1, name: 'example' }] });
});

// POST endpoint with validation
app.post('/api/data', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  res.status(201).json({ id: Date.now(), name });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
```

**Start it:**
```bash
cd ~/project && npm init -y && npm install express
node server.js &
# Test:
curl http://localhost:3000/health
```

### FastAPI (Python)

```python
# server.py — Minimal FastAPI
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

app = FastAPI()

class Item(BaseModel):
    name: str
    value: float = 0.0

items_db = []

@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/api/items")
def list_items():
    return {"items": items_db}

@app.post("/api/items", status_code=201)
def create_item(item: Item):
    record = {"id": len(items_db) + 1, **item.dict()}
    items_db.append(record)
    return record

@app.get("/api/items/{item_id}")
def get_item(item_id: int):
    for item in items_db:
        if item["id"] == item_id:
            return item
    raise HTTPException(status_code=404, detail="Item not found")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
```

**Start it:**
```bash
cd ~/project
python3 -m venv .venv && source .venv/bin/activate
pip install fastapi uvicorn
python3 server.py &
# Test:
curl http://localhost:8000/health
```

## MCP Server Patterns

You can create custom MCP (Model Context Protocol) servers that other agents or tools can connect to.

### Minimal MCP Server (Node.js)

```javascript
// mcp-server.js — Custom tool server
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const server = new Server({
  name: 'custom-tools',
  version: '1.0.0'
}, {
  capabilities: { tools: {} }
});

// Register a tool
server.setRequestHandler('tools/list', async () => ({
  tools: [{
    name: 'lookup_data',
    description: 'Look up data by key',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Lookup key' } },
      required: ['key']
    }
  }]
}));

// Handle tool calls
server.setRequestHandler('tools/call', async (request) => {
  if (request.params.name === 'lookup_data') {
    const key = request.params.arguments.key;
    return { content: [{ type: 'text', text: `Result for ${key}: ...` }] };
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

const transport = new StdioServerTransport();
server.connect(transport);
```

**Register in OpenClaw config:**
```json
{
  "mcpServers": {
    "custom-tools": {
      "command": "node",
      "args": ["/home/agent/project/mcp-server.js"]
    }
  }
}
```

## Database Operations

### SQLite (Built-In)

```python
import sqlite3
import json

DB_PATH = "/home/agent/data/app.db"

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            data JSON,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    return conn

def insert_record(conn, name, data):
    cur = conn.execute(
        "INSERT INTO records (name, data) VALUES (?, ?)",
        (name, json.dumps(data))
    )
    conn.commit()
    return cur.lastrowid

def query_records(conn, name_filter=None):
    if name_filter:
        rows = conn.execute(
            "SELECT * FROM records WHERE name LIKE ?",
            (f"%{name_filter}%",)
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM records").fetchall()
    return [dict(row) for row in rows]

# Usage
conn = init_db()
rid = insert_record(conn, "test", {"key": "value"})
results = query_records(conn, "test")
print(results)
conn.close()
```

### PostgreSQL (When Connection Provided)

```python
import psycopg2
from psycopg2.extras import RealDictCursor

def get_pg_conn(dsn):
    """Connect to a user-provided PostgreSQL database."""
    conn = psycopg2.connect(dsn)
    return conn

def create_table(conn):
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS events (
                id SERIAL PRIMARY KEY,
                event_type TEXT NOT NULL,
                payload JSONB,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)
    conn.commit()

def insert_event(conn, event_type, payload):
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO events (event_type, payload) VALUES (%s, %s) RETURNING id",
            (event_type, psycopg2.extras.Json(payload))
        )
        conn.commit()
        return cur.fetchone()[0]

def query_events(conn, event_type=None, limit=100):
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        if event_type:
            cur.execute(
                "SELECT * FROM events WHERE event_type = %s ORDER BY created_at DESC LIMIT %s",
                (event_type, limit)
            )
        else:
            cur.execute("SELECT * FROM events ORDER BY created_at DESC LIMIT %s", (limit,))
        return cur.fetchall()

# Usage
conn = get_pg_conn("postgresql://user:pass@host:5432/dbname")
create_table(conn)
eid = insert_event(conn, "signup", {"user": "alice"})
events = query_events(conn, "signup")
conn.close()
```

## Data Analysis

### Pandas + Matplotlib

```python
import pandas as pd
import matplotlib
matplotlib.use('Agg')  # Non-interactive backend (REQUIRED on headless VM)
import matplotlib.pyplot as plt

# Load data
df = pd.read_csv("/home/agent/data/sales.csv")

# Transform
df['date'] = pd.to_datetime(df['date'])
df['month'] = df['date'].dt.to_period('M')
monthly = df.groupby('month')['revenue'].sum().reset_index()
monthly['revenue_k'] = monthly['revenue'] / 1000

# Summary stats
print(f"Total revenue: ${df['revenue'].sum():,.2f}")
print(f"Average order: ${df['revenue'].mean():,.2f}")
print(f"Top month: {monthly.loc[monthly['revenue'].idxmax(), 'month']}")

# Generate chart
fig, ax = plt.subplots(figsize=(10, 6))
ax.bar(monthly['month'].astype(str), monthly['revenue_k'])
ax.set_xlabel('Month')
ax.set_ylabel('Revenue ($K)')
ax.set_title('Monthly Revenue')
ax.tick_params(axis='x', rotation=45)
plt.tight_layout()
plt.savefig('/home/agent/output/revenue-chart.png', dpi=150)
plt.close()
print("Chart saved to /home/agent/output/revenue-chart.png")
```

### Quick Data Summary (One-Liner)

```python
import pandas as pd
df = pd.read_csv("data.csv")
print(df.describe())
print(f"\nShape: {df.shape}")
print(f"Columns: {list(df.columns)}")
print(f"Nulls:\n{df.isnull().sum()}")
```

## File Processing

### JSON Read/Write

```python
import json

# Read
with open("config.json", "r") as f:
    data = json.load(f)

# Modify
data["version"] = "2.0"

# Write (atomic — write to temp, rename)
import tempfile, os
tmp = tempfile.NamedTemporaryFile(mode='w', dir='.', suffix='.json', delete=False)
json.dump(data, tmp, indent=2)
tmp.close()
os.rename(tmp.name, "config.json")
```

### CSV Read/Write

```python
import csv

# Read
with open("input.csv", "r") as f:
    reader = csv.DictReader(f)
    rows = list(reader)

# Write
with open("output.csv", "w", newline='') as f:
    writer = csv.DictWriter(f, fieldnames=["id", "name", "value"])
    writer.writeheader()
    writer.writerows(rows)
```

### Excel (openpyxl)

```python
# pip install openpyxl
import openpyxl

# Read
wb = openpyxl.load_workbook("report.xlsx")
ws = wb.active
for row in ws.iter_rows(min_row=2, values_only=True):
    print(row)

# Write
wb_new = openpyxl.Workbook()
ws_new = wb_new.active
ws_new.append(["ID", "Name", "Score"])
ws_new.append([1, "Alice", 95])
ws_new.append([2, "Bob", 87])
wb_new.save("output.xlsx")
```

### XML Parsing

```python
import xml.etree.ElementTree as ET

tree = ET.parse("data.xml")
root = tree.getroot()

for item in root.findall(".//item"):
    name = item.find("name").text
    value = item.find("value").text
    print(f"{name}: {value}")
```

### Image Manipulation (Pillow)

```python
from PIL import Image, ImageDraw, ImageFont

# Resize
img = Image.open("photo.jpg")
img = img.resize((800, 600), Image.LANCZOS)
img.save("photo-resized.jpg", quality=90)

# Create thumbnail
img.thumbnail((200, 200))
img.save("thumb.jpg")

# Add text overlay
draw = ImageDraw.Draw(img)
draw.text((10, 10), "Watermark", fill=(255, 255, 255, 128))
img.save("watermarked.jpg")

# Convert format
img = Image.open("photo.png")
img.convert("RGB").save("photo.jpg")
```

## Git Operations

```bash
# Clone a repo
git clone https://github.com/user/repo.git ~/project
cd ~/project

# Branch management
git checkout -b feature/new-thing
git add -A
git commit -m "Add new feature"

# Push (requires token or SSH key configured)
git remote set-url origin https://TOKEN@github.com/user/repo.git
git push origin feature/new-thing

# Pull and merge
git checkout main
git pull origin main
git merge feature/new-thing

# Check status
git status
git log --oneline -10
git diff HEAD~1
```

**Authentication:** The VM has `git` pre-installed. For pushing to private repos, the user must provide a personal access token or SSH key. Store tokens in `~/.openclaw/.env`, never in code.

## Background Processes

### nohup (Quick Background Job)

```bash
# Start a process that survives terminal disconnect
nohup python3 ~/scripts/long-task.py > ~/logs/task.log 2>&1 &
echo $! > ~/pids/task.pid

# Check status
cat ~/pids/task.pid | xargs ps -p

# Stop it
kill $(cat ~/pids/task.pid)
```

### screen (Interactive Background Sessions)

```bash
# Start named session
screen -dmS myserver bash -c 'cd ~/project && node server.js'

# List sessions
screen -ls

# Reattach
screen -r myserver

# Kill session
screen -S myserver -X quit
```

### systemd User Services (Persistent Services)

```bash
# Create service file
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/my-api.service << 'EOF'
[Unit]
Description=My API Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/agent/project
ExecStart=/usr/bin/node /home/agent/project/server.js
Restart=on-failure
RestartSec=5
Environment=PORT=3000
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

# Enable and start
systemctl --user daemon-reload
systemctl --user enable my-api
systemctl --user start my-api

# Check status
systemctl --user status my-api
journalctl --user -u my-api -f

# Stop
systemctl --user stop my-api
```

## Pre-Built Workflows

### Workflow 1: Quick Script (Write, Run, Return Output)

When user says: "run this code" or "write a script that..."

```
STEP 1: Write the script
├── Determine language (Python default, Bash for shell tasks, Node for JS)
├── Write to ~/workspace/scripts/<descriptive-name>.<ext>
└── Make executable (chmod +x for bash)

STEP 2: Run
├── Execute with appropriate interpreter
├── Capture stdout + stderr
└── Timeout after 60 seconds (configurable)

STEP 3: Return
├── Show output (truncated if > 500 lines)
├── Show errors with explanation
└── Save output to ~/workspace/output/ if requested
```

### Workflow 2: API Server (Scaffold, Start, Test, Return URL)

When user says: "build an API" or "set up a server"

```
STEP 1: Scaffold
├── Create project directory ~/project/<name>/
├── Generate package.json or requirements.txt
├── Write server code with health endpoint
├── Install dependencies

STEP 2: Start
├── Run server in background (nohup or screen)
├── Wait for health endpoint to respond (up to 15 seconds)
└── Save PID for management

STEP 3: Test
├── curl health endpoint
├── curl each defined route
└── Verify correct responses

STEP 4: Return
├── Server URL: http://<vm-ip>:<port>
├── Available endpoints
├── How to stop: kill PID or screen -S name -X quit
└── Logs location
```

### Workflow 3: Data Pipeline (Ingest, Transform, Visualize)

When user says: "analyze this data" or "process this CSV"

```
STEP 1: Ingest
├── Detect format (CSV, JSON, Excel, API response)
├── Load into pandas DataFrame
├── Print shape, columns, dtypes, nulls

STEP 2: Transform
├── Clean (handle nulls, fix dtypes, deduplicate)
├── Compute aggregations user requested
├── Create derived columns if needed
└── Print summary statistics

STEP 3: Visualize
├── Generate chart (matplotlib, saved as PNG)
├── Save processed data to CSV/JSON
└── Return file paths + summary

STEP 4: Deliver
├── Send chart image via messaging if requested
├── Provide download paths
└── Offer next steps (deeper analysis, export, etc.)
```

### Workflow 4: Cron Job Setup (Create Script, Register Cron, Verify)

When user says: "run this every hour" or "schedule a task"

```
STEP 1: Create the script
├── Write script to ~/scripts/<name>.sh
├── Add logging (redirect output to ~/logs/<name>.log)
├── Add error handling (set -euo pipefail)
└── Test run manually first

STEP 2: Register cron
├── crontab -e (or echo into crontab -l)
├── Use correct schedule expression
├── Include PATH and env vars in crontab
└── Example: */30 * * * * /home/agent/scripts/check-health.sh >> /home/agent/logs/health.log 2>&1

STEP 3: Verify
├── crontab -l (confirm entry exists)
├── Wait for first execution (or trigger manually)
├── Check log file for output
└── Report schedule to user
```

## Cannot-Do Section

| Limitation | Why | Workaround |
|---|---|---|
| No `sudo` / root access | VMs are unprivileged user-only | Use `pip install --user`, `npm install` (local), user-level systemd |
| No Docker | Docker daemon requires root | Run processes directly on the VM |
| No GPU | Hetzner CX VMs are CPU-only | Use CPU-based libraries; offload GPU tasks to external APIs |
| Limited RAM (~2GB) | Small VM instances | Stream large files, use SQLite instead of in-memory DBs, batch processing |
| No incoming traffic by default | Firewall rules | Use the VM's public IP + specific ports (3000-9000 range open) |
| No persistent storage beyond VM | VM can be reprovisioned | Back up important data to user's repo or external storage |

## Messaging & Media

| Method | Available | Notes |
|---|---|---|
| Telegram | Yes (if configured) | Send text, files, images via bot API |
| Discord | Yes (if configured) | Send text, files, embeds via webhook or bot |
| Email | Yes (via email-outreach skill) | Send files as attachments |
| Direct file download | Yes | Serve files via API server on VM |
| Webhook | Yes | POST results to any URL |

| Media Type | Can Generate | Can Process |
|---|---|---|
| Text files (JSON, CSV, TXT, MD) | Yes | Yes |
| Images (PNG, JPG, SVG) | Yes (matplotlib, Pillow) | Yes (Pillow) |
| Excel (XLSX) | Yes (openpyxl) | Yes (openpyxl, pandas) |
| PDF | Yes (reportlab, weasyprint) | Yes (PyPDF2, pdfplumber) |
| Audio/Video | Yes (ffmpeg pre-installed on VM snapshot) | Yes (ffmpeg) |

## Rate Limits & Budget

```
CPU:              Shared vCPU (2 cores typical)
RAM:              ~2 GB
Disk:             ~40 GB
Max processes:    50 concurrent (ulimit)
Network:          20 TB/mo (Hetzner default)
Open ports:       22 (SSH), 3000-9000 (user services)
Max file size:    Recommend < 500 MB per file
Script timeout:   Default 60s for quick scripts, unlimited for servers
```

**Resource monitoring:**
```bash
# Check memory
free -h

# Check disk
df -h

# Check running processes
ps aux --sort=-%mem | head -20

# Check CPU
top -bn1 | head -5
```

## Common Mistakes

1. **Forgetting `matplotlib.use('Agg')`** -- The VM is headless. Without the Agg backend, matplotlib crashes trying to open a display. Always set it before importing pyplot.
2. **Running `pip install` globally** -- Always use a virtual environment (`python3 -m venv .venv && source .venv/bin/activate`) or `pip install --user`. Global installs can conflict with system packages.
3. **Starting a server on 127.0.0.1** -- If the user needs external access, bind to `0.0.0.0`, not localhost. Servers bound to 127.0.0.1 are only reachable from the VM itself.
4. **Not saving PIDs for background processes** -- If you start something with `&` or `nohup`, save the PID. Otherwise you cannot reliably stop or monitor it later.
5. **Loading entire large files into memory** -- With ~2 GB RAM, a 1 GB CSV will crash the process. Use chunked reading (`pd.read_csv(chunksize=10000)`) or streaming.

## Future Improvements (Roadmap)

1. **Credential vault** — Encrypted storage for API keys and secrets (not plaintext files)
2. **Cloud deployment integration** — Ability to deploy to Vercel/Railway/Fly.io with user credentials
3. **Persistent background workers** — Daemonized processes that survive session restart
4. **Package caching** — Pre-install common packages on VM snapshot (pandas, plotly, etc.)
5. **Code quality automation** — Auto-lint, auto-format before delivering code to user
6. **Testing framework** — Auto-generate basic tests for code the agent writes

## Quality Checklist

- [ ] Code runs without errors on first execution (test before delivering)
- [ ] All dependencies are installed (pip/npm install included in instructions)
- [ ] Virtual environment used for Python projects (not global pip)
- [ ] Server binds to 0.0.0.0 if external access is needed
- [ ] Background processes have PID tracking and log files
- [ ] Error handling included (try/except, set -euo pipefail for bash)
- [ ] Output files saved to predictable paths (~/output/ or ~/workspace/)
- [ ] Resource usage is reasonable (no unbounded memory, no fork bombs)

## Files

- `~/.openclaw/skills/code-execution/SKILL.md` -- This file (the complete skill)
- `~/.openclaw/skills/code-execution/references/code-patterns.md` -- Quick reference for common patterns

# BLADERUNNER SQL Bridge — Production Setup

Expose **read-only** ERP lookups to **protoportal-admin** on Vercel.

**Hard rule:** SELECT only — STMAST product lookups and Positill sales aggregates (`/stmast`, `/top-sellers`). Never INSERT, UPDATE, DELETE, or DDL. Use `ProtoSyncReadOnly` + `ApplicationIntent=ReadOnly`.

| Machine | Role |
|---------|------|
| **BLADERUNNER-PC** (`192.168.10.10`) | SQL Server + `sql-stmast-bridge.py` on port **8765** |
| **George-PC** (LAN) | Direct SQL *or* LAN bridge test |
| **Vercel** | `STOCK_SQL_BRIDGE_URL` (HTTPS tunnel) + `STOCK_SQL_BRIDGE_KEY` |

Apollo Query Engine path (unchanged):

```
Vercel → STOCK_SQL_BRIDGE_URL → tunnel → :8765 → SQL Server (POSWINSQL)
```

---

## Prerequisites (BLADERUNNER-PC)

- Windows PC with SQL Server (`BLADERUNNER-PC` / `POSWINSQL`)
- Python 3.10+ with ODBC Driver 17 for SQL Server
- Read-only SQL login: `ProtoSyncReadOnly`
- `C:\Users\BladeRunner\Desktop\Script3\sql-stmast-bridge.py` — the only
  deployed bridge code file

```powershell
pip install pyodbc
```

---

## Step 1 — `.env` on BLADERUNNER-PC

In the repo root on BLADERUNNER, create or edit `.env`:

```env
SQL_SERVER=BLADERUNNER-PC
SQL_DATABASE=POSWINSQL
SQL_USER=ProtoSyncReadOnly
SQL_PASSWORD=<your-readonly-password>

# Bridge — required for production
STOCK_SQL_BRIDGE_KEY=<long-random-secret>
STOCK_SQL_BRIDGE_PORT=8765
```

Generate a secret (PowerShell):

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

**Never commit `.env`.** Use the same `STOCK_SQL_BRIDGE_KEY` on Vercel.

---

## Step 2 — Start the bridge

Manual (first test):

```powershell
cd C:\path\to\protoportal-admin
python scripts\sql-stmast-bridge.py
```

Expected: `SQL bridge listening on :8765 (/stmast, /top-sellers)`

Or double-click: `scripts\start-sql-bridge.bat`

### LAN test (from George-PC)

```powershell
$key = "<your-STOCK_SQL_BRIDGE_KEY>"
$headers = @{ "Content-Type"="application/json"; "x-api-key"=$key }
Invoke-RestMethod -Uri "http://192.168.10.10:8765/stmast" -Method POST -Headers $headers -Body '{"sku":"8626100145"}'
```

Or from the repo on any machine with env set:

```bash
# .env.local on George-PC:
# STOCK_SQL_BRIDGE_URL=http://192.168.10.10:8765
# STOCK_SQL_BRIDGE_KEY=<same secret>

node scripts/test-bridge.mjs 8626100145
node scripts/test-bridge-top-sellers.mjs today 10
```

**Note:** Both endpoints use **POST + JSON body**, not GET query strings.

### Version check

`/version` uses the same API key protection as the query endpoints and reports
the deployed bridge version, source commit, and deployment build timestamp:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8765/version" -Headers $headers
```

---

## One-command bridge deployment (recommended)

Run this from the admin repo on **George-PC**. It uses PowerShell remoting to
copy exactly one file to BLADERUNNER, stops only a process whose command line
contains `sql-stmast-bridge.py`, starts that copied file, then verifies
`/version`, `/stmast`, and `/top-sellers`.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy_bridge.ps1
```

If your current Windows account cannot remote to BLADERUNNER, supply a
credential:

```powershell
$credential = Get-Credential
powershell -ExecutionPolicy Bypass -File .\scripts\deploy_bridge.ps1 -Credential $credential
```

The deployment reports `PASS` only when all three requests succeed. It does
not reboot BLADERUNNER, restart SQL Server, or touch POS/till processes.

---

## Capability 1.3 — upgrade bridge for Positill sales

If Apollo product lookup works but *"What was the best seller today?"* returns `SQL bridge failed (520)`, the bridge on BLADERUNNER is running an **old script without `/top-sellers`**.

Run the one-command deployment from **George-PC**:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy_bridge.ps1
```

The deployment script:

1. Copies the one self-contained `sql-stmast-bridge.py`
2. Validates `.env` on BLADERUNNER (read-only `ProtoSyncReadOnly`)
3. Restarts only the bridge process on port 8765
4. Tests `/version`, `/stmast`, and `/top-sellers` locally

Then re-test production Apollo: *"What was the best seller today?"* — expect Positill ERP, invoice count, evidence.

---

## Step 3 — Run bridge at startup (Windows)

On BLADERUNNER-PC, run **as Administrator**:

```powershell
cd C:\path\to\protoportal-admin
powershell -ExecutionPolicy Bypass -File scripts\install-sql-bridge-task.ps1
```

This registers a Scheduled Task **ProtoSqlBridge** that runs `sql-stmast-bridge.py` at logon and on failure restart.

Manage:

```powershell
Get-ScheduledTask -TaskName ProtoSqlBridge
Start-ScheduledTask -TaskName ProtoSqlBridge
Stop-ScheduledTask -TaskName ProtoSqlBridge
```

---

## Step 4 — Cloudflare Tunnel (Vercel → BLADERUNNER)

Vercel cannot reach `192.168.10.10`. Expose the bridge via **HTTPS**.

### 4a. Install cloudflared on BLADERUNNER

Download: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

### 4b. Create tunnel in Cloudflare Zero Trust

1. [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Networks** → **Tunnels** → **Create a tunnel**
2. Name: `proto-sql-bridge`
3. Install connector on BLADERUNNER (copy the `cloudflared service install` command)
4. **Public Hostname**:
   - Subdomain: `sql-bridge` (or `erp-bridge`)
   - Domain: `proto.co.za` (your zone)
   - Service: `http://localhost:8765`

Public URL example: `https://sql-bridge.proto.co.za`

### 4c. Optional — local config file

Copy `scripts/cloudflared-sql-bridge.yml.example` and adjust `tunnel` + `credentials-file` after `cloudflared tunnel create`.

Run:

```powershell
cloudflared tunnel --config C:\path\to\cloudflared-sql-bridge.yml run
```

Install as Windows service (Cloudflare docs) so the tunnel survives reboot.

### Alternative — Tailscale Funnel

If BLADERUNNER already runs Tailscale:

```bash
tailscale funnel 8765
```

Use the issued `https://….ts.net` URL as `STOCK_SQL_BRIDGE_URL`.

---

## Step 5 — Vercel environment variables

Project: **protoportal-admin**

| Variable | Production value | Notes |
|----------|------------------|-------|
| `STOCK_SQL_BRIDGE_URL` | `https://sql-bridge.proto.co.za` | HTTPS, no trailing slash |
| `STOCK_SQL_BRIDGE_KEY` | same as BLADERUNNER `.env` | Required — do not leave empty |

### CLI

```bash
npx vercel env add STOCK_SQL_BRIDGE_URL production
npx vercel env add STOCK_SQL_BRIDGE_KEY production
```

Repeat for **Preview** if needed.

### Redeploy

Env vars apply only after redeploy:

```bash
npx vercel --prod
```

Or trigger redeploy from the Vercel dashboard.

**Do not set `SQL_PASSWORD` on Vercel** — use the bridge only.

---

## Step 6 — Verify production

### A. Product Loader (admin UI)

1. Open https://protoportal-admin.vercel.app (or admin.proto.co.za)
2. **Product Loader** section
3. Green: **● Live Positill SQL connected**

### B. Diag API (admin auth required)

```
GET /api/product-loader-diag?code=8626100145
```

Expect: `bridgeConfigured: true`, `sqlConnectionTest: true`, `bridgeReachable: true`

### C. Apollo verify (local with bridge URL)

```env
# .env.local — comment out SQL_PASSWORD when testing bridge path
STOCK_SQL_BRIDGE_URL=https://sql-bridge.proto.co.za
STOCK_SQL_BRIDGE_KEY=<secret>
```

```bash
VERIFY_ERP_REQUIRE_LIVE=1 node scripts/verify-erp-product.mjs 8626100145
```

Expect: `dataSource: erp_sql`, `Operational: VERIFIED ✓`

---

## Dev vs production

| Environment | Recommended config |
|-------------|-------------------|
| **George-PC (LAN)** | `SQL_PASSWORD` direct **or** `STOCK_SQL_BRIDGE_URL=http://192.168.10.10:8765` |
| **Vercel** | `STOCK_SQL_BRIDGE_URL` (HTTPS tunnel) + `STOCK_SQL_BRIDGE_KEY` only |

**Priority:** If `STOCK_SQL_BRIDGE_URL` is set, the app uses the bridge (even locally). For direct SQL on George-PC, leave `STOCK_SQL_BRIDGE_URL` unset.

---

## Security checklist

- [ ] `STOCK_SQL_BRIDGE_KEY` set on BLADERUNNER (bridge rejects unauthenticated calls)
- [ ] Same key on Vercel — never in git
- [ ] Tunnel uses HTTPS only
- [ ] Bridge is read-only (`SELECT` on STMAST + Positill sales aggregates only)
- [ ] SQL user is `ProtoSyncReadOnly` with read-only intent
- [ ] Do not expose SQL port 1433 to the public internet

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Login failed for user 'ProtoSyncReadOnly'` | Check `SQL_PASSWORD` in BLADERUNNER `.env` |
| `401 Unauthorized` from bridge | `x-api-key` must match `STOCK_SQL_BRIDGE_KEY` |
| Vercel: bridge unreachable | Tunnel running? Hostname correct? Redeploy after env change |
| Vercel: `/stmast` works, sales returns 520 | Bridge on BLADERUNNER is old — run `scripts\deploy_bridge.ps1` from George-PC |
| `BRIDGE_OFFLINE` in Apollo | Bridge down or wrong URL; falls back to `stmast_cache` |
| LAN works, Vercel fails | Tunnel not configured or firewall — Vercel needs public HTTPS |
| Port 8765 in use | Change `STOCK_SQL_BRIDGE_PORT` and tunnel target |

---

## Related

- Bridge script: `scripts/sql-stmast-bridge.py`
- Image intake (port 8766): `scripts/image_intake_http_server.py` — same tunnel pattern
- Apollo verify: `scripts/verify-erp-product.mjs`
- Bridge test: `scripts/test-bridge.mjs`
- Capability 1.1 graduation: `docs/graduations/1.1-live-product-truth.md`

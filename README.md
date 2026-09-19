# Finance Tracker

A self-hosted personal finance tracker. Import your Chase and Capital One
activity, categorize it once, and see where the money actually goes — month by
month and across the year.

Single container, SQLite on a volume, no account linking and no third-party
services. Your statements never leave your machine.

## Features

- **Monthly dashboard** — spending by category, bills paid vs. outstanding, income and savings for the month.
- **Imports** — upload a Chase or Capital One CSV export, or paste transactions straight from the bank's website.
- **Manual entry** — add one-off transactions and edit anything after the fact.
- **Bills** — define recurring bills; matching transactions get flagged automatically as each one is paid.
- **Category rules** — keyword rules that auto-categorize new imports.
- **Income** — line-item income per month, with a reusable template so recurring paychecks prepopulate.
- **Yearly view** — spending by category and by merchant across the whole year.
- **Merchant grouping** — `KROGER #445`, `KROGER FUEL #4907` and `Kroger` collapse into one vendor. Rename and merge merchants by hand where the automatic grouping is too cautious.
- Dark mode, and a layout that works on a phone.

## Quick start (Docker Compose)

```yaml
services:
  finance-tracker:
    image: ghcr.io/jacobruter/financetracker:latest
    container_name: finance-tracker
    ports:
      - "8090:8080"
    environment:
      TZ: America/New_York
      DB_PATH: /data/finance.db
    volumes:
      - finance-data:/data
    restart: unless-stopped

volumes:
  finance-data:
```

```bash
docker compose up -d
```

Then open <http://localhost:8090>.

## Portainer

1. **Stacks → Add stack → Web editor**
2. Paste the compose file above (it is also in this repo as `docker-compose.yml`)
3. **Deploy the stack**

Portainer pulls the image straight from GHCR — nothing to build, and the
package is public so no registry credentials are needed.

To update later: **Stacks → finance-tracker → Pull and redeploy** (tick
*Re-pull image*).

## Plain Docker

```bash
docker run -d \
  --name finance-tracker \
  -p 8090:8080 \
  -v finance-data:/data \
  -e TZ=America/New_York \
  --restart unless-stopped \
  ghcr.io/jacobruter/financetracker:latest
```

## Configuration

| Variable  | Default             | Purpose                                      |
|-----------|---------------------|----------------------------------------------|
| `DB_PATH` | `/data/finance.db`  | SQLite file location. Keep it on the volume. |
| `TZ`      | container default   | Timezone used for "today" on manual entries. |
| `PORT`    | `8090`              | Host port, when using the repo's compose file. |

The container listens on **8080** internally; map it wherever you like.

## Data and backups

Everything lives in one SQLite file on the `/data` volume. To back it up:

```bash
docker cp finance-tracker:/data/finance.db ./finance-backup.db
```

The schema migrates itself forward on startup, so pulling a newer image is
safe — but take a copy of the DB first if you care about the data.

## Security

**There is no authentication.** Anyone who can reach the port can read and
edit every transaction. Run it on your LAN or behind something that does
authenticate — a reverse proxy with auth, a VPN, or Tailscale. Do not expose
it directly to the internet.

## Tags

| Tag        | What it is                          |
|------------|-------------------------------------|
| `latest`   | Newest build from `main`            |
| `v1.2.3`   | A specific release                  |
| `sha-abc1234` | A specific commit                |

Images are built for `linux/amd64` and `linux/arm64` (so a Raspberry Pi works).

## Building it yourself

```bash
git clone https://github.com/JacobRuter/FinanceTracker.git
cd FinanceTracker
docker compose -f docker-compose.build.yml up -d --build
```

Or run `./build.sh` to produce a local `finance-tracker:local` image and deploy
it with `docker-compose.local.yml` — useful when Portainer runs on the same
host and you want your own build rather than the published one.

## Stack

FastAPI + SQLite on the backend, vanilla JS on the front end. No build step,
no node_modules, ~4,700 lines total.

# Phase H deployment runbook

Target: one small Ubuntu 24.04 VPS (2GB is plenty) running the whole system — prober,
scorer, digests, API, dashboard — behind Caddy for automatic TLS. The corpus moves with
the process: **the SQLite file is the product; migrate it, don't recreate it.**

## 1. Provision

- VPS with a static IPv4 (Hetzner CX22 / DigitalOcean basic / similar).
- DNS `A` record: `assay.<yourdomain>` → VPS IP (do this early; TLS issuance needs it).
- Firewall: allow 22, 80, 443 only. `ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable`

## 2. Install runtime

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo apt-get install -y caddy git
sudo useradd -r -m -d /opt/assay -s /usr/sbin/nologin assay
```

## 3. Deploy the app + corpus

```sh
sudo -u assay git clone https://github.com/JasonCZMeng/assay /opt/assay/app
cd /opt/assay/app && sudo -u assay npm ci
# Migrate the corpus from the home PC (run FROM the home PC; stop the local process first
# so the WAL is checkpointed):
#   scp C:/Users/Jason/Coding/assay/data/assay.db user@vps:/tmp/ && ssh vps 'sudo mv /tmp/assay.db /opt/assay/app/data/ && sudo chown assay: /opt/assay/app/data/assay.db'
```

## 4. Production .env  (`/opt/assay/app/.env`, owner assay, mode 600)

```
PROBE_WALLET_KEY=0x...            # same wallet, or rotate at migration (good moment for it)
ANTHROPIC_API_KEY=sk-ant-...
DAILY_BUDGET_USDC=5
HOST=127.0.0.1                    # Caddy is the public face; app stays loopback
TRUST_PROXY=true                  # rate-limit on real client IPs from Caddy
CONTROL_TOKEN=<long random>       # openssl rand -hex 24
RATE_LIMIT_RPM=120
PAYMENTS_ENABLED=false            # flip to true at the revenue launch (needs RECEIVE_WALLET_ADDRESS)
RECEIVE_WALLET_ADDRESS=
```

Run `npx tsx scripts/verify-env.mts` as a preflight — it fails loudly on public-deploy
misconfigurations (default control token, disabled rate limit, missing receive wallet).

## 5. Services

```sh
sudo cp deploy/assay.service /etc/systemd/system/ && sudo systemctl enable --now assay
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # set your domain first
sudo systemctl reload caddy
```

## 6. Verify

- `https://assay.<domain>/healthz` — counts match the home PC's last state
- `https://assay.<domain>/leaderboard` and `/dashboard` (controls prompt for CONTROL_TOKEN)
- `journalctl -u assay -f` through one cron sweep; confirm new probes land and
  `/api/digests` grows the next morning
- **Decommission the home PC keep-alive** (delete the Startup-folder vbs, kill the loop)
  the moment the VPS sweep succeeds — two probers sharing one wallet double-spends the budget.

## 7. Revenue flip (~when first services cross 20 probes)

1. Create a receive wallet (address only on the server — never its key).
2. **Facilitator (required):** the default `x402.org/facilitator` is testnet-only. Mainnet
   settlement needs the CDP facilitator — create a CDP API key, set `FACILITATOR_URL` (and
   auth per CDP docs). This also makes Assay eligible for Bazaar listing.
3. Set `PAYMENTS_ENABLED=true`, `RECEIVE_WALLET_ADDRESS=0x...`, restart.
4. Confirm `/score/<id>` answers HTTP 402 and settles a real payment end-to-end.
5. List Assay's /score endpoint with `discoverable: true` and rich metadata.

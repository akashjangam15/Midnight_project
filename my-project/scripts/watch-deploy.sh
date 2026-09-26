#!/usr/bin/env bash
# LOCAL HELPER (not part of the app) — safe to delete.
#
# Watches the preprod deploy:
#   • every 10 min: appends a status snapshot (alive? dust checkpoint size? log size?)
#   • if the deploy exits WITHOUT recordings deployments.preprod, relaunches it
#     (the wallet checkpoints every 10 min, so a relaunch resumes, it does not restart)
#   • exits by itself once deployments.preprod exists
#
# Start:  nohup bash scripts/watch-deploy.sh </dev/null >/dev/null 2>&1 &
# Stop:   kill $(head -1 monitor.pid)    # or: taskkill.exe //F //T //PID <winpid>
# Read:   tail -f monitor.log

set -u
cd "$(dirname "$0")/.." || exit 1

LOG=monitor.log
STATE=.midnight-state.json
DUST=.midnight-wallet-state/preprod/dust.json
DEPLOY_LOG=deploy-preprod.log
MAX_RELAUNCH=10
POLL_SECS=600   # poll every 10 min (matches the DUST checkpoint cadence)

relaunches=0

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

has_preprod() {
  node -e "const s=require('./$STATE');process.exit(s.deployments && s.deployments.preprod ? 0 : 1)" 2>/dev/null
}

# MSYS `ps` truncates the command column, so scan /proc/*/cmdline instead.
# Match ONLY a live deploy launcher. A naive substring match FALSE-POSITIVES on
# stale shells whose command line merely mentions the script (seen: a stuck
# session-7 bash -c), which would make the monitor think a dead deploy is alive.
#   real shim   : bash <...>/npx tsx src/deploy-preprod-fast.ts   (ends with it)
#   real worker : node <...>/npx-cli.js tsx src/deploy-preprod-fast.ts
#   real tsx    : node <...>/tsx/dist/cli.mjs src/deploy-preprod-fast.ts
# Both patterns below are anchored to the END of the command line.
deploy_running() {
  for p in /proc/[0-9]*; do
    c=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null) || continue
    [ -n "$c" ] || continue
    case "$c" in
      *'deploy-preprod-fast.ts') return 0 ;;
      *'npx-cli.js'*'deploy-preprod-fast'*) return 0 ;;
    esac
  done
  return 1
}

echo $$ > monitor.pid
log "monitor started (bash pid $$, winpid $(cat /proc/$$/winpid 2>/dev/null || echo '?'))"

while true; do
  if has_preprod; then
    log "✅ SUCCESS — deployments.preprod recorded; monitor exiting"
    exit 0
  fi

  if deploy_running; then
    log "alive   dust.json=$(stat -c%s "$DUST" 2>/dev/null || echo n/a)B  log=$(stat -c%s "$DEPLOY_LOG" 2>/dev/null || echo n/a)B"
  else
    if [ "$relaunches" -ge "$MAX_RELAUNCH" ]; then
      log "❌ deploy not running and no preprod deployment — MAX_RELAUNCH ($MAX_RELAUNCH) reached; giving up"
      exit 1
    fi
    relaunches=$((relaunches + 1))
    log "⚠ deploy NOT running and no preprod deployment — relaunch #$relaunches/$MAX_RELAUNCH"
    nohup env MIDNIGHT_FAUCET_TIMEOUT_MS=1800000 \
      MIDNIGHT_DUST_WAIT_TOTAL_MS=43200000 \
      npx tsx src/deploy-preprod-fast.ts >> "$DEPLOY_LOG" 2>&1 &
    sleep "$POLL_SECS"
  fi

  sleep "$POLL_SECS"
done

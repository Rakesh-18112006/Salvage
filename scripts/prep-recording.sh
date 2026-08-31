#!/usr/bin/env bash
# Pre-flight for the 5-minute video.
#
# Run this BEFORE you hit record. It does the two slow things (a live model run and the
# model-driven dashboard) so nothing on camera takes longer than 30 seconds, verifies the
# claims you are about to make on screen, and refuses to pass if any of them is false.
#
#   bash scripts/prep-recording.sh              # full prep (~8 min, rebuilds dashboard)
#   bash scripts/prep-recording.sh --no-dash    # skip the dashboard rebuild (~7 min)
#   bash scripts/prep-recording.sh --offline    # deterministic only, no model calls (~1 min)
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=out/recording
mkdir -p "$OUT"
REBUILD_DASH=1
OFFLINE=0
for a in "$@"; do
  [ "$a" = "--no-dash" ] && REBUILD_DASH=0
  [ "$a" = "--offline" ] && { OFFLINE=1; REBUILD_DASH=0; }
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
FAILED=0

step "1. Infrastructure"
docker compose up -d >/dev/null 2>&1
for i in $(seq 1 30); do
  pg=$(docker inspect -f '{{.State.Health.Status}}' salvage-postgres 2>/dev/null || echo none)
  rd=$(docker inspect -f '{{.State.Health.Status}}' salvage-redis 2>/dev/null || echo none)
  [ "$pg" = healthy ] && [ "$rd" = healthy ] && break
  sleep 2
done
[ "$pg" = healthy ] && ok "postgres healthy" || bad "postgres NOT healthy - is Docker running?"
[ "$rd" = healthy ] && ok "redis healthy"    || bad "redis NOT healthy"
node src/db/migrate.ts >/dev/null 2>&1 && ok "migrations applied" || bad "migrations failed"
docker compose --profile chaos up -d --scale worker=2 >/dev/null 2>&1
sleep 4
workers=$(docker ps --filter name=worker --format '{{.Names}}' | grep -c worker || true)
[ "$workers" -ge 2 ] && ok "$workers chaos workers up" || bad "need 2 worker containers for the chaos demo"

step "2. Tests"
if node --test --test-concurrency=1 "test/**/*.test.ts" > "$OUT/tests.txt" 2>&1; then
  ok "$(grep -E '^ℹ (tests|pass|fail|skipped)' "$OUT/tests.txt" | tr '\n' ' ')"
else
  bad "test suite FAILED - see $OUT/tests.txt"
fi

step "3. Deterministic run (the exactly-reproducible floor)"
node src/phase3.ts --cases 300 --deterministic-only > "$OUT/deterministic.txt" 2>&1
det=$(grep -oE '^\| Recovery rate +\| [0-9.]+% +\| [0-9.]+%' "$OUT/deterministic.txt" | tail -1 || true)
[ -n "$det" ] && ok "saved: $det" || bad "deterministic run produced no headline"

if [ "$OFFLINE" -eq 1 ]; then
  printf '\n\033[33mOFFLINE MODE: skipped the live model run. Present deterministic numbers only.\033[0m\n'
else
  step "4. LIVE model run (~7 min - this is why you run prep first)"
  printf '   working'
  node src/phase3.ts --cases 300 > "$OUT/live.txt" 2>&1 &
  pid=$!
  while kill -0 $pid 2>/dev/null; do printf '.'; sleep 10; done
  wait $pid; rc=$?
  printf '\n'
  if grep -q 'MODEL-DRIVEN' "$OUT/live.txt"; then
    ok "$(grep -A3 'Who decided' "$OUT/live.txt" | grep -oE 'MODEL-DRIVEN[^|]*' | head -1)"
    ok "saved to $OUT/live.txt - this is what you show on camera"
  else
    bad "live run is NOT model-driven (exit $rc). Quota may be out."
    grep -oE '(FALLBACK ONLY|PARTIALLY MODEL-DRIVEN)[^|]*' "$OUT/live.txt" | head -1 | sed 's/^/      /'
    printf '      \033[33mUse --offline and present the deterministic numbers instead.\033[0m\n'
  fi
fi

if [ "$REBUILD_DASH" -eq 1 ]; then
  step "5. Dashboard, model-driven (~7 min)"
  printf '   working'
  node src/dashboard.ts --cases 300 --use-model > "$OUT/dashboard.txt" 2>&1 &
  pid=$!
  while kill -0 $pid 2>/dev/null; do printf '.'; sleep 10; done
  wait $pid
  printf '\n'
fi
if grep -q 'MODEL-DRIVEN' out/dashboard.html 2>/dev/null; then
  ok "dashboard banner says MODEL-DRIVEN"
elif [ -f out/dashboard.html ]; then
  printf '  \033[33m!\033[0m dashboard exists but is DETERMINISTIC - fine, just say so on camera\n'
else
  bad "no dashboard - run: node src/dashboard.ts --cases 300 --use-model"
fi

step "6. Provider budget left for the day"
node --env-file=.env -e "
fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',
 headers:{authorization:'Bearer '+process.env.GROQ_API_KEY,'content-type':'application/json'},
 body:JSON.stringify({model:'openai/gpt-oss-120b',messages:[{role:'user',content:'hi'}],max_completion_tokens:5})})
 .then(r=>console.log('  requests left today:', r.headers.get('x-ratelimit-remaining-requests'),
                      '| tokens left this minute:', r.headers.get('x-ratelimit-remaining-tokens')))
 .catch(()=>console.log('  (could not read budget)'));" 2>/dev/null

step "READY?"
if [ "$FAILED" -eq 0 ]; then
  printf '  \033[32mAll checks passed. Files for the recording are in %s/\033[0m\n' "$OUT"
  printf '  Follow docs/RUNSHEET.md.\n'
else
  printf '  \033[31mSomething failed above. Fix it before recording.\033[0m\n'
  exit 1
fi

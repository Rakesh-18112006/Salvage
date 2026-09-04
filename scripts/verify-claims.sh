#!/usr/bin/env bash
# Recompute every published claim, and fail if one has moved.
#
# Written before recording the demo video, where being wrong on camera is expensive, but
# it is not video-specific: it re-runs each experiment behind a number in the README and
# asserts the number it produces. It caught a dashboard that disagreed with the slide deck
# a day before recording.
#
# The two slow steps are live model runs. Use --offline to skip them and check only the
# deterministic claims, which is most of them.
#
#   bash scripts/verify-claims.sh              # everything (~18 min; two live model runs)
#   bash scripts/verify-claims.sh --no-dash    # skip the dashboard rebuild
#   bash scripts/verify-claims.sh --offline    # deterministic claims only (~1 min, no key)
#
# Every claim in docs/CLAIMS.md that can be recomputed IS recomputed here. If you add a
# number to the script, add its check below - a prep script that verifies a subset of the
# claims gives false confidence about the rest.
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

step "3. The evidence the pitch is built on (all fast, all deterministic)"

# 0:32 slot - the four-arm ladder. Arm 2 gaining nothing is the whole answer to
# "isn't this just smart retry?", so it is asserted rather than eyeballed.
node src/robustness.ts --scenario baseline > "$OUT/ladder.txt" 2>&1
if grep -qE '\| baseline +\| 49\.4% +\| 49\.4% +\| 56\.6% +\| 68\.8%' "$OUT/ladder.txt"; then
  ok "ladder: 49.4 / 49.4 / 56.6 / 68.8 - arm 2 still gains nothing"
else
  bad "LADDER MOVED - the ablation table in docs/CLAIMS.md is now wrong. See $OUT/ladder.txt"
  grep -E '^\| baseline' "$OUT/ladder.txt" | sed 's/^/      /'
fi

# 1:07 slot - the interval, run live on camera. Both the interval and the rank line.
node src/seeds.ts --seeds 50 --cases 300 > "$OUT/seeds.txt" 2>&1
if grep -q '19.8% \[19.1, 20.4\]' "$OUT/seeds.txt" && grep -q '50/50 seeds' "$OUT/seeds.txt"; then
  ok "interval: +19.8 ppt [19.1, 20.4], 50/50 seeds"
else
  bad "INTERVAL MOVED - the multi-cohort table in docs/CLAIMS.md is now wrong. See $OUT/seeds.txt"
fi
if grep -q '29 of 50' "$OUT/seeds.txt"; then
  ok "published seed still ranks 29 of 50 (the line that answers cherry-picking)"
else
  bad "SEED RANK MOVED - do not say '29th of 50' on camera. See $OUT/seeds.txt"
fi

# 2:31 slot - eleven worlds, and the one we lose. Losing all-adverse is a CLAIM we
# make on camera, so a run where it silently started winning must fail this check too.
node src/robustness.ts > "$OUT/robustness.txt" 2>&1
if grep -q '10 of 11' "$OUT/robustness.txt"; then
  ok "robustness: lift established in 10 of 11 worlds"
else
  bad "ROBUSTNESS VERDICT MOVED - the robustness claim in docs/CLAIMS.md is now wrong. See $OUT/robustness.txt"
  grep -A6 'VERDICT' "$OUT/robustness.txt" | sed 's/^/      /'
fi
if grep -qE '^\| all-adverse.*-7\.9' "$OUT/robustness.txt"; then
  ok "all-adverse still -7.9 ppt (the world we lose, and say so)"
else
  bad "all-adverse row moved - check what you are about to claim on camera"
fi

step "4. Deterministic run (the exactly-reproducible floor)"
node src/phase3.ts --cases 300 --deterministic-only > "$OUT/deterministic.txt" 2>&1
det=$(grep -oE '^\| Recovery rate +\| [0-9.]+% +\| [0-9.]+%' "$OUT/deterministic.txt" | tail -1 || true)
[ -n "$det" ] && ok "saved: $det" || bad "deterministic run produced no headline"

if [ "$OFFLINE" -eq 1 ]; then
  printf '\n\033[33mOFFLINE MODE: skipped the live model run. Present deterministic numbers only.\033[0m\n'
else
  step "5. LIVE model run (~7 min - this is why you run prep first)"
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

  step "6. LIVE generalization run (~15 min - the 1:31 slot shows this file)"
  printf '   working'
  node src/generalization.ts --cases 150 > "$OUT/generalization.txt" 2>&1 &
  pid=$!
  while kill -0 $pid 2>/dev/null; do printf '.'; sleep 10; done
  wait $pid
  printf '\n'
  if grep -q 'MODEL-DRIVEN' "$OUT/generalization.txt"; then
    ok "generalization is model-driven - this is the file you cat on camera"
    # The over-confidence row is the most credible thing in the video. If a run ever
    # produced zero of them, the honest response is to say so, not to keep the old line.
    oc=$(grep -oE 'OVER-CONFIDENT, adopted anyway *\| *[0-9]+' "$OUT/generalization.txt" \
         | grep -oE '[0-9]+$' || true)
    [ -n "$oc" ] && ok "over-confident readings this run: $oc (say the number you SEE)" \
                 || bad "could not read the over-confidence row - do not quote 13.8%"
    if grep -qE 'unlocked a charge that can never succeed *\| *0 ' "$OUT/generalization.txt"; then
      ok "zero impossible charges unlocked"
    else
      bad "a reading UNLOCKED AN IMPOSSIBLE CHARGE this run - the claim has changed"
    fi
  else
    bad "generalization run is NOT model-driven. The 1:31 slot has no evidence."
    printf '      \033[33mRe-run when quota returns, or cut the slot.\033[0m\n'
  fi
fi

if [ "$REBUILD_DASH" -eq 1 ]; then
  # DETERMINISTIC on purpose, and this is a presentation decision worth explaining.
  #
  # The video shows the dashboard twice: for the break-even chart and for the audit
  # trail. Neither needs the model. Built with --use-model it instead puts a fifth
  # live observation of the agent arm on screen - one cohort, one run - beside a deck
  # claiming +19.8 ppt across fifty cohorts. Both numbers would be correct and they
  # would look like a contradiction, and a five-minute video has no room to explain
  # the difference. Deterministic, the dashboard reads 50.3% -> 70.7% (+20.3 ppt),
  # which is the single-seed figure already published, and it is exactly reproducible.
  #
  # The audit-trail case the close rests on is a revoked mandate, settled by
  # deterministic triage before any model is consulted, so nothing is lost.
  step "7. Dashboard (deterministic - see the note in this script)"
  node src/dashboard.ts --cases 300 > "$OUT/dashboard.txt" 2>&1
fi
# Checked against out/dashboard.html itself rather than the build log: --offline does
# not rebuild the dashboard, and a stale log would report on a run no longer on disk.
if [ ! -f out/dashboard.html ]; then
  bad "no dashboard - run: node src/dashboard.ts --cases 300"
elif grep -q 'MODEL-DRIVEN' out/dashboard.html; then
  bad "dashboard is MODEL-DRIVEN - one live cohort, which contradicts the 50-cohort figure"
  printf '      \033[33mRebuild without --use-model: node src/dashboard.ts --cases 300\033[0m\n'
elif grep -q '+20.3 ppt' out/dashboard.html; then
  ok "dashboard: 50.3% -> 70.7% (+20.3 ppt), deterministic and exactly reproducible"
else
  bad "dashboard headline is not the published single-seed figure of +20.3 ppt"
fi

step "8. Chaos demo (a saved copy, in case Docker dies on camera)"
if node src/chaos.ts --cases 250 > "$OUT/chaos.txt" 2>&1; then
  ok "saved to $OUT/chaos.txt - the runsheet's fallback if Docker dies mid-take"
else
  bad "chaos demo FAILED - see $OUT/chaos.txt. Do not plan to run this live."
fi

step "9. Provider budget left for the day"
node --env-file=.env -e "
fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',
 headers:{authorization:'Bearer '+process.env.GROQ_API_KEY,'content-type':'application/json'},
 body:JSON.stringify({model:'openai/gpt-oss-120b',messages:[{role:'user',content:'hi'}],max_completion_tokens:5})})
 .then(r=>console.log('  requests left today:', r.headers.get('x-ratelimit-remaining-requests'),
                      '| tokens left this minute:', r.headers.get('x-ratelimit-remaining-tokens')))
 .catch(()=>console.log('  (could not read budget)'));" 2>/dev/null

step "VERDICT"
if [ "$FAILED" -eq 0 ]; then
  printf '  \033[32mAll checks passed. Files for the recording are in %s/\033[0m\n' "$OUT"
  printf '  Every published number still matches what the code produces.\n'
else
  printf '  \033[31mA published claim no longer matches what the code produces.\033[0m\n'
  exit 1
fi

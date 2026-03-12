#!/bin/bash

BRANCH="fix/tools-live-state"
REPO="ChrisRomp/copilot-bridge"
PR=90

poll_count=0

while true; do
  poll_count=$((poll_count + 1))
  echo "=== POLL #$poll_count at $(date '+%H:%M:%S') ==="
  echo

  # 1. CI Status
  echo "--- CI STATUS ---"
  ci_output=$(gh run list --branch "$BRANCH" --limit 3 --json status,conclusion,name 2>&1)
  echo "$ci_output"
  echo

  # Extract CI completion status
  ci_complete=false
  if echo "$ci_output" | grep -qE '"conclusion": "(success|failure|cancelled|skipped)"'; then
    ci_complete=true
  fi

  # 2. CCR Reviews
  echo "--- CCR REVIEWS ---"
  ccr_output=$(gh api "repos/$REPO/pulls/$PR/reviews" --jq '.[] | "\(.user.login): \(.state)"' 2>&1)
  echo "$ccr_output"
  echo

  # Extract review count
  review_count=$(echo "$ccr_output" | grep -c ":")
  
  # 3. CodeQL Alerts
  echo "--- CodeQL ALERTS ---"
  codeql_output=$(gh api "repos/$REPO/code-scanning/alerts?ref=refs/heads/$BRANCH" --jq '.[] | "\(.number) \(.state) \(.rule.id) \(.most_recent_instance.location.path):\(.most_recent_instance.location.start_line)"' 2>&1)
  echo "$codeql_output"
  echo

  # 4. Inline Review Comments
  echo "--- INLINE REVIEW COMMENTS ---"
  comments_output=$(gh api "repos/$REPO/pulls/$PR/comments" --jq '.[] | "[\(.user.login)] \(.path):\(.line) - \(.body[0:500])"' 2>&1)
  echo "$comments_output"
  echo

  # Check completion conditions
  if [ "$ci_complete" = true ] && [ "$review_count" -gt 0 ]; then
    echo MONITORING COMPLETE - CI finished and reviews appeared" 
    echo "Poll count: $poll_count"
    exit 0
  fi

     Waiting... (CI complete: $ci_complete, Reviews: $review_count) - sleeping 30 seconds"echo "
  echo "=================="
  echo
  sleep 30
done

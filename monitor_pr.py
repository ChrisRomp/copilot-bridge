#!/usr/bin/env python3
import subprocess
import time
from datetime import datetime

BRANCH = "fix/tools-live-state"
REPO = "ChrisRomp/copilot-bridge"
PR = 90

poll_count = 0

while True:
    poll_count += 1
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"\n{'='*60}")
    print(f"POLL #{poll_count} at {timestamp}")
    print(f"{'='*60}\n")
    
    # 1. CI Status
    print("--- CI STATUS ---")
    try:
        ci_result = subprocess.run(
            ["gh", "run", "list", "--branch", BRANCH, "--limit", "3", "--json", "status,conclusion,name"],
            capture_output=True,
            text=True,
            timeout=10
        )
        ci_output = ci_result.stdout
        print(ci_output)
    except Exception as e:
        ci_output = f"Error: {e}"
        print(ci_output)
    print()
    
    # Check if CI is complete
    ci_complete = "success" in ci_output or "failure" in ci_output or "cancelled" in ci_output or "skipped" in ci_output
    
    # 2. CCR Reviews
    print("--- CCR REVIEWS ---")
    try:
        jq_filter = '.[] | "\\(.user.login): \\(.state)"'
        ccr_result = subprocess.run(
            ["gh", "api", f"repos/{REPO}/pulls/{PR}/reviews", "--jq", jq_filter],
            capture_output=True,
            text=True,
            timeout=10
        )
        ccr_output = ccr_result.stdout
        print(ccr_output if ccr_output else "(no reviews)")
    except Exception as e:
        ccr_output = f"Error: {e}"
        print(ccr_output)
    print()
    
    # Count reviews
    review_count = len([line for line in ccr_output.split('\n') if ':' in line])
    
    # 3. CodeQL Alerts
    print("--- CodeQL ALERTS ---")
    try:
        jq_filter = '.[] | "\\(.number) \\(.state) \\(.rule.id) \\(.most_recent_instance.location.path):\\(.most_recent_instance.location.start_line)"'
        codeql_result = subprocess.run(
            ["gh", "api", f"repos/{REPO}/code-scanning/alerts?ref=refs/heads/{BRANCH}", "--jq", jq_filter],
            capture_output=True,
            text=True,
            timeout=10
        )
        codeql_output = codeql_result.stdout
        print(codeql_output if codeql_output else "(no alerts)")
    except Exception as e:
        codeql_output = f"Error: {e}"
        print(codeql_output)
    print()
    
    # 4. Inline Review Comments
    print("--- INLINE REVIEW COMMENTS ---")
    try:
        jq_filter = '.[] | "[\\(.user.login)] \\(.path):\\(.line) - \\(.body[0:500])"'
        comments_result = subprocess.run(
            ["gh", "api", f"repos/{REPO}/pulls/{PR}/comments", "--jq", jq_filter],
            capture_output=True,
            text=True,
            timeout=10
        )
        comments_output = comments_result.stdout
        print(comments_output if comments_output else "(no comments)")
    except Exception as e:
        comments_output = f"Error: {e}"
        print(comments_output)
    print()
    
    # Check completion conditions
    if ci_complete and review_count > 0:
        print("✅ MONITORING COMPLETE - CI finished and reviews appeared")
        print(f"Total polls: {poll_count}")
        break
    
    print(f"⏳ Waiting... (CI complete: {ci_complete}, Reviews: {review_count})")
    print(f"{'='*60}\n")
    time.sleep(30)

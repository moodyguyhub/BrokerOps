# Test Results Directory

This directory stores output from acceptance test runs and demo evidence artifacts.

## Files

- `p2-acceptance-YYYY-MM-DD-HHMMSS.log` - Full test run logs (gitignored)
- `p2-acceptance-latest.json` - JSON summary of most recent run (committed for CI)
- `truvesta_page.html` - Rendered HTML snapshot of Truvesta Command Center demo
- `truvesta_page.sha256` - SHA256 hash of the demo page for integrity verification

---

## Demo Evidence: Truvesta Command Center

**Purpose:** Board-ready demo artifact with cryptographic proof of what was shown.

### Artifact Details

| Field | Value |
|-------|-------|
| URL fetched | `http://localhost:3000/truvesta` |
| Capture date | 2026-01-15 (Asia/Nicosia) |
| Kernel commit | `brokerops@5c49f1f` |
| SHA256 | `cfe35f822f4f7a2a7e4299c142d1b893eb9bd630c41528e8fe85ef37f83d7a9e` |

### Reproduction Command

```bash
curl -sS --max-time 5 http://localhost:3000/truvesta > test-results/truvesta_page.html
sha256sum test-results/truvesta_page.html | tee test-results/truvesta_page.sha256
```

### Contract Compliance Checklist

- [x] Uses canonical terms: `AUTHORIZED` / `BLOCKED` (not PASSED/ALLOW)
- [x] Boundary clarity: "Authority layer emits intent; execution platform remains master."
- [x] Economics disclaimer: "Demo numbers are placeholders (do not treat as realized P&L)."
- [x] Routing labeled as `ADVISORY` (not execution)

### Verification

```bash
# Re-verify hash integrity
sha256sum -c test-results/truvesta_page.sha256

# Check for canonical terms
grep -E "AUTHORIZED|BLOCKED" test-results/truvesta_page.html | head -5

# Check boundary clarity
grep -i "intent.*execution platform" test-results/truvesta_page.html
```

---

## Running Tests

```bash
# Ensure services are running first
./scripts/demo.sh &

# Run P2 acceptance tests
./scripts/p2-acceptance-test.sh
```

## CI Integration

The `p2-acceptance-latest.json` file can be consumed by CI systems:

```json
{
  "timestamp": "2026-01-15-120000",
  "git_commit": "b3ee1d9",
  "tests_run": 7,
  "tests_passed": 7,
  "tests_failed": 0,
  "success": true,
  "log_file": "test-results/p2-acceptance-2026-01-15-120000.log"
}
```

Exit code: 0 = all pass, 1 = failures present

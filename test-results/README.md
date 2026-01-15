# Test Results Directory

This directory stores output from acceptance test runs.

## Files

- `p2-acceptance-YYYY-MM-DD-HHMMSS.log` - Full test run logs (gitignored)
- `p2-acceptance-latest.json` - JSON summary of most recent run (committed for CI)

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

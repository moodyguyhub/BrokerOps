# Phase 1 Rejection Reason Normalization

**Version:** 0.1.0  
**Taxonomy Version:** 2026-01-16.v1  
**Status:** Draft  
**Date:** 2026-01-16  
**Relates to:** [PH1-unified-data-layer.md](PH1-unified-data-layer.md), [PH1-lp-lifecycle.md](PH1-lp-lifecycle.md)

## Overview

This specification defines the **rejection reason normalization taxonomy** for LP order rejections. It provides:

1. Stable `reason_class` buckets for coarse categorization
2. Specific `reason_code` values for precise identification
3. Mapping rules from raw LP/bridge error codes
4. Raw data preservation for dispute resolution

## Goals

| Goal | Rationale |
|------|-----------|
| **Broker Visibility** | "Why did LP reject?" in one consistent vocabulary |
| **Consistent Alerting** | Alert rules reference stable codes, not provider strings |
| **Dispute Evidence** | Normalized + raw data in evidence packs |
| **Cross-LP Comparison** | Compare rejection patterns across LPs using same taxonomy |

## Non-Goals (Phase 1)

- ML-based rejection prediction
- Automated remediation
- Real-time LP scoring

---

## Taxonomy Structure

Every `lp.order.rejected` event MUST include:

```json
{
  "normalization": {
    "status": "REJECTED",
    "reason": {
      "taxonomy_version": "2026-01-16.v1",
      "reason_class": "MARGIN",
      "reason_code": "INSUFFICIENT_MARGIN",
      "raw": {
        "provider_code": "10019",
        "provider_message": "Not enough money",
        "provider_fields": {
          "required_margin": 5000.00,
          "available_margin": 3200.50
        }
      }
    }
  }
}
```

---

## Reason Classes (v1)

Coarse buckets that remain stable across taxonomy versions:

| Class | Description | Example |
|-------|-------------|---------|
| `MARGIN` | Insufficient margin or margin-related limits | Account can't cover position |
| `SYMBOL` | Symbol-specific restrictions | Trading halted, market closed |
| `RISK_POLICY` | LP/broker risk limits | Max exposure exceeded |
| `PRICE` | Price-related rejections | Off-market, slippage |
| `LP_INTERNAL` | LP internal issues | Unspecified reject, timeout |
| `CONNECTIVITY` | Connection issues | Bridge down, LP disconnected |
| `RATE_LIMIT` | Throttling | Too many requests |
| `VALIDATION` | Order validation failures | Invalid symbol, volume |
| `DUPLICATE` | Duplicate order detection | Same client_order_id |
| `UNKNOWN` | Unmappable rejection | Requires investigation |

---

## Reason Codes (v1)

### MARGIN Class

| Code | Description | Typical Provider Message |
|------|-------------|-------------------------|
| `INSUFFICIENT_MARGIN` | Free margin below required | "Not enough money", "Insufficient funds" |
| `MARGIN_LEVEL_TOO_LOW` | Margin level % below threshold | "Margin level 80% < 100%" |
| `MARGIN_CALL_ACTIVE` | Account in margin call state | "Account in margin call" |

### SYMBOL Class

| Code | Description | Typical Provider Message |
|------|-------------|-------------------------|
| `SYMBOL_DISABLED` | Symbol trading disabled | "Symbol disabled for trading" |
| `SYMBOL_HALTED` | Trading halted (circuit breaker) | "Trading halted" |
| `MARKET_CLOSED` | Market session closed | "Market is closed" |
| `SYMBOL_NOT_FOUND` | Unknown symbol | "Unknown symbol" |

### RISK_POLICY Class

| Code | Description | Typical Provider Message |
|------|-------------|-------------------------|
| `MAX_EXPOSURE_EXCEEDED` | Position size limit | "Max exposure limit reached" |
| `MAX_ORDER_SIZE_EXCEEDED` | Single order size limit | "Order size exceeds maximum" |
| `ACCOUNT_RESTRICTED` | Account-level trading restriction | "Account restricted" |
| `DAILY_LOSS_LIMIT` | Daily loss limit hit | "Daily loss limit reached" |
| `CONCENTRATION_LIMIT` | Single-symbol concentration | "Position concentration limit" |

### PRICE Class

| Code | Description | Typical Provider Message |
|------|-------------|-------------------------|
| `OFF_MARKET` | Price too far from market | "Off quotes", "Price deviation" |
| `PRICE_CHANGED` | Price moved during processing | "Requote", "Price changed" |
| `SLIPPAGE_LIMIT_EXCEEDED` | Slippage beyond tolerance | "Slippage exceeds limit" |
| `INVALID_PRICE` | Price format/value invalid | "Invalid price" |

### LP_INTERNAL Class

| Code | Description | Typical Provider Message |
|------|-------------|-------------------------|
| `LP_REJECT_UNSPECIFIED` | LP rejected, no specific reason | "Order rejected", "Reject" |
| `LP_TIMEOUT` | LP did not respond in time | "Timeout", "No response" |
| `LP_THROTTLED` | LP rate limiting | "Too many requests" |
| `LP_MAINTENANCE` | LP in maintenance mode | "System maintenance" |

### CONNECTIVITY Class

| Code | Description | Typical Provider Message |
|------|-------------|-------------------------|
| `BRIDGE_DOWN` | Bridge connection lost | "Bridge disconnected" |
| `LP_DISCONNECTED` | LP connection lost | "LP connection lost" |
| `NETWORK_ERROR` | General network failure | "Network error" |

### RATE_LIMIT Class

| Code | Description | Typical Provider Message |
|------|-------------|-------------------------|
| `RATE_LIMITED` | Request rate exceeded | "Rate limit exceeded" |
| `CONCURRENT_LIMIT` | Too many concurrent orders | "Too many pending orders" |

### VALIDATION Class

| Code | Description | Typical Provider Message |
|------|-------------|-------------------------|
| `INVALID_SYMBOL` | Symbol format invalid | "Invalid symbol format" |
| `INVALID_VOLUME` | Volume out of range | "Invalid volume", "Lot size error" |
| `INVALID_ORDER_TYPE` | Order type not supported | "Order type not allowed" |
| `INVALID_EXPIRATION` | Invalid order expiration | "Invalid expiration" |
| `INVALID_STOPS` | Invalid SL/TP | "Invalid stop levels" |

### DUPLICATE Class

| Code | Description | Typical Provider Message |
|------|-------------|-------------------------|
| `DUPLICATE_CLIENT_ORDER_ID` | Client order ID already used | "Duplicate order ID" |
| `DUPLICATE_ORDER` | Order appears to be duplicate | "Duplicate order detected" |

### UNKNOWN Class

| Code | Description | When Used |
|------|-------------|-----------|
| `UNKNOWN_REJECT` | Could not map to taxonomy | Default fallback |

---

## Mapping Rules

### Mapping Function Signature

```typescript
interface ReasonMappingInput {
  source_kind: 'SIM' | 'MT5_MANAGER' | 'BRIDGE' | 'LP';
  provider_code: string | number | null;
  provider_message: string | null;
  provider_fields: Record<string, unknown>;
}

interface ReasonMappingOutput {
  taxonomy_version: string;
  reason_class: ReasonClass;
  reason_code: ReasonCode;
  raw: {
    provider_code: string | null;
    provider_message: string | null;
    provider_fields: Record<string, unknown>;
  };
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

type ReasonMapper = (input: ReasonMappingInput) => ReasonMappingOutput;
```

### Mapping Algorithm

```typescript
function mapRejectionReason(input: ReasonMappingInput): ReasonMappingOutput {
  const { source_kind, provider_code, provider_message, provider_fields } = input;
  
  // 1. Try exact code match
  const exactMatch = EXACT_CODE_MAPPINGS[source_kind]?.[String(provider_code)];
  if (exactMatch) {
    return {
      taxonomy_version: CURRENT_TAXONOMY_VERSION,
      ...exactMatch,
      raw: { provider_code: String(provider_code), provider_message, provider_fields },
      confidence: 'HIGH',
    };
  }
  
  // 2. Try message pattern match
  const messageMatch = findMessagePattern(provider_message);
  if (messageMatch) {
    return {
      taxonomy_version: CURRENT_TAXONOMY_VERSION,
      ...messageMatch,
      raw: { provider_code: String(provider_code), provider_message, provider_fields },
      confidence: 'MEDIUM',
    };
  }
  
  // 3. Fallback to UNKNOWN
  return {
    taxonomy_version: CURRENT_TAXONOMY_VERSION,
    reason_class: 'UNKNOWN',
    reason_code: 'UNKNOWN_REJECT',
    raw: { provider_code: String(provider_code), provider_message, provider_fields },
    confidence: 'LOW',
  };
}
```

---

## Simulator Mapping Fixtures

```yaml
# fixtures/sim-reason-mapping.yaml
version: "2026-01-16.v1"
source_kind: SIM

exact_code_mappings:
  "MARGIN_001":
    reason_class: MARGIN
    reason_code: INSUFFICIENT_MARGIN
    
  "MARGIN_002":
    reason_class: MARGIN
    reason_code: MARGIN_LEVEL_TOO_LOW
    
  "SYMBOL_001":
    reason_class: SYMBOL
    reason_code: SYMBOL_DISABLED
    
  "SYMBOL_002":
    reason_class: SYMBOL
    reason_code: MARKET_CLOSED
    
  "PRICE_001":
    reason_class: PRICE
    reason_code: OFF_MARKET
    
  "PRICE_002":
    reason_class: PRICE
    reason_code: SLIPPAGE_LIMIT_EXCEEDED
    
  "RISK_001":
    reason_class: RISK_POLICY
    reason_code: MAX_EXPOSURE_EXCEEDED
    
  "RISK_002":
    reason_class: RISK_POLICY
    reason_code: MAX_ORDER_SIZE_EXCEEDED

message_patterns:
  - pattern: "(?i)not enough (money|margin|funds)"
    reason_class: MARGIN
    reason_code: INSUFFICIENT_MARGIN
    
  - pattern: "(?i)market.*(closed|not open)"
    reason_class: SYMBOL
    reason_code: MARKET_CLOSED
    
  - pattern: "(?i)symbol.*(disabled|halted)"
    reason_class: SYMBOL
    reason_code: SYMBOL_DISABLED
    
  - pattern: "(?i)(off.?quote|requote)"
    reason_class: PRICE
    reason_code: OFF_MARKET
```

---

## MT5 Mapping Fixtures

```yaml
# fixtures/mt5-reason-mapping.yaml
version: "2026-01-16.v1"
source_kind: MT5_MANAGER

# MT5 retcode values
exact_code_mappings:
  "10019":  # TRADE_RETCODE_NO_MONEY
    reason_class: MARGIN
    reason_code: INSUFFICIENT_MARGIN
    
  "10018":  # TRADE_RETCODE_MARKET_CLOSED
    reason_class: SYMBOL
    reason_code: MARKET_CLOSED
    
  "10017":  # TRADE_RETCODE_TRADE_DISABLED
    reason_class: SYMBOL
    reason_code: SYMBOL_DISABLED
    
  "10015":  # TRADE_RETCODE_INVALID_PRICE
    reason_class: PRICE
    reason_code: INVALID_PRICE
    
  "10016":  # TRADE_RETCODE_INVALID_STOPS
    reason_class: VALIDATION
    reason_code: INVALID_STOPS
    
  "10014":  # TRADE_RETCODE_INVALID_VOLUME
    reason_class: VALIDATION
    reason_code: INVALID_VOLUME
    
  "10031":  # TRADE_RETCODE_LIMIT_ORDERS
    reason_class: RISK_POLICY
    reason_code: CONCENTRATION_LIMIT
    
  "10033":  # TRADE_RETCODE_LIMIT_VOLUME
    reason_class: RISK_POLICY
    reason_code: MAX_ORDER_SIZE_EXCEEDED
    
  "10034":  # TRADE_RETCODE_ORDER_CHANGED
    reason_class: PRICE
    reason_code: PRICE_CHANGED
    
  "10006":  # TRADE_RETCODE_REJECT
    reason_class: LP_INTERNAL
    reason_code: LP_REJECT_UNSPECIFIED
    
  "10007":  # TRADE_RETCODE_CANCEL
    reason_class: LP_INTERNAL
    reason_code: LP_REJECT_UNSPECIFIED
    
  "10004":  # TRADE_RETCODE_REQUOTE
    reason_class: PRICE
    reason_code: OFF_MARKET
    
  "10021":  # TRADE_RETCODE_PRICE_CHANGED
    reason_class: PRICE
    reason_code: PRICE_CHANGED
    
  "10024":  # TRADE_RETCODE_TOO_MANY_REQUESTS
    reason_class: RATE_LIMIT
    reason_code: RATE_LIMITED
    
  "10030":  # TRADE_RETCODE_POSITION_CLOSED
    reason_class: LP_INTERNAL
    reason_code: LP_REJECT_UNSPECIFIED

message_patterns:
  - pattern: "(?i)no money"
    reason_class: MARGIN
    reason_code: INSUFFICIENT_MARGIN
```

---

## Taxonomy Versioning

### Version Format

```
{YYYY-MM-DD}.v{N}
```

Example: `2026-01-16.v1`

### Version Increment Rules

| Change Type | Version Action | Example |
|-------------|----------------|---------|
| New `reason_code` added | Increment minor (v1 → v2) | Add `MAX_DAILY_ORDERS` |
| New `reason_class` added | Increment minor | Add `COMPLIANCE` class |
| `reason_code` removed | Major increment + deprecation | Deprecate `OLD_CODE` |
| `reason_code` renamed | Major increment + migration | Rename with alias |
| Mapping rule change | No version change | Different regex pattern |

### Backward Compatibility

- New codes MUST be added, never removed in minor versions
- Deprecated codes MUST emit warnings for 90 days before removal
- Evidence packs MUST include `taxonomy_version` for audit trail

---

## Evidence Pack Integration

Rejection events in evidence packs MUST include:

```json
{
  "rejection_evidence": {
    "event_id": "...",
    "event_type": "lp.order.rejected",
    "taxonomy_version": "2026-01-16.v1",
    "normalized": {
      "reason_class": "MARGIN",
      "reason_code": "INSUFFICIENT_MARGIN"
    },
    "raw": {
      "provider_code": "10019",
      "provider_message": "Not enough money",
      "provider_fields": {
        "required_margin": 5000.00,
        "available_margin": 3200.50,
        "margin_level_percent": 64.01
      }
    },
    "mapping_confidence": "HIGH",
    "adapter": {
      "source_kind": "MT5_MANAGER",
      "adapter_version": "1.0.0"
    }
  }
}
```

---

## Alerting Integration

Alert rules can reference stable reason codes:

```yaml
# alerts/rejection-alerts.yaml
alerts:
  - name: high_margin_rejection_rate
    condition: |
      rate(rejections{reason_class="MARGIN"}[5m]) > 0.1
    severity: warning
    
  - name: lp_connectivity_issue
    condition: |
      count(rejections{reason_class="CONNECTIVITY"}[1m]) > 5
    severity: critical
    
  - name: unknown_rejection_spike
    condition: |
      rate(rejections{reason_code="UNKNOWN_REJECT"}[5m]) > 0.05
    severity: warning
    annotation: "High rate of unmapped rejections - taxonomy update needed"
```

---

## Acceptance Criteria

| ID | Criterion | Verification |
|----|-----------|--------------|
| AC-1 | All `lp.order.rejected` events have `taxonomy_version` | Schema validation |
| AC-2 | All rejections have `reason_class` and `reason_code` | Required field check |
| AC-3 | Raw provider data is always preserved | Fixture tests |
| AC-4 | Unmapped inputs → `UNKNOWN_REJECT` with raw data | Fallback test |
| AC-5 | Mapping is deterministic | Same input → same output |
| AC-6 | Fixture coverage: 20+ mapped, 10+ unmapped | Fixture count |
| AC-7 | Evidence packs include rejection details | Evidence pack test |

---

## Test Fixtures

### Mapped Examples (20+)

```json
[
  {"provider_code": "10019", "provider_message": "Not enough money", "expected_class": "MARGIN", "expected_code": "INSUFFICIENT_MARGIN"},
  {"provider_code": "10018", "provider_message": "Market closed", "expected_class": "SYMBOL", "expected_code": "MARKET_CLOSED"},
  {"provider_code": "10017", "provider_message": "Trading disabled", "expected_class": "SYMBOL", "expected_code": "SYMBOL_DISABLED"},
  {"provider_code": "10015", "provider_message": "Invalid price", "expected_class": "PRICE", "expected_code": "INVALID_PRICE"},
  {"provider_code": "10014", "provider_message": "Invalid volume", "expected_class": "VALIDATION", "expected_code": "INVALID_VOLUME"},
  {"provider_code": "10004", "provider_message": "Requote", "expected_class": "PRICE", "expected_code": "OFF_MARKET"},
  {"provider_code": "10024", "provider_message": "Too many requests", "expected_class": "RATE_LIMIT", "expected_code": "RATE_LIMITED"},
  {"provider_code": "MARGIN_001", "provider_message": "Insufficient margin", "expected_class": "MARGIN", "expected_code": "INSUFFICIENT_MARGIN"},
  {"provider_code": "MARGIN_002", "provider_message": "Margin level below threshold", "expected_class": "MARGIN", "expected_code": "MARGIN_LEVEL_TOO_LOW"},
  {"provider_code": "SYMBOL_001", "provider_message": "Symbol disabled", "expected_class": "SYMBOL", "expected_code": "SYMBOL_DISABLED"},
  {"provider_code": "SYMBOL_002", "provider_message": "Market is closed", "expected_class": "SYMBOL", "expected_code": "MARKET_CLOSED"},
  {"provider_code": "PRICE_001", "provider_message": "Off quotes", "expected_class": "PRICE", "expected_code": "OFF_MARKET"},
  {"provider_code": "PRICE_002", "provider_message": "Slippage exceeded", "expected_class": "PRICE", "expected_code": "SLIPPAGE_LIMIT_EXCEEDED"},
  {"provider_code": "RISK_001", "provider_message": "Max exposure", "expected_class": "RISK_POLICY", "expected_code": "MAX_EXPOSURE_EXCEEDED"},
  {"provider_code": "RISK_002", "provider_message": "Order too large", "expected_class": "RISK_POLICY", "expected_code": "MAX_ORDER_SIZE_EXCEEDED"},
  {"provider_code": "10033", "provider_message": "Volume limit", "expected_class": "RISK_POLICY", "expected_code": "MAX_ORDER_SIZE_EXCEEDED"},
  {"provider_code": "10031", "provider_message": "Order limit", "expected_class": "RISK_POLICY", "expected_code": "CONCENTRATION_LIMIT"},
  {"provider_code": "10021", "provider_message": "Price changed", "expected_class": "PRICE", "expected_code": "PRICE_CHANGED"},
  {"provider_code": "10016", "provider_message": "Invalid stops", "expected_class": "VALIDATION", "expected_code": "INVALID_STOPS"},
  {"provider_code": "10006", "provider_message": "Rejected", "expected_class": "LP_INTERNAL", "expected_code": "LP_REJECT_UNSPECIFIED"}
]
```

### Unmapped Examples (10+)

```json
[
  {"provider_code": "99999", "provider_message": "Unknown error XYZ", "expected_class": "UNKNOWN", "expected_code": "UNKNOWN_REJECT"},
  {"provider_code": null, "provider_message": "Something went wrong", "expected_class": "UNKNOWN", "expected_code": "UNKNOWN_REJECT"},
  {"provider_code": "ERR_CUSTOM_001", "provider_message": "Custom LP error", "expected_class": "UNKNOWN", "expected_code": "UNKNOWN_REJECT"},
  {"provider_code": "", "provider_message": "", "expected_class": "UNKNOWN", "expected_code": "UNKNOWN_REJECT"},
  {"provider_code": "BRIDGE_ERR_99", "provider_message": "Internal bridge error", "expected_class": "UNKNOWN", "expected_code": "UNKNOWN_REJECT"},
  {"provider_code": "-1", "provider_message": "Connection reset", "expected_class": "UNKNOWN", "expected_code": "UNKNOWN_REJECT"},
  {"provider_code": "0", "provider_message": null, "expected_class": "UNKNOWN", "expected_code": "UNKNOWN_REJECT"},
  {"provider_code": "NEW_CODE_2027", "provider_message": "Future error type", "expected_class": "UNKNOWN", "expected_code": "UNKNOWN_REJECT"},
  {"provider_code": "LP_SPECIFIC_ERR", "provider_message": "LP-specific rejection", "expected_class": "UNKNOWN", "expected_code": "UNKNOWN_REJECT"},
  {"provider_code": "DEPRECATED_001", "provider_message": "Legacy error", "expected_class": "UNKNOWN", "expected_code": "UNKNOWN_REJECT"}
]
```

---

## References

- [PH1-unified-data-layer.md](PH1-unified-data-layer.md) - Event envelope spec
- [PH1-lp-lifecycle.md](PH1-lp-lifecycle.md) - Order lifecycle state machine
- [MT5 Trade Server Return Codes](https://www.mql5.com/en/docs/constants/errorswarnings/enum_trade_return_codes) - MT5 retcode reference

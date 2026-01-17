# ORDER_DIGEST Specification

**Version:** 1.0  
**Status:** Implemented  
**Date:** 2026-01-16

## Purpose

The `order_digest` cryptographically binds a Decision Token to the exact order content that was evaluated. This ensures:

1. **Execution correctness**: The platform can verify it's executing the same order that was authorized
2. **Tamper detection**: Any modification to order fields after authorization invalidates the token
3. **Dispute resolution**: Digest comparison becomes a checksum operation, not a debate

## Invariant

> If a platform executes an order whose digest differs from the token's `order_digest`, it executed an **unauthorized order** relative to the decision record.

## Canonical Input Fields

The digest is computed from exactly these fields, in this order:

| Field | Type | Normalization |
|-------|------|---------------|
| `client_order_id` | string | trimmed, as-is (case-sensitive) |
| `symbol` | string | trimmed, UPPERCASE |
| `side` | string | UPPERCASE ("BUY" or "SELL") |
| `qty` | integer | integer (no decimals) |
| `price` | number | fixed 8 decimal places, or "null" if absent |

## Serialization Format

Delimited string with pipe separator:

```
{client_order_id}|{symbol}|{side}|{qty}|{price}
```

### Examples

```
ORDER-001|AAPL|BUY|100|185.50000000
ORDER-002|EURUSD|SELL|50000|null
```

## Algorithm

SHA-256 hash of the canonical string, output as lowercase hex (64 characters).

```
order_digest = SHA256(canonical_string).hex()
```

## Implementation Reference

```typescript
import { createHash } from 'crypto';

interface OrderDigestInput {
  client_order_id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  price?: number | null;
}

function computeOrderDigest(order: OrderDigestInput): string {
  const normalizedSymbol = order.symbol.trim().toUpperCase();
  const normalizedSide = order.side.toUpperCase();
  const normalizedQty = Math.floor(order.qty);
  const normalizedPrice = order.price != null 
    ? order.price.toFixed(8) 
    : 'null';
  
  const canonical = [
    order.client_order_id.trim(),
    normalizedSymbol,
    normalizedSide,
    normalizedQty.toString(),
    normalizedPrice
  ].join('|');
  
  return createHash('sha256').update(canonical).digest('hex');
}
```

## Verification Procedure

1. Extract `order_digest` from Decision Token payload
2. Recompute digest from order about to be executed
3. Compare: `token.order_digest === recomputed_digest`
4. If mismatch: **REJECT execution** (order was modified)

## Token Payload Extension

The Decision Token payload now includes:

```json
{
  "order_digest": "a1b2c3d4...",  // SHA-256 hex (64 chars)
  "order_digest_version": "v1",   // For future algorithm changes
  // ... existing fields
}
```

## Security Considerations

- The digest is computed server-side and signed within the token
- Changing any order field changes the digest
- Market orders (no price) use literal "null" in the canonical string
- Integer overflow: `qty` should be validated before digest computation

## Test Vectors

| Input | Expected Digest |
|-------|-----------------|
| `ORDER-001\|AAPL\|BUY\|100\|185.50000000` | `7a8b9c...` (compute at runtime) |
| `ORDER-001\|aapl\|BUY\|100\|185.50000000` | Different (symbol not normalized) |
| `ORDER-001\|AAPL\|BUY\|100\|185.50000001` | Different (price differs) |
| `ORDER-001\|AAPL\|BUY\|100\|null` | Market order digest |

## Changelog

- **v1** (2026-01-16): Initial specification

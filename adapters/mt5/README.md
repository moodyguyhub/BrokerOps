# MT5 Adapter

Provider adapter for MetaTrader 5 integration.

## Purpose

This adapter connects BrokerOps governance to MetaTrader 5 terminal for:
- Reading execution outcomes (`history_deals_get`)
- Recording economic events from trades
- (Future) Submitting orders through governance pipeline

## Status

**Skeleton only** - requires MT5 terminal running locally with Python bridge configured.

## Prerequisites

```bash
pip install MetaTrader5
```

MT5 terminal must be running and logged into a broker account.

## Usage

```bash
# Start the adapter (connects to local MT5)
python adapter.py

# Or run specific sync
python adapter.py --sync-deals --since 2026-01-01
```

## Architecture

```
MT5 Terminal (local)
    ↓ (MetaTrader5 Python package)
MT5 Adapter
    ↓ (HTTP)
BrokerOps APIs
    - POST /economics/event (trade execution data)
    - Webhook registration for governance events
```

## Not In Scope

- Trade execution (MT5 `order_send`) - governance only
- Real-time streaming - batch sync only for v0
- Multi-terminal - single local terminal for v0

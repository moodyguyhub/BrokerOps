"""
MT5 Adapter for BrokerOps

Connects MetaTrader 5 terminal to BrokerOps governance APIs.
Reads execution data and posts economic events.

Prerequisites:
- pip install MetaTrader5 requests
- MT5 terminal running and logged in

Usage:
    python adapter.py                    # Interactive mode
    python adapter.py --sync-deals       # Sync recent deals
    python adapter.py --health           # Check connections
"""

import argparse
import json
from datetime import datetime, timedelta
from typing import Optional
import requests

# MT5 import - graceful fallback if not installed
try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    MT5_AVAILABLE = False
    print("Warning: MetaTrader5 package not installed. Running in mock mode.")

# Configuration
BROKEROPS_BASE_URL = "http://localhost"
ECONOMICS_URL = f"{BROKEROPS_BASE_URL}:7005"
WEBHOOKS_URL = f"{BROKEROPS_BASE_URL}:7006"


def mt5_initialize() -> bool:
    """Initialize MT5 connection."""
    if not MT5_AVAILABLE:
        print("[MOCK] MT5 initialize - simulated success")
        return True
    
    if not mt5.initialize():
        print(f"MT5 initialize failed: {mt5.last_error()}")
        return False
    
    info = mt5.terminal_info()
    if info:
        print(f"Connected to MT5: {info.name}")
        print(f"  Build: {info.build}")
        print(f"  Company: {info.company}")
    return True


def mt5_shutdown():
    """Shutdown MT5 connection."""
    if MT5_AVAILABLE:
        mt5.shutdown()
    print("MT5 connection closed")


def get_recent_deals(since: datetime) -> list:
    """Get deals since specified date."""
    if not MT5_AVAILABLE:
        # Mock data for development
        return [
            {
                "ticket": 12345678,
                "symbol": "EURUSD",
                "type": 0,  # BUY
                "volume": 0.1,
                "price": 1.0850,
                "profit": 12.50,
                "commission": -0.50,
                "swap": -0.10,
                "time": datetime.now().timestamp(),
                "comment": "demo-order-001"
            }
        ]
    
    # Real MT5 call
    deals = mt5.history_deals_get(since, datetime.now())
    if deals is None:
        print(f"Failed to get deals: {mt5.last_error()}")
        return []
    
    return [deal._asdict() for deal in deals]


def post_economic_event(trace_id: str, event_type: str, data: dict) -> bool:
    """Post economic event to BrokerOps."""
    payload = {
        "traceId": trace_id,
        "type": event_type,
        "grossRevenue": data.get("profit", 0),
        "fees": abs(data.get("commission", 0)),
        "costs": abs(data.get("swap", 0)),
        "currency": "USD",
        "source": "mt5"
    }
    
    try:
        resp = requests.post(
            f"{ECONOMICS_URL}/economics/event",
            json=payload,
            timeout=5
        )
        if resp.ok:
            print(f"  → Economic event posted: {trace_id}")
            return True
        else:
            print(f"  → Failed: {resp.status_code} - {resp.text}")
            return False
    except Exception as e:
        print(f"  → Error posting event: {e}")
        return False


def sync_deals(since: datetime):
    """Sync deals from MT5 to BrokerOps economics."""
    print(f"\nSyncing deals since {since.isoformat()}...")
    
    deals = get_recent_deals(since)
    print(f"Found {len(deals)} deals")
    
    for deal in deals:
        ticket = deal.get("ticket", "unknown")
        symbol = deal.get("symbol", "")
        profit = deal.get("profit", 0)
        
        # Use ticket as trace ID (or extract from comment if available)
        trace_id = deal.get("comment") or f"mt5-{ticket}"
        
        event_type = "TRADE_EXECUTED" if profit >= 0 else "TRADE_EXECUTED"
        
        print(f"\n[Deal {ticket}] {symbol} profit={profit}")
        post_economic_event(trace_id, event_type, deal)


def check_health():
    """Check connections to MT5 and BrokerOps."""
    print("\n=== Health Check ===\n")
    
    # MT5
    print("MT5 Terminal:")
    if mt5_initialize():
        print("  ✓ Connected")
        if MT5_AVAILABLE:
            account = mt5.account_info()
            if account:
                print(f"  Account: {account.login}")
                print(f"  Balance: {account.balance}")
        mt5_shutdown()
    else:
        print("  ✗ Not connected")
    
    # BrokerOps Economics
    print("\nBrokerOps Economics API:")
    try:
        resp = requests.get(f"{ECONOMICS_URL}/health", timeout=2)
        if resp.ok:
            print(f"  ✓ Connected ({ECONOMICS_URL})")
        else:
            print(f"  ✗ Error: {resp.status_code}")
    except Exception as e:
        print(f"  ✗ Not reachable: {e}")
    
    # BrokerOps Webhooks
    print("\nBrokerOps Webhooks API:")
    try:
        resp = requests.get(f"{WEBHOOKS_URL}/health", timeout=2)
        if resp.ok:
            print(f"  ✓ Connected ({WEBHOOKS_URL})")
        else:
            print(f"  ✗ Error: {resp.status_code}")
    except Exception as e:
        print(f"  ✗ Not reachable: {e}")


def register_webhook(url: str, events: list):
    """Register a webhook to receive BrokerOps events."""
    payload = {
        "url": url,
        "events": events
    }
    
    try:
        resp = requests.post(
            f"{WEBHOOKS_URL}/webhooks",
            json=payload,
            timeout=5
        )
        if resp.ok:
            data = resp.json()
            print(f"Webhook registered: {data.get('id')}")
            return data
        else:
            print(f"Failed to register webhook: {resp.status_code}")
            return None
    except Exception as e:
        print(f"Error registering webhook: {e}")
        return None


def main():
    parser = argparse.ArgumentParser(description="MT5 Adapter for BrokerOps")
    parser.add_argument("--health", action="store_true", help="Check connections")
    parser.add_argument("--sync-deals", action="store_true", help="Sync recent deals")
    parser.add_argument("--since", type=str, help="Sync deals since date (YYYY-MM-DD)")
    parser.add_argument("--register-webhook", type=str, help="Register webhook URL")
    
    args = parser.parse_args()
    
    if args.health:
        check_health()
        return
    
    if args.sync_deals:
        since = datetime.now() - timedelta(days=1)
        if args.since:
            since = datetime.fromisoformat(args.since)
        
        if mt5_initialize():
            sync_deals(since)
            mt5_shutdown()
        return
    
    if args.register_webhook:
        register_webhook(
            args.register_webhook,
            ["trace.completed", "override.approved", "economics.recorded"]
        )
        return
    
    # Interactive mode
    print("MT5 Adapter for BrokerOps")
    print("=" * 40)
    print("\nCommands:")
    print("  --health         Check connections")
    print("  --sync-deals     Sync recent deals to economics")
    print("  --register-webhook <url>  Register webhook")
    print("\nRun with --help for more options")


if __name__ == "__main__":
    main()

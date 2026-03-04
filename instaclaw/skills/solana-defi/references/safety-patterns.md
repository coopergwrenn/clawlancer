# Safety Patterns for Solana DeFi Trading

## Retry Wrapper
Always use exponential backoff. Never retry more than 3 times.

```python
import time

MAX_RETRIES = 3
BACKOFF_DELAYS = [5, 15, 45]  # seconds

TRANSIENT_ERRORS = [
    "rate limit", "429", "timeout", "timed out",
    "blockhash not found", "blockhash expired",
    "connection refused", "ECONNRESET",
    "node is behind", "node unhealthy",
]

PERMANENT_ERRORS = [
    "insufficient funds", "insufficient balance",
    "invalid mint", "account not found",
    "signature verification failed",
    "program failed to complete",
    "custom program error",
    "transaction too large",
]

def classify_error(error_msg: str) -> str:
    lower = error_msg.lower()
    for pattern in PERMANENT_ERRORS:
        if pattern in lower:
            return "permanent"
    for pattern in TRANSIENT_ERRORS:
        if pattern in lower:
            return "transient"
    return "unknown"

def retry_with_backoff(func, *args, **kwargs):
    for attempt in range(MAX_RETRIES):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            error_class = classify_error(str(e))
            if error_class == "permanent":
                raise  # Do not retry permanent errors
            if attempt == MAX_RETRIES - 1:
                raise  # Final attempt failed
            delay = BACKOFF_DELAYS[attempt]
            print(f"Attempt {attempt + 1}/{MAX_RETRIES} failed ({error_class}). Retrying in {delay}s...")
            time.sleep(delay)
```

## Balance Pre-Check
Always check balance before any trade.

```python
def check_sufficient_balance(required_sol: float, wallet_balance_lamports: int) -> bool:
    balance_sol = wallet_balance_lamports / 1e9
    # Reserve 0.01 SOL for transaction fees
    available = balance_sol - 0.01
    return available >= required_sol
```

## Transaction Confirmation
Poll for confirmation with timeout.

```python
import httpx
import time

def confirm_transaction(rpc_url: str, signature: str, timeout: int = 30) -> bool:
    start = time.time()
    while time.time() - start < timeout:
        resp = httpx.post(rpc_url, json={
            "jsonrpc": "2.0", "id": 1,
            "method": "getSignatureStatuses",
            "params": [[signature], {"searchTransactionHistory": True}]
        })
        result = resp.json().get("result", {}).get("value", [None])[0]
        if result and result.get("confirmationStatus") in ("confirmed", "finalized"):
            if result.get("err") is None:
                return True
            else:
                raise Exception(f"Transaction failed: {result['err']}")
        time.sleep(2)
    raise Exception(f"Transaction not confirmed within {timeout}s")
```

## Daily Loss Tracking
Track cumulative losses per day to enforce daily loss limit.

```python
import json
import os
from datetime import date

LOSS_TRACKER_PATH = os.path.expanduser("~/.openclaw/solana-defi/daily-losses.json")

def get_daily_losses() -> float:
    try:
        with open(LOSS_TRACKER_PATH) as f:
            data = json.load(f)
        if data.get("date") != str(date.today()):
            return 0.0  # New day, reset
        return data.get("total_loss_sol", 0.0)
    except (FileNotFoundError, json.JSONDecodeError):
        return 0.0

def record_loss(loss_sol: float):
    today = str(date.today())
    current = get_daily_losses()
    os.makedirs(os.path.dirname(LOSS_TRACKER_PATH), exist_ok=True)
    with open(LOSS_TRACKER_PATH, "w") as f:
        json.dump({"date": today, "total_loss_sol": current + loss_sol}, f)

def check_daily_limit(trade_amount_sol: float, daily_limit_sol: float = 0.5) -> bool:
    current_losses = get_daily_losses()
    return (current_losses + trade_amount_sol) <= daily_limit_sol
```

## Context-Safe Output
Never dump raw data. Always summarize.

```python
def format_trade_result(result: dict) -> str:
    action = result.get("action", "TRADE")
    token = result.get("token", "???")
    amount = result.get("amount", 0)
    price = result.get("price_usd", "?")
    sig = result.get("signature", "")[:8]
    balance = result.get("remaining_sol", "?")
    return f"✅ {action} {amount} {token} at ${price} — tx: {sig}... | Balance: {balance} SOL"

def format_error(error: str, attempt: int, max_retries: int = 3) -> str:
    short_error = error[:100]  # Truncate long errors
    if attempt >= max_retries:
        return f"❌ Failed after {max_retries} attempts: {short_error}"
    return f"❌ Attempt {attempt}/{max_retries}: {short_error}. Retrying..."
```

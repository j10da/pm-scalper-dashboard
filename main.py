"""Realtime dashboard for Polymarket Spread Scalper.

Serves a dark-themed HTML dashboard with auto-refresh via SSE.
Reads from ../data/polymarket.db
"""

import asyncio
import json
import os
import sqlite3
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
DB_PATH = Path(os.getenv("DB_PATH", "../data/polymarket.db"))
ROOT = Path(__file__).parent

# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def _conn():
    return sqlite3.connect(str(DB_PATH), check_same_thread=False)


def _rowdicts(cur) -> list[dict]:
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_summary() -> dict:
    conn = _conn()
    try:
        # capital / pnl
        c = conn.execute(
            """
            SELECT COALESCE(SUM(entry_value),0), COALESCE(SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END),0),
                   COUNT(*), COALESCE(SUM(pnl),0)
            FROM trades WHERE status='closed' AND pnl IS NOT NULL
            """
        ).fetchone()
        total_closed, wins, total_closed_count, total_pnl = c if c else (0, 0, 0, 0)

        open_count = conn.execute(
            "SELECT COUNT(*) FROM trades WHERE status='open'"
        ).fetchone()[0]

        exposure = conn.execute(
            "SELECT COALESCE(SUM(price*size),0) FROM trades WHERE status='open'"
        ).fetchone()[0]

        win_rate = (wins / total_closed_count * 100) if total_closed_count else 0

        # last cycle timestamp from trades
        last = conn.execute(
            "SELECT MAX(opened_at) FROM trades"
        ).fetchone()[0]

        return {
            "capital": 100.0,
            "exposure": round(exposure, 2),
            "open_positions": open_count,
            "closed_trades": total_closed_count,
            "win_rate": round(win_rate, 1),
            "total_pnl": round(total_pnl, 2),
            "last_cycle": last or "Never",
        }
    finally:
        conn.close()


def get_open_positions() -> list[dict]:
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT id, market_id, side, price, size, confidence, rationale, opened_at, market_question FROM trades WHERE status='open' ORDER BY opened_at DESC"
        ).fetchall()
        out = []
        for r in rows:
            entry = r[2] * r[3]  # price * size
            # unrealised pnl placeholder (no live price in DB yet)
            out.append({
                "id": r[0],
                "market_id": r[1],
                "side": r[2],
                "entry_price": r[3],
                "size": r[4],
                "confidence": r[5],
                "rationale": r[6],
                "opened_at": r[7],
                "market_question": r[8] or r[1][:20],
                "entry_value": round(entry, 2),
                "unrealised_pnl": 0.0,
            })
        return out
    finally:
        conn.close()


def get_recent_trades(limit: int = 50) -> list[dict]:
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT id, market_id, side, price, size, pnl, pnl_pct, close_reason, opened_at, closed_at, market_question FROM trades WHERE status='closed' ORDER BY closed_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        out = []
        for r in rows:
            out.append({
                "id": r[0],
                "market_id": r[1],
                "side": r[2],
                "entry_price": r[3],
                "size": r[4],
                "pnl": r[5],
                "pnl_pct": r[6],
                "reason": r[7],
                "opened_at": r[8],
                "closed_at": r[9],
                "market_question": r[10] or r[1][:20],
            })
        return out
    finally:
        conn.close()


def get_capital_history(hours: int = 24) -> list[dict]:
    conn = _conn()
    try:
        since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        rows = conn.execute(
            "SELECT opened_at, price*size AS val, side FROM trades WHERE status='open' AND opened_at > ? ORDER BY opened_at",
            (since,),
        ).fetchall()
        # Build cumulative capital series (start 100, subtract each open, add each close)
        # For simplicity return open exposure over time
        return [{"ts": r[0], "exposure": r[1]} for r in rows]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="PM Scalper Dashboard")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
templates = Jinja2Templates(directory=ROOT / "templates")


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/summary")
def api_summary():
    return get_summary()


@app.get("/api/open")
def api_open():
    return get_open_positions()


@app.get("/api/trades")
def api_trades(limit: int = 50):
    return get_recent_trades(limit)


@app.get("/api/history")
def api_history(hours: int = 24):
    return get_capital_history(hours)


# ---------------------------------------------------------------------------
# SSE stream — pushes fresh summary every 10 seconds
# ---------------------------------------------------------------------------

async def _event_stream():
    while True:
        data = json.dumps(get_summary())
        yield f"data: {data}\n\n"
        await asyncio.sleep(10)


@app.get("/stream")
def stream():
    return StreamingResponse(_event_stream(), media_type="text/event-stream")

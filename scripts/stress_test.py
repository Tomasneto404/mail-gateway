#!/usr/bin/env python3
# Authored by Tomás Neto (TN 2026)
"""
Stress test for mail-gateway's public API (POST /v1/send, GET /v1/me).

Standard library only (Python 3.9+): copy it anywhere and run it.

    MG_API_KEY=mk_sbx_... python3 scripts/stress_test.py --url http://localhost:3000 --requests 2000 --concurrency 32

Scenarios (--scenario):
  send      every request is a valid, unique message (default)
  mixed     70% valid, 10% duplicates (expect 409 DUPLICATE_MESSAGE), 10% recipients outside the
            allow-list (403), 5% CR/LF in the subject (400), 5% Idempotency-Key replays (202 + replay header)
  rejected  every request is refused by the policy (recipient not allowed). Exercises the whole
            pipeline (auth, validation, audit rows, metrics) and never queues or delivers anything
  read      GET /v1/me only (auth + policy lookup + quota counters)

Safety:
  * The key's mode is read first (GET /v1/me). A **live** key delivers real email, so sending
    scenarios refuse to run on one unless --allow-live is given.
  * sandbox keys deliver to Mailpit only; approval keys hold every message in the Approvals inbox.
  * Use a dedicated key with large quotas, otherwise QUOTA_EXCEEDED (429) caps the test:
        docker compose exec api node dist/cli.js keys:create --name stress --from stress@example.com \\
            --allow @example.com --quota-hour 1000000 --quota-day 10000000
    The gateway-wide GLOBAL_ACCEPT_PER_HOUR (default 5000) also applies to accepted messages, and
    GLOBAL_RATE_MAX paces delivery (not acceptance).

Throttling answers (429 QUOTA_EXCEEDED / GLOBAL_RATE_LIMITED, 503 GATEWAY_PAUSED) are reported as
"throttled", not as failures. The exit code is 1 when any response was unexpected (5xx, network
errors, a guardrail that did not trigger), so the script also works as a CI smoke test.
"""
from __future__ import annotations

import argparse
import http.client
import json
import os
import random
import signal
import ssl
import sys
import threading
import time
import uuid
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlsplit

THROTTLE_CODES = {"QUOTA_EXCEEDED", "GLOBAL_RATE_LIMITED", "GATEWAY_PAUSED", "DOMAIN_RATE_LIMITED", "AUTH_RATE_LIMITED"}
FINAL_STATUSES = {"sent", "captured", "failed", "rejected", "pending_approval"}

# What each request kind should get back: HTTP status and, for refusals, the error code.
EXPECT = {
    "valid": (202, None),
    "duplicate": (409, "DUPLICATE_MESSAGE"),
    "bad_recipient": (403, "RECIPIENT_NOT_ALLOWED"),
    "bad_subject": (400, "VALIDATION_FAILED"),
    "replay": (202, None),
    "me": (200, None),
}
MIX = [("valid", 70), ("duplicate", 10), ("bad_recipient", 10), ("bad_subject", 5), ("replay", 5)]


# --------------------------------------------------------------------------- HTTP
class Client:
    """One keep-alive connection per worker thread."""

    def __init__(self, base: str, key: str, timeout: float, insecure: bool):
        u = urlsplit(base)
        if u.scheme not in ("http", "https"):
            sys.exit(f"--url must start with http:// or https:// (got {base!r})")
        self.https = u.scheme == "https"
        self.host = u.hostname or "localhost"
        self.port = u.port or (443 if self.https else 80)
        self.prefix = u.path.rstrip("/")
        self.key = key
        self.timeout = timeout
        self.ctx = ssl._create_unverified_context() if (self.https and insecure) else None
        self.conn: Optional[http.client.HTTPConnection] = None

    def _connect(self):
        if self.https:
            self.conn = http.client.HTTPSConnection(self.host, self.port, timeout=self.timeout, context=self.ctx)
        else:
            self.conn = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)

    def request(self, method: str, path: str, body: Optional[dict] = None, headers: Optional[dict] = None):
        h = {"Authorization": f"Bearer {self.key}", "Accept": "application/json", "User-Agent": "mail-gateway-stress/1"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        for attempt in (1, 2):  # one silent reconnect when the server closed an idle keep-alive socket
            if self.conn is None:
                self._connect()
            try:
                self.conn.request(method, self.prefix + path, body=data, headers=h)
                r = self.conn.getresponse()
                raw = r.read()
                try:
                    parsed = json.loads(raw) if raw else None
                except ValueError:
                    parsed = None
                return r.status, parsed, {k.lower(): v for k, v in r.getheaders()}
            except (http.client.RemoteDisconnected, BrokenPipeError, ConnectionResetError) as e:
                self.close()
                if attempt == 2:
                    raise e
            except Exception:
                self.close()
                raise

    def close(self):
        if self.conn is not None:
            try:
                self.conn.close()
            finally:
                self.conn = None


# --------------------------------------------------------------------------- results
@dataclass
class Result:
    kind: str
    started: float  # seconds since the test began
    latency_ms: float
    status: int  # 0 = network error
    code: Optional[str] = None
    message_id: Optional[str] = None
    msg_status: Optional[str] = None
    replayed: bool = False
    error: Optional[str] = None

    @property
    def outcome(self) -> str:
        if self.status == 0:
            return "network_error"
        if self.code in THROTTLE_CODES:
            return "throttled"
        want_status, want_code = EXPECT[self.kind]
        if self.status == want_status and (want_code is None or self.code == want_code):
            if self.kind == "replay" and not self.replayed:
                return "unexpected"
            return "ok"
        return "unexpected"


@dataclass
class Shared:
    lock: threading.Lock = field(default_factory=threading.Lock)
    seq: int = 0
    accepted: list = field(default_factory=list)  # (payload, idempotency key, message id) of accepted sends
    results: list = field(default_factory=list)
    stop: threading.Event = field(default_factory=threading.Event)


def pct(values, p):
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, max(0, int(round(p / 100 * len(s) + 0.5)) - 1))]


def fmt_ms(v):
    if v is None:
        return "—"
    return f"{v:.0f} ms" if v >= 10 else f"{v:.1f} ms"


# --------------------------------------------------------------------------- payloads
class Payloads:
    def __init__(self, me: dict, args, run_id: str):
        self.args = args
        self.run_id = run_id
        self.recipient = args.to or pick_recipient(me.get("allowedRecipients") or [])
        filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. "
        self.body = (filler * (args.body_bytes // len(filler) + 1))[: args.body_bytes]

    def valid(self, n: int) -> dict:
        return {
            "to": self.recipient.replace("{n}", str(n)),
            "subject": f"Stress {self.run_id} #{n}",
            "text": f"Message {n} of stress run {self.run_id}.\n\n{self.body}",
            "metadata": {"stress_run": self.run_id, "n": n},
        }


def pick_recipient(allowed: list) -> str:
    for a in allowed:
        if not a.startswith("@"):
            return a
    for a in allowed:
        if a.startswith("@"):
            return "stress+{n}" + a
    sys.exit("The key allows no recipients; pass --to with an address its policy allows.")


# --------------------------------------------------------------------------- worker
def next_kind(scenario: str, rng: random.Random) -> str:
    if scenario == "send":
        return "valid"
    if scenario == "rejected":
        return "bad_recipient"
    if scenario == "read":
        return "me"
    x = rng.uniform(0, 100)
    for kind, w in MIX:
        x -= w
        if x <= 0:
            return kind
    return "valid"


def worker(wid: int, args, shared: Shared, payloads: Payloads, t0: float):
    client = Client(args.url, args.key, args.timeout, args.insecure)
    rng = random.Random(wid * 7919 + int(t0))
    try:
        while not shared.stop.is_set():
            with shared.lock:
                if args.requests and shared.seq >= args.requests:
                    return
                shared.seq += 1
                n = shared.seq
            if args.duration and time.monotonic() - t0 >= args.duration:
                return
            if args.rate:  # open-loop pacing: request n starts at t0 + n / rate
                wait = t0 + (n - 1) / args.rate - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
            kind = next_kind(args.scenario, rng)
            method, path, body, headers = "POST", "/v1/send", None, {}
            if kind == "me":
                method, path = "GET", "/v1/me"
            elif kind in ("duplicate", "replay"):
                with shared.lock:
                    prev = rng.choice(shared.accepted) if shared.accepted else None
                if prev is None:
                    kind = "valid"
                elif kind == "duplicate":
                    body = prev[0]  # same content, new (or no) idempotency key → dedup
                else:
                    body, headers = prev[0], {"Idempotency-Key": prev[1]}
            if kind == "valid":
                body = payloads.valid(n)
                headers = {"Idempotency-Key": f"stress-{payloads.run_id}-{n}"}
            elif kind == "bad_recipient":
                body = dict(payloads.valid(n), to=f"stress-{n}@not-allowed.invalid")
            elif kind == "bad_subject":
                body = dict(payloads.valid(n), subject=f"Stress {n}\r\nBcc: someone@not-allowed.invalid")

            start = time.monotonic()
            try:
                status, data, hdrs = client.request(method, path, body, headers)
                lat = (time.monotonic() - start) * 1000
                err = (data or {}).get("error") if isinstance(data, dict) else None
                res = Result(
                    kind=kind,
                    started=start - t0,
                    latency_ms=lat,
                    status=status,
                    code=err.get("code") if isinstance(err, dict) else None,
                    message_id=(data or {}).get("id") if isinstance(data, dict) and status == 202 else None,
                    msg_status=(data or {}).get("status") if isinstance(data, dict) and status == 202 else None,
                    replayed=hdrs.get("idempotent-replayed") == "true",
                )
                if kind == "valid" and status == 202:
                    with shared.lock:
                        if len(shared.accepted) < 500:
                            shared.accepted.append((body, headers["Idempotency-Key"], res.message_id))
            except Exception as e:  # timeouts, refused connections, TLS errors
                res = Result(kind=kind, started=start - t0, latency_ms=(time.monotonic() - start) * 1000, status=0, error=f"{type(e).__name__}: {e}")
            shared.results.append(res)
    finally:
        client.close()


# --------------------------------------------------------------------------- reporting
BARS = " ▁▂▃▄▅▆▇█"


def sparkline(values):
    top = max(values) if values else 0
    if top == 0:
        return BARS[0] * len(values)
    return "".join(BARS[min(8, round(v / top * 8))] for v in values)


def poll_delivery(args, ids):
    """End-to-end: how long accepted messages took to reach a final status."""
    client = Client(args.url, args.key, args.timeout, args.insecure)
    pending = set(ids)
    final = {}
    deadline = time.monotonic() + args.poll_timeout
    while pending and time.monotonic() < deadline:
        for mid in list(pending):
            try:
                status, data, _ = client.request("GET", f"/v1/messages/{mid}")
            except Exception:
                continue
            if status == 200 and isinstance(data, dict) and data.get("status") in FINAL_STATUSES:
                final[mid] = data
                pending.discard(mid)
        if pending:
            time.sleep(1)
    client.close()
    return final, pending


def iso_ms(s):
    from datetime import datetime

    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000


def report(args, me, results, elapsed, poll=None):
    n = len(results)
    outcomes = Counter(r.outcome for r in results)
    lat_all = [r.latency_ms for r in results if r.status]
    print()
    print(f"mail-gateway stress test · {args.scenario} · key {me.get('name')} ({me.get('mode')}) · {args.url}")
    print("-" * 78)
    print(f"Requests      {n}   in {elapsed:.1f} s   →  {n / elapsed if elapsed else 0:.1f} req/s   ({args.concurrency} workers{f', target {args.rate}/s' if args.rate else ''})")
    print(
        "Outcomes      "
        + "   ".join(f"{k} {outcomes[k]}" for k in ("ok", "throttled", "unexpected", "network_error") if outcomes[k] or k == "ok")
    )
    print()
    print(f"{'Latency':<15}{'n':>7}{'p50':>10}{'p90':>10}{'p95':>10}{'p99':>10}{'max':>10}")
    rows = [("all", lat_all)] + [
        (k, [r.latency_ms for r in results if r.kind == k and r.status]) for k in EXPECT if any(r.kind == k for r in results)
    ]
    for name, xs in rows:
        print(f"{name:<15}{len(xs):>7}" + "".join(f"{fmt_ms(pct(xs, p)):>10}" for p in (50, 90, 95, 99)) + f"{fmt_ms(max(xs) if xs else None):>10}")

    print()
    print("Responses")
    by = Counter((r.kind, r.status, r.code or "", r.outcome) for r in results)
    for (kind, status, code, outcome), c in sorted(by.items(), key=lambda x: (-x[1], x[0])):
        mark = {"ok": " ", "throttled": "~", "unexpected": "!", "network_error": "!"}[outcome]
        print(f"  {mark} {kind:<14} {status or 'ERR':>4} {code:<24} {c:>7}")
    accepted = Counter(r.msg_status for r in results if r.msg_status)
    if accepted:
        print("  accepted as   " + ", ".join(f"{s} {c}" for s, c in accepted.most_common()))

    errors = Counter(r.error for r in results if r.error)
    if errors:
        print()
        print("Network errors")
        for e, c in errors.most_common(5):
            print(f"  {c:>6}  {e[:100]}")

    secs = int(elapsed) + 1
    per_sec = [0] * secs
    bad_sec = [0] * secs
    for r in results:
        i = min(secs - 1, int(r.started))
        per_sec[i] += 1
        if r.outcome in ("unexpected", "network_error", "throttled"):
            bad_sec[i] += 1
    if secs > 1:
        width = 72
        step = max(1, -(-secs // width))
        agg = [sum(per_sec[i : i + step]) / step for i in range(0, secs, step)]
        aggb = [sum(bad_sec[i : i + step]) / step for i in range(0, secs, step)]
        print()
        print(f"Throughput per second (each mark = {step} s, peak {max(agg):.0f}/s)")
        print("  " + sparkline(agg))
        if any(aggb):
            print("  " + sparkline(aggb) + "   throttled / unexpected")

    if poll is not None:
        final, pending = poll
        print()
        print(f"Delivery of {len(final) + len(pending)} sampled accepted messages")
        print("  final status  " + ", ".join(f"{s} {c}" for s, c in Counter(d["status"] for d in final.values()).most_common()) + (f", still in flight {len(pending)}" if pending else ""))
        e2e = [iso_ms(d["sentAt"]) - iso_ms(d["createdAt"]) for d in final.values() if d.get("sentAt")]
        if e2e:
            print(f"  accepted → delivered  p50 {fmt_ms(pct(e2e, 50))}   p95 {fmt_ms(pct(e2e, 95))}   max {fmt_ms(max(e2e))}")

    print()
    if outcomes["unexpected"] or outcomes["network_error"]:
        print("Result        FAIL: unexpected responses (marked !)")
    else:
        print("Result        PASS" + (" (with throttling, marked ~)" if outcomes["throttled"] else ""))
    return outcomes


# --------------------------------------------------------------------------- main
def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n", 2)[2])
    p.add_argument("--url", default=os.environ.get("MG_URL", "http://localhost:3000"), help="gateway base URL (env MG_URL)")
    p.add_argument("--key", default=os.environ.get("MG_API_KEY"), help="API key (env MG_API_KEY; prefer the env var: arguments show up in ps)")
    p.add_argument("--scenario", choices=["send", "mixed", "rejected", "read"], default="send")
    p.add_argument("-n", "--requests", type=int, default=0, help="total requests (default 1000 unless --duration is set)")
    p.add_argument("-d", "--duration", type=float, default=0, help="run for this many seconds instead")
    p.add_argument("-c", "--concurrency", type=int, default=16, help="parallel connections (default 16)")
    p.add_argument("-r", "--rate", type=float, default=0, help="target requests per second (default: as fast as possible)")
    p.add_argument("--to", help="recipient for valid messages ({n} = sequence number); default: derived from the key's allow-list")
    p.add_argument("--body-bytes", type=int, default=600, help="size of the text body (default 600)")
    p.add_argument("--poll", type=int, default=0, help="afterwards, follow this many accepted messages to their final status")
    p.add_argument("--poll-timeout", type=float, default=120, help="seconds to wait for --poll (default 120)")
    p.add_argument("--timeout", type=float, default=30, help="per-request timeout in seconds (default 30)")
    p.add_argument("--insecure", action="store_true", help="skip TLS certificate checks (self-signed test gateways)")
    p.add_argument("--allow-live", action="store_true", help="allow sending scenarios on a LIVE key (real email is delivered)")
    p.add_argument("--json", metavar="FILE", help="also write every result and the summary as JSON")
    p.add_argument("-y", "--yes", action="store_true", help="do not ask for confirmation")
    args = p.parse_args()

    if not args.key:
        p.error("an API key is required: set MG_API_KEY or pass --key")
    if not args.requests and not args.duration:
        args.requests = 1000
    if args.concurrency < 1:
        p.error("--concurrency must be at least 1")

    # Pre-flight: who is this key, and is it safe to send with it?
    probe = Client(args.url, args.key, args.timeout, args.insecure)
    try:
        status, me, _ = probe.request("GET", "/v1/me")
    except Exception as e:
        sys.exit(f"Cannot reach {args.url}: {e}")
    finally:
        probe.close()
    if status != 200 or not isinstance(me, dict):
        code = (me or {}).get("error", {}).get("code") if isinstance(me, dict) else None
        sys.exit(f"GET /v1/me answered {status} {code or ''}: check the URL and the key.")

    sends = args.scenario in ("send", "mixed")
    mode = me.get("mode")
    print(f"Key {me.get('name')!r} · mode {mode} · from {me.get('fromAddress')} · allowed {', '.join(me.get('allowedRecipients') or []) or 'nothing'}")
    if sends and mode == "live" and not args.allow_live:
        sys.exit(
            "This key is LIVE: every accepted message is delivered as real email.\n"
            "Use a sandbox key (Mailpit) or an approval key (held for approval), or pass --allow-live if you really mean it."
        )
    if not me.get("enabled", True):
        print("Warning: the key is disabled; every send will be refused with KEY_DISABLED.")
    usage = me.get("usage") or {}
    expected_valid = (args.requests or 0) * (1.0 if args.scenario == "send" else 0.7 if args.scenario == "mixed" else 0)
    for window in ("hour", "day"):
        w = usage.get(window) or {}
        if sends and args.requests and w.get("remaining") is not None and expected_valid > w["remaining"]:
            print(f"Note: about {expected_valid:.0f} messages would be accepted but only {w['remaining']} remain in this {window}'s quota; the rest get 429 QUOTA_EXCEEDED.")
    where = {"sandbox": "captured by Mailpit", "approval": "held in the Approvals inbox", "live": "DELIVERED for real"}.get(mode, mode)
    plan = f"{args.requests} requests" if args.requests else f"{args.duration:.0f} s"
    print(f"Plan: {args.scenario}, {plan}, {args.concurrency} workers" + (f", {args.rate}/s" if args.rate else "") + (f"; accepted messages are {where}" if sends else "; nothing is queued"))
    if not args.yes and sys.stdin.isatty():
        if input("Start? [y/N] ").strip().lower() not in ("y", "yes"):
            sys.exit("Cancelled.")

    run_id = uuid.uuid4().hex[:8]
    shared = Shared()
    payloads = Payloads(me, args, run_id)
    signal.signal(signal.SIGINT, lambda *_: (shared.stop.set(), print("\nStopping, finishing requests in flight…")))
    t0 = time.monotonic()
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = [pool.submit(worker, i, args, shared, payloads, t0) for i in range(args.concurrency)]
        while not all(f.done() for f in futures):
            time.sleep(0.5)
            done = len(shared.results)
            total = args.requests or "…"
            print(f"\r  {done}/{total} done, {time.monotonic() - t0:5.1f} s", end="", flush=True)
        for f in futures:
            f.result()
    elapsed = time.monotonic() - t0
    print()

    poll = None
    if args.poll and sends:
        ids = [r.message_id for r in shared.results if r.kind == "valid" and r.message_id]
        sample = random.sample(ids, min(args.poll, len(ids)))
        if sample:
            print(f"Following {len(sample)} accepted messages (up to {args.poll_timeout:.0f} s)…")
            poll = poll_delivery(args, sample)

    outcomes = report(args, me, shared.results, elapsed, poll)
    if args.json:
        with open(args.json, "w") as fh:
            json.dump(
                {
                    "run": run_id,
                    "url": args.url,
                    "key": me.get("name"),
                    "mode": mode,
                    "scenario": args.scenario,
                    "elapsed_s": elapsed,
                    "outcomes": dict(outcomes),
                    "results": [r.__dict__ | {"outcome": r.outcome} for r in shared.results],
                },
                fh,
                indent=1,
            )
        print(f"Results written to {args.json}")
    sys.exit(1 if outcomes["unexpected"] or outcomes["network_error"] else 0)


if __name__ == "__main__":
    main()

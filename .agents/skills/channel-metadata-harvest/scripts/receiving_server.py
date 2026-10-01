#!/usr/bin/env python3
"""本地接收端点：把浏览器页面内采集到的频道数据落盘。

浏览器在 https 页面里 fetch 本机 http 端口，把 JSON 原样写入，避免经由
对话上下文搬运大体积文本。localhost/127.0.0.1 属于可信来源，不受混合内容拦截。

用法：
  python receiving_server.py --out "输出文件.json"
  页面内：
    await fetch("http://127.0.0.1:8791/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Harvest-Token": "令牌" },
      body: JSON.stringify(payload),
    });

写入成功返回 204 并自动退出；令牌不符返回 403，服务继续等待。
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_BODY_BYTES = 64 * 1024 * 1024


class Receiver(BaseHTTPRequestHandler):
    expected_token = ""
    out_path: Path = Path("harvest.json")

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write("[receiver] " + (fmt % args) + "\n")

    def _headers(self) -> None:
        # 页面来自 https://www.youtube.com，写本机端口需要放开私有网络预检。
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Harvest-Token")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def _respond(self, status: int, payload: dict | None = None) -> None:
        body = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self._respond(204)

    def do_POST(self) -> None:
        if self.headers.get("X-Harvest-Token") != self.expected_token:
            self._respond(403, {"error": "令牌不匹配，已拒绝写入。"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            self._respond(413, {"error": f"请求体长度不合法：{length}"})
            return
        raw = self.rfile.read(length)
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._respond(400, {"error": f"请求体不是合法 JSON：{exc}"})
            return
        if not isinstance(parsed, dict):
            self._respond(400, {"error": "顶层必须是 JSON 对象。"})
            return
        self.out_path.parent.mkdir(parents=True, exist_ok=True)
        self.out_path.write_text(
            json.dumps(parsed, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        videos = parsed.get("videos")
        count = len(videos) if isinstance(videos, list) else "?"
        print(f"[receiver] 已写入 {self.out_path}（视频 {count} 条）", file=sys.stderr)
        self._respond(204)
        # 一次任务只需接收一次，写完后退出。
        self.server.shutdown_requested = True  # type: ignore[attr-defined]


def main() -> int:
    parser = argparse.ArgumentParser(description="接收浏览器采集结果并落盘")
    parser.add_argument("--out", required=True, help="落盘文件路径")
    parser.add_argument("--port", type=int, default=8791, help="监听端口，默认 8791")
    parser.add_argument("--token", default=secrets.token_hex(8), help="校验令牌")
    args = parser.parse_args()

    Receiver.out_path = Path(args.out).resolve()
    Receiver.expected_token = args.token

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Receiver)
    server.timeout = 1
    print(f"[receiver] 监听 127.0.0.1:{args.port}", file=sys.stderr)
    print(f"[receiver] token={args.token}", file=sys.stderr)
    print(f"[receiver] out={Receiver.out_path}", file=sys.stderr)
    sys.stderr.flush()

    while not getattr(server, "shutdown_requested", False):
        server.handle_request()
    server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

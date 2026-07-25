"""Send a generic Discord DM using the existing MusicMaker bot configuration."""

import argparse
import ast
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BOT_SOURCE = r"H:\Github Repositories\MusicMaker\discordmsg.py"
DISCORD_API_BASE = "https://discord.com/api/v10"


def load_bot_config() -> tuple[str, list[int]]:
    token = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    target_ids: list[int] = []
    source_path = os.environ.get("DISCORD_BOT_SOURCE", DEFAULT_BOT_SOURCE)

    if os.path.exists(source_path):
        with open(source_path, "r", encoding="utf-8") as handle:
            module = ast.parse(handle.read(), filename=source_path)
        for node in module.body:
            if not isinstance(node, ast.Assign) or len(node.targets) != 1:
                continue
            target = node.targets[0]
            if not isinstance(target, ast.Name):
                continue
            if target.id == "TOKEN" and not token:
                value = ast.literal_eval(node.value)
                if isinstance(value, str):
                    token = value.strip()
            elif target.id == "TARGET_IDS":
                value = ast.literal_eval(node.value)
                if isinstance(value, list):
                    target_ids = [int(item) for item in value]

    if not token:
        raise RuntimeError("Discord bot token is missing.")
    if not target_ids:
        raise RuntimeError("Discord target user IDs are missing.")
    return token, target_ids


def discord_request(token: str, endpoint: str, payload: dict) -> dict:
    request = urllib.request.Request(
        DISCORD_API_BASE + endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bot {token}",
            "Content-Type": "application/json",
            "User-Agent": "AIVideoMaker/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Discord HTTP {exc.code}: {detail}") from exc


def send_notifications(token: str, target_ids: list[int], message: str) -> None:
    for target_id in target_ids:
        channel = discord_request(token, "/users/@me/channels", {"recipient_id": str(target_id)})
        channel_id = channel.get("id")
        if not channel_id:
            raise RuntimeError(f"Discord did not return a DM channel for user {target_id}.")
        discord_request(token, f"/channels/{channel_id}/messages", {"content": message})
        print(f"Message sent to Discord user {target_id}.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Send AIVideoMaker Discord DMs.")
    parser.add_argument("--message", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        token, target_ids = load_bot_config()
        send_notifications(token, target_ids, args.message)
        return 0
    except Exception as exc:
        print(f"Discord notification failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

"""Validate, select, and upload a rotating PDFomni video as a public Short."""

from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Iterator

import googleapiclient.errors


PROJECT_ROOT = Path(__file__).resolve().parent.parent
PDFOMNI_DIR = PROJECT_ROOT / "pdfomni"
LAST_SEVEN_PATH = PDFOMNI_DIR / "last_7_uploads.json"
LAST_TWO_PATH = PDFOMNI_DIR / "last_2_uploads.json"
LOCK_PATH = PDFOMNI_DIR / "upload.lock"
LAST_UPLOAD_STATE_PATH = PROJECT_ROOT / "last_youtube_upload.json"
VIDEO_NUMBERS = tuple(range(1, 8))

EXIT_SUCCESS = 0
EXIT_VALIDATION_FAILURE = 2
EXIT_UPLOAD_FAILURE = 20
EXIT_DISCORD_FAILURE = 21
EXIT_AUTH_FAILURE = 23

sys.path.insert(0, str(PROJECT_ROOT))
import upload as youtube_upload  # noqa: E402


def log(message: str) -> None:
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {message}", flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Upload one eligible PDFomni video as public."
    )
    parser.add_argument(
        "video_number",
        nargs="?",
        type=int,
        choices=VIDEO_NUMBERS,
        help="Specific eligible video number to upload; omit for random rotation.",
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Validate all seven MP4/JSON pairs without selecting or uploading.",
    )
    return parser.parse_args()


def load_metadata(video_number: int) -> dict:
    video_path = PDFOMNI_DIR / f"{video_number}.mp4"
    metadata_path = PDFOMNI_DIR / f"{video_number}.json"

    if not video_path.is_file() or video_path.stat().st_size == 0:
        raise ValueError(f"Missing or empty video: {video_path}")
    if not metadata_path.is_file():
        raise ValueError(f"Missing metadata: {metadata_path}")

    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Invalid metadata JSON {metadata_path}: {exc}") from exc

    for field in ("title", "description", "tags"):
        value = metadata.get(field)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{metadata_path} requires a non-empty string field: {field}")
        metadata[field] = value.strip()

    if "[Insert Link Here]" in metadata["description"]:
        raise ValueError(f"{metadata_path} still contains the PDFomni link placeholder.")
    if "https://pdfomni.com" not in metadata["description"]:
        raise ValueError(f"{metadata_path} description must contain https://pdfomni.com.")

    title = youtube_upload.ensure_shorts_tag(metadata["title"])
    description = youtube_upload.ensure_shorts_tag(metadata["description"])
    if len(title) > 100:
        raise ValueError(f"{metadata_path} title exceeds YouTube's 100-character limit.")
    if len(description) > 5000:
        raise ValueError(f"{metadata_path} description exceeds YouTube's 5,000-character limit.")

    tags = parse_tags(metadata["tags"])
    if not tags:
        raise ValueError(f"{metadata_path} does not contain any usable tags.")

    metadata["videoNumber"] = video_number
    metadata["videoPath"] = str(video_path)
    metadata["metadataPath"] = str(metadata_path)
    metadata["title"] = title
    metadata["description"] = description
    metadata["tags"] = tags
    return metadata


def parse_tags(raw_tags: str) -> list[str]:
    return [tag.strip() for tag in raw_tags.split(",") if tag.strip()]


def validate_assets() -> dict[int, dict]:
    metadata_by_number: dict[int, dict] = {}
    for video_number in VIDEO_NUMBERS:
        metadata = load_metadata(video_number)
        metadata_by_number[video_number] = metadata
        log(
            f"Validated pdfomni/{video_number}.mp4 and {video_number}.json "
            f"({len(metadata['tags'])} tags)."
        )
    return metadata_by_number


def load_history(path: Path, maximum_length: int) -> list[int]:
    if not path.exists():
        return []
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Invalid upload history {path}: {exc}") from exc

    if not isinstance(value, list):
        raise ValueError(f"Upload history must be a JSON list: {path}")
    if len(value) > maximum_length:
        raise ValueError(f"Upload history contains too many entries: {path}")
    if any(type(item) is not int or item not in VIDEO_NUMBERS for item in value):
        raise ValueError(f"Upload history contains an invalid video number: {path}")
    if len(set(value)) != len(value):
        raise ValueError(f"Upload history contains duplicate video numbers: {path}")
    return value


def get_eligible_videos(last_seven: list[int], last_two: list[int]) -> tuple[list[int], list[int]]:
    cycle = list(last_seven)
    if len(cycle) == len(VIDEO_NUMBERS):
        cycle = []
        eligible = [number for number in VIDEO_NUMBERS if number not in last_two]
        log(
            "All seven PDFomni videos completed a cycle. Starting a new cycle while "
            f"excluding the last two uploads: {last_two}."
        )
    else:
        eligible = [number for number in VIDEO_NUMBERS if number not in cycle]

    if last_two and last_two[-1] in eligible:
        eligible.remove(last_two[-1])
    if not eligible:
        raise ValueError("No PDFomni video is eligible under the current rotation history.")
    return cycle, eligible


def choose_video(
    requested_number: int | None,
    eligible: list[int],
) -> int:
    if requested_number is not None:
        if requested_number not in eligible:
            raise ValueError(
                f"Video {requested_number} is not currently eligible. "
                f"Eligible videos: {', '.join(map(str, eligible))}"
            )
        return requested_number
    return random.SystemRandom().choice(eligible)


def write_json_atomic(path: Path, value: object) -> None:
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    temporary_path.write_text(
        json.dumps(value, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary_path, path)


def save_upload_state(metadata: dict, video_id: str) -> None:
    record = {
        "videoId": video_id,
        "title": metadata["title"],
        "finalVideoPath": metadata["videoPath"],
        "topicId": "pdfomni",
        "topicLabel": "PDFomni",
        "tagsFile": metadata["metadataPath"],
        "privacyStatus": "public",
        "uploadedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "projectRoot": str(PROJECT_ROOT),
    }
    write_json_atomic(LAST_UPLOAD_STATE_PATH, record)
    log(f"Saved last upload metadata: {LAST_UPLOAD_STATE_PATH}")


def send_discord_notification(metadata: dict, video_id: str) -> None:
    message = (
        "V-GEN Main PDFomni Upload Complete!\n"
        f"Title: {metadata['title']}\n"
        f"Source: pdfomni/{metadata['videoNumber']}.mp4\n"
        f"https://youtube.com/shorts/{video_id}"
    )
    result = subprocess.run(
        [
            sys.executable,
            str(PROJECT_ROOT / "scripts" / "notify_discord.py"),
            "--message",
            message,
        ],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "Unknown Discord error").strip()
        raise RuntimeError(detail)
    log("Discord notification sent.")


@contextmanager
def upload_lock() -> Iterator[None]:
    PDFOMNI_DIR.mkdir(parents=True, exist_ok=True)
    lock_handle = LOCK_PATH.open("a+b")
    if lock_handle.tell() == 0:
        lock_handle.write(b"0")
        lock_handle.flush()
    lock_handle.seek(0)

    try:
        if os.name == "nt":
            import msvcrt

            try:
                msvcrt.locking(lock_handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise RuntimeError("Another PDFomni upload is already running.") from exc
        else:
            import fcntl

            try:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise RuntimeError("Another PDFomni upload is already running.") from exc

        yield
    finally:
        try:
            lock_handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(lock_handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        lock_handle.close()


def run_upload(requested_number: int | None) -> int:
    try:
        metadata_by_number = validate_assets()
        last_seven = load_history(LAST_SEVEN_PATH, len(VIDEO_NUMBERS))
        last_two = load_history(LAST_TWO_PATH, 2)
        cycle, eligible = get_eligible_videos(last_seven, last_two)
        selected_number = choose_video(requested_number, eligible)
        metadata = metadata_by_number[selected_number]
        log(
            f"Selected pdfomni/{selected_number}.mp4 from eligible videos: "
            f"{', '.join(map(str, eligible))}."
        )
    except (OSError, ValueError) as exc:
        log(f"PDFomni validation failed: {exc}")
        return EXIT_VALIDATION_FAILURE

    try:
        youtube = youtube_upload.get_authenticated_service(
            allow_interactive=False,
            force_reauth=False,
        )
    except Exception as exc:
        log(f"YouTube auth check failed: {exc}")
        return EXIT_AUTH_FAILURE

    try:
        log(f"Uploading PDFomni video {selected_number} as public: {metadata['title']}")
        video_id = youtube_upload.upload_video(
            youtube,
            metadata["videoPath"],
            metadata["title"],
            metadata["description"],
            metadata["tags"],
            "public",
        )
    except googleapiclient.errors.HttpError as exc:
        log(f"YouTube upload failed with HTTP {exc.resp.status}: {exc.content}")
        return EXIT_UPLOAD_FAILURE
    except Exception as exc:
        log(f"YouTube upload failed: {exc}")
        return EXIT_UPLOAD_FAILURE

    updated_cycle = cycle + [selected_number]
    updated_recent = (last_two + [selected_number])[-2:]
    write_json_atomic(LAST_SEVEN_PATH, updated_cycle)
    write_json_atomic(LAST_TWO_PATH, updated_recent)
    save_upload_state(metadata, video_id)
    log(f"Updated seven-video cycle: {updated_cycle}")
    log(f"Updated last-two uploads: {updated_recent}")

    try:
        send_discord_notification(metadata, video_id)
    except Exception as exc:
        log(f"Discord notification failed after successful upload: {exc}")
        return EXIT_DISCORD_FAILURE

    log(f"PDFomni public upload complete: https://youtube.com/shorts/{video_id}")
    return EXIT_SUCCESS


def main() -> int:
    args = parse_args()
    try:
        with upload_lock():
            if args.validate_only:
                validate_assets()
                log("All seven PDFomni assets are valid. No upload was attempted.")
                return EXIT_SUCCESS
            return run_upload(args.video_number)
    except RuntimeError as exc:
        log(str(exc))
        return EXIT_UPLOAD_FAILURE


if __name__ == "__main__":
    raise SystemExit(main())

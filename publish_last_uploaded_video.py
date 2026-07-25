"""
Publish the most recently uploaded YouTube video for this project.

Usage:
    python publish_last_uploaded_video.py
    python publish_last_uploaded_video.py --video-id VIDEO_ID
    python publish_last_uploaded_video.py --privacy public
"""

import argparse
import json
import os
import sys
from datetime import datetime

import googleapiclient.errors

from upload import (
    LAST_UPLOAD_STATE_PATH,
    get_authenticated_service,
    is_interactive_session,
    set_video_privacy,
)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Change the privacy of the last uploaded YouTube video for this project."
    )
    parser.add_argument(
        "--video-id",
        help="Optional explicit YouTube video ID. Defaults to the last uploaded video saved by automation.",
    )
    parser.add_argument(
        "--privacy",
        default="public",
        choices=["private", "public", "unlisted"],
        help="Target privacy status. Defaults to public.",
    )
    return parser.parse_args()


def load_last_upload_state():
    if not os.path.exists(LAST_UPLOAD_STATE_PATH):
        raise FileNotFoundError(
            f"No saved upload state found at {LAST_UPLOAD_STATE_PATH}. Run the automation/upload flow first."
        )

    with open(LAST_UPLOAD_STATE_PATH, "r", encoding="utf-8") as handle:
        return json.load(handle)


def save_last_upload_state(state: dict):
    with open(LAST_UPLOAD_STATE_PATH, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2, ensure_ascii=False)


def main():
    args = parse_args()
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

    state = {}
    if os.path.exists(LAST_UPLOAD_STATE_PATH):
        state = load_last_upload_state()

    video_id = args.video_id or state.get("videoId")
    if not video_id:
        print(
            "Error: No video ID was provided and no last upload record is available.",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        youtube = get_authenticated_service(
            allow_interactive=is_interactive_session(),
            force_reauth=False,
        )
        updated_status = set_video_privacy(youtube, video_id, args.privacy)

        state.update(
            {
                "videoId": video_id,
                "privacyStatus": updated_status.get("privacyStatus", args.privacy),
                "lastPrivacyUpdatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            }
        )
        save_last_upload_state(state)

        print(f"https://youtube.com/shorts/{video_id}")
    except googleapiclient.errors.HttpError as exc:
        print(f"HTTP error: {exc.resp.status} {exc.content}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

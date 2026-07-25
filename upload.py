"""
YouTube Video Upload Script (CLI)

Usage:
    python upload.py --file VIDEO_PATH --title TITLE --description DESC --tags-file TAGS_PATH [--privacy private|public|unlisted]
    python upload.py --check-auth
    python upload.py --reauth --check-auth

Authenticates via token.json and refreshes it when possible. If the stored token
is malformed or missing a refresh token, the script now fails with a clear
message in non-interactive runs and can regenerate the token interactively.
"""

import argparse
import os
import sys
import time
import webbrowser
import wsgiref.simple_server
from datetime import datetime
from urllib.parse import parse_qs

import google_auth_oauthlib.flow
import googleapiclient.discovery
import googleapiclient.errors
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.http import MediaFileUpload

SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.force-ssl",
]
OAUTH_CALLBACK_PORT = 8081

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TOKEN_PATH = os.path.join(SCRIPT_DIR, "token.json")
CLIENT_SECRETS_PATH = os.path.join(SCRIPT_DIR, "client_secrets.json")
LAST_UPLOAD_STATE_PATH = os.path.join(SCRIPT_DIR, "last_youtube_upload.json")
PDF_TOOLKIT_DESCRIPTION_APPENDIX = (
    "Built a free, private PDF toolkit: https://pdfomni.com \n\n"
    "Merge, split, compress, convert, edit, sign, protect, unlock, and chat with PDFs right in your browser. Files stay on your device."
)


def get_authenticated_service(*, allow_interactive: bool, force_reauth: bool):
    creds = None
    token_error = None

    if not force_reauth:
        creds, token_error = load_saved_credentials()

    if creds and not creds.has_scopes(SCOPES):
        token_error = ValueError("Stored token is missing required YouTube management scope.")
        creds = None

    if creds and not creds.refresh_token:
        token_error = ValueError("Stored token is missing refresh_token.")
        creds = None

    if creds and creds.expired:
        if creds.refresh_token:
            try:
                creds.refresh(Request())
            except Exception as exc:
                token_error = exc
                creds = None
        else:
            token_error = ValueError("Stored token is expired and missing refresh_token.")
            creds = None

    if not creds or not creds.valid:
        if not allow_interactive:
            raise RuntimeError(build_auth_error_message(token_error))
        creds = run_interactive_flow()

    if not creds.refresh_token:
        raise RuntimeError(
            "YouTube OAuth completed but no refresh_token was returned. Re-run `python upload.py --reauth --check-auth` and approve the consent screen."
        )

    with open(TOKEN_PATH, "w", encoding="utf-8") as token:
        token.write(creds.to_json())

    return googleapiclient.discovery.build("youtube", "v3", credentials=creds)


def load_saved_credentials():
    if not os.path.exists(TOKEN_PATH):
        return None, FileNotFoundError(f"Missing token file: {TOKEN_PATH}")

    try:
        creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
        return creds, None
    except Exception as exc:
        backup_invalid_token()
        return None, exc


def backup_invalid_token():
    if not os.path.exists(TOKEN_PATH):
        return

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = os.path.join(SCRIPT_DIR, f"token.invalid-{timestamp}.json")
    try:
        os.replace(TOKEN_PATH, backup_path)
        print(
            f"Warning: token.json was invalid and has been moved to {backup_path}",
            file=sys.stderr,
        )
    except OSError:
        pass


def run_interactive_flow():
    flow = google_auth_oauthlib.flow.InstalledAppFlow.from_client_secrets_file(
        CLIENT_SECRETS_PATH,
        SCOPES,
    )
    return run_state_aware_local_server(
        flow,
        port=OAUTH_CALLBACK_PORT,
        access_type="offline",
        prompt="consent",
        include_granted_scopes="true",
    )


def run_state_aware_local_server(flow, *, port: int, **authorization_kwargs):
    callback = {"uri": None}
    expected_state = {"value": None}

    def callback_app(environ, start_response):
        query = environ.get("QUERY_STRING", "")
        params = parse_qs(query)
        response_state = params.get("state", [None])[0]

        if response_state and response_state == expected_state["value"] and (
            "code" in params or "error" in params
        ):
            callback["uri"] = f"http://localhost:{port}/?{query}"
            body = b"Authentication complete. You can close this window."
            status = "200 OK"
        elif response_state:
            body = b"Ignored a stale authentication callback. Continue in the newest Google sign-in tab."
            status = "409 Conflict"
        else:
            body = b"Waiting for the current Google authentication callback."
            status = "200 OK"

        start_response(
            status,
            [("Content-Type", "text/plain; charset=utf-8"), ("Content-Length", str(len(body)))],
        )
        return [body]

    wsgiref.simple_server.WSGIServer.allow_reuse_address = False
    server = wsgiref.simple_server.make_server("localhost", port, callback_app)
    try:
        flow.redirect_uri = f"http://localhost:{server.server_port}/"
        auth_url, state = flow.authorization_url(**authorization_kwargs)
        expected_state["value"] = state
        webbrowser.open(auth_url, new=1, autoraise=True)
        print(f"Please visit this URL to authorize this application: {auth_url}")

        deadline = time.monotonic() + 300
        server.timeout = 1
        while callback["uri"] is None and time.monotonic() < deadline:
            server.handle_request()

        if callback["uri"] is None:
            raise TimeoutError("Timed out waiting for the Google OAuth callback.")

        authorization_response = callback["uri"].replace("http://", "https://", 1)
        flow.fetch_token(authorization_response=authorization_response)
        return flow.credentials
    finally:
        server.server_close()


def build_auth_error_message(error):
    detail = f" ({error})" if error else ""
    return (
        "YouTube OAuth is not ready for automation"
        f"{detail}. Run `python upload.py --reauth --check-auth` once in an interactive terminal to create a fresh token.json with a refresh token."
    )


def is_interactive_session() -> bool:
    return sys.stdin.isatty() and sys.stdout.isatty()


def ensure_shorts_tag(text: str) -> str:
    if "#shorts" not in text.lower():
        text = text.rstrip() + " #shorts"
    return text


def append_pdf_toolkit_description(text: str) -> str:
    if PDF_TOOLKIT_DESCRIPTION_APPENDIX in text:
        return text
    return text.rstrip() + "\n\n\n" + PDF_TOOLKIT_DESCRIPTION_APPENDIX


def load_tags(tags_file_path: str) -> list[str]:
    if not os.path.exists(tags_file_path):
        print(f"Warning: Tags file not found: {tags_file_path}", file=sys.stderr)
        return []
    with open(tags_file_path, "r", encoding="utf-8") as handle:
        raw = handle.read().strip()
    return [tag.strip() for tag in raw.split(",") if tag.strip()]


def upload_video(youtube, file_path, title, description, tags, privacy):
    body = {
        "snippet": {
            "title": title,
            "description": description,
            "tags": tags,
            "categoryId": "24",
        },
        "status": {
            "privacyStatus": privacy,
            "selfDeclaredMadeForKids": False,
        },
    }

    media = MediaFileUpload(file_path, chunksize=-1, resumable=True)
    request = youtube.videos().insert(part="snippet,status", body=body, media_body=media)

    print(f"Uploading: {file_path}", file=sys.stderr)
    response = None
    while response is None:
        status, response = request.next_chunk()
        if status:
            print(f"  {int(status.progress() * 100)}%", file=sys.stderr)

    video_id = response.get("id", "")
    print(f"Upload complete. Video ID: {video_id}", file=sys.stderr)
    print(video_id)
    return video_id


def get_video_status(youtube, video_id):
    response = youtube.videos().list(part="status", id=video_id).execute()
    items = response.get("items", [])
    if not items:
        raise RuntimeError(f"Could not find YouTube video with ID: {video_id}")
    return items[0].get("status", {})


def build_status_update(existing_status, privacy):
    updated_status = {
        "privacyStatus": privacy,
    }

    for key in (
        "embeddable",
        "license",
        "publicStatsViewable",
        "selfDeclaredMadeForKids",
        "containsSyntheticMedia",
    ):
        if key in existing_status:
            updated_status[key] = existing_status[key]

    if privacy == "private" and existing_status.get("publishAt"):
        updated_status["publishAt"] = existing_status["publishAt"]

    return updated_status


def set_video_privacy(youtube, video_id, privacy):
    existing_status = get_video_status(youtube, video_id)
    current_privacy = existing_status.get("privacyStatus")
    if current_privacy == privacy:
        print(
            f"Video {video_id} is already {privacy}.",
            file=sys.stderr,
        )
        return existing_status

    updated_status = build_status_update(existing_status, privacy)
    response = youtube.videos().update(
        part="status",
        body={
            "id": video_id,
            "status": updated_status,
        },
    ).execute()

    print(
        f"Updated video {video_id} privacy from {current_privacy or 'unknown'} to {privacy}.",
        file=sys.stderr,
    )
    return response.get("status", {})


def parse_args():
    parser = argparse.ArgumentParser(description="Upload a video to YouTube.")
    parser.add_argument("--file", help="Path to the video file.")
    parser.add_argument("--title", help="Video title.")
    parser.add_argument("--description", help="Video description.")
    parser.add_argument("--tags-file", help="Path to comma-separated tags file.")
    parser.add_argument(
        "--privacy",
        default="unlisted",
        choices=["private", "public", "unlisted"],
        help="Privacy status.",
    )
    parser.add_argument(
        "--check-auth",
        action="store_true",
        help="Validate OAuth/token readiness without uploading a video.",
    )
    parser.add_argument(
        "--reauth",
        action="store_true",
        help="Force a new interactive OAuth login and overwrite token.json.",
    )
    return parser.parse_args()


def validate_upload_args(args):
    required = ["file", "title", "description", "tags_file"]
    missing = [name for name in required if not getattr(args, name)]
    if missing:
        raise ValueError(f"Missing required arguments: {', '.join(missing)}")

    if not os.path.exists(args.file):
        raise FileNotFoundError(f"Video file not found: {args.file}")


def main():
    args = parse_args()

    if args.reauth and not is_interactive_session():
        print(
            "Error: `--reauth` requires an interactive terminal because it opens a browser-based OAuth flow.",
            file=sys.stderr,
        )
        sys.exit(1)

    if not args.check_auth:
        try:
            validate_upload_args(args)
        except Exception as exc:
            print(f"Error: {exc}", file=sys.stderr)
            sys.exit(1)

    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

    allow_interactive = args.reauth or is_interactive_session()

    try:
        youtube = get_authenticated_service(
            allow_interactive=allow_interactive,
            force_reauth=args.reauth,
        )

        if args.check_auth:
            print("YouTube auth ready.", file=sys.stderr)
            return

        title = ensure_shorts_tag(args.title)
        description = append_pdf_toolkit_description(ensure_shorts_tag(args.description))
        tags = load_tags(args.tags_file)
        upload_video(youtube, args.file, title, description, tags, args.privacy)
    except googleapiclient.errors.HttpError as exc:
        print(f"HTTP error: {exc.resp.status} {exc.content}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

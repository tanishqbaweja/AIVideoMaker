"""
V-GEN Automation Script

Runs the full pipeline end-to-end:
  1. Pick a random topic
  2. Start the Next.js dev server
  3. Submit a generation job via the API
  4. Poll until complete
  5. Upload to YouTube
  6. Publish the uploaded video when enabled
  7. Send Discord notification
  8. Stop the dev server

Designed to be called by Windows Task Scheduler twice daily.

Usage:
    python scripts/automate.py
    python scripts/automate.py --contingency-retry
"""

import argparse
import ctypes
import json
import os
import random
import re
import signal
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime
from urllib.parse import urlparse

# Force UTF-8 output on Windows to avoid cp1252 encoding crashes
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FINAL_VIDEO_DIR = os.path.join(PROJECT_ROOT, "Final_Video")
DEV_SERVER_LOG_PATH = os.path.join(PROJECT_ROOT, "dev-server.log")
DEV_SERVER_ERR_LOG_PATH = os.path.join(PROJECT_ROOT, "dev-server.err.log")
LAST_UPLOAD_STATE_PATH = os.path.join(PROJECT_ROOT, "last_youtube_upload.json")
os.chdir(PROJECT_ROOT)

API_BASE = "http://127.0.0.1:3001"
POLL_INTERVAL_SECONDS = 5
MAX_POLL_MINUTES = 15
DEV_SERVER_MAX_WAIT_SECONDS = 90
MAX_FINAL_VIDEOS = 10

EXIT_SUCCESS = 0
EXIT_PRE_VIDEO_FAILURE = 10
EXIT_UPLOAD_FAILURE = 20
EXIT_DISCORD_FAILURE = 21
EXIT_POST_VIDEO_FAILURE = 22
EXIT_AUTH_FAILURE = 23
EXIT_PUBLISH_FAILURE = 24
PRE_RENDER_ALERT_ENV = "VGEN_SHOW_PRE_RENDER_ALERT"
PUBLISH_AFTER_UPLOAD_ENV = "VGEN_RUN_PUBLISH_AFTER_UPLOAD"
DESKTOP_ALERTS_ENV = "VGEN_SHOW_DESKTOP_ALERTS"
PROJECT_LABEL = "India"

TOPICS = [
    "mind-bending-india-facts",
    "what-if-india-scenarios",
    "numbers-that-explain-india",
    "things-indians-think-are-normal",
    "common-myths-indians-believe",
    "how-india-works",
    "hidden-rules-of-indian-society",
    "india-vs-world-comparisons",
    "one-concept-explained",
    "counterintuitive-truths-about-india",
]

TOPIC_TO_TAGS_FILE = {
    "mind-bending-india-facts": "tags/mind_bending_india_facts.txt",
    "what-if-india-scenarios": "tags/what_if_scenarios.txt",
    "numbers-that-explain-india": "tags/numbers_that_explain_india.txt",
    "things-indians-think-are-normal": "tags/things_indians_think_are_normal.txt",
    "common-myths-indians-believe": "tags/common_myths_indians_believe.txt",
    "how-india-works": "tags/how_india_works.txt",
    "hidden-rules-of-indian-society": "tags/hidden_rules_of_indian_society.txt",
    "india-vs-world-comparisons": "tags/india_vs_world_comparisons.txt",
    "one-concept-explained": "tags/one_concept_explained.txt",
    "counterintuitive-truths-about-india": "tags/counterintuitive_truths_about_india.txt",
}

TOPIC_LABELS = {
    "mind-bending-india-facts": "Mind-Bending Indian Facts",
    "what-if-india-scenarios": "What If Scenarios (India Edition)",
    "numbers-that-explain-india": "Numbers That Explain India",
    "things-indians-think-are-normal": "Things Indians Think Are Normal",
    "common-myths-indians-believe": "Common Myths Indians Believe",
    "how-india-works": "How India Works (Explained Simply)",
    "hidden-rules-of-indian-society": "Hidden Rules of Indian Society",
    "india-vs-world-comparisons": "Fast-Paced Comparisons (India vs World)",
    "one-concept-explained": "One Concept Explained in 40 Seconds",
    "counterintuitive-truths-about-india": "Counterintuitive Truths About India",
}


class UploadFailure(RuntimeError):
    pass


class YouTubeAuthFailure(RuntimeError):
    pass


class DiscordFailure(RuntimeError):
    pass


class PublishFailure(RuntimeError):
    pass


class JobFailure(RuntimeError):
    def __init__(self, stage_label: str, detail: str):
        super().__init__(detail)
        self.stage_label = stage_label


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--contingency-retry",
        action="store_true",
        help="Marks this run as the one-shot contingency retry.",
    )
    parser.add_argument(
        "--publish-at",
        help="Upload as private and schedule publication at this ISO-8601 timestamp.",
    )
    parser.add_argument(
        "--slot-label",
        default="Generated video",
        help="Human-readable batch slot label used in logs and notifications.",
    )
    return parser.parse_args()


def log(msg: str):
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] {msg}"
    print(line, flush=True)


def is_server_running() -> bool:
    try:
        req = urllib.request.Request(f"{API_BASE}/", method="GET")
        resp = urllib.request.urlopen(req, timeout=5)
        resp.close()
        return True
    except Exception:
        return False


def get_api_port() -> int:
    parsed = urlparse(API_BASE)
    if parsed.port:
        return parsed.port
    return 443 if parsed.scheme == "https" else 80


def kill_process_on_port(port: int):
    log(f"Ensuring port {port} is free before starting the dev server...")
    pids = set()

    if sys.platform == "win32":
        result = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) < 5:
                continue
            local_address = parts[1]
            state = parts[3].upper()
            pid = parts[-1]

            if state != "LISTENING":
                continue
            if not local_address.rsplit(":", 1)[-1] == str(port):
                continue
            if pid.isdigit():
                pids.add(pid)

        for pid in sorted(pids):
            log(f"Killing process {pid} on port {port}...")
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", pid],
                capture_output=True,
                text=True,
            )
    else:
        result = subprocess.run(
            ["lsof", "-ti", f"tcp:{port}"],
            capture_output=True,
            text=True,
        )

        for pid in result.stdout.splitlines():
            pid = pid.strip()
            if pid.isdigit():
                pids.add(pid)

        for pid in sorted(pids):
            log(f"Killing process {pid} on port {port}...")
            try:
                os.kill(int(pid), signal.SIGKILL)
            except ProcessLookupError:
                pass

    if not pids:
        log(f"No existing process was using port {port}.")
    else:
        time.sleep(2)

    remaining_pids = get_listening_pids_on_port(port)
    if remaining_pids:
        raise RuntimeError(
            f"Port {port} is still occupied after kill attempt by PID(s): {', '.join(sorted(remaining_pids))}"
        )


def get_listening_pids_on_port(port: int) -> set[str]:
    pids = set()

    if sys.platform == "win32":
        result = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) < 5:
                continue
            local_address = parts[1]
            state = parts[3].upper()
            pid = parts[-1]

            if state != "LISTENING":
                continue
            if local_address.rsplit(":", 1)[-1] != str(port):
                continue
            if pid.isdigit():
                pids.add(pid)
    else:
        result = subprocess.run(
            ["lsof", "-ti", f"tcp:{port}"],
            capture_output=True,
            text=True,
        )

        for pid in result.stdout.splitlines():
            pid = pid.strip()
            if pid.isdigit():
                pids.add(pid)

    return pids


def read_dev_server_logs() -> str:
    chunks = []
    for file_path in (DEV_SERVER_LOG_PATH, DEV_SERVER_ERR_LOG_PATH):
        if os.path.exists(file_path):
            try:
                with open(file_path, "r", encoding="utf-8", errors="replace") as handle:
                    chunks.append(handle.read())
            except OSError:
                pass
    return "\n".join(chunks)


def detect_dev_server_port_mismatch(expected_port: int) -> str | None:
    log_text = read_dev_server_logs()
    if not log_text:
        return None

    port_switch_match = re.search(r"using available port (\d+)", log_text, re.IGNORECASE)
    if port_switch_match:
        actual_port = int(port_switch_match.group(1))
        if actual_port != expected_port:
            return f"Next.js switched from port {expected_port} to port {actual_port}."

    local_match = re.search(r"Local:\s+http://localhost:(\d+)", log_text, re.IGNORECASE)
    if local_match:
        actual_port = int(local_match.group(1))
        if actual_port != expected_port:
            return f"Next.js reported localhost:{actual_port} instead of localhost:{expected_port}."

    return None


def is_dev_server_ready(expected_port: int) -> bool:
    log_text = read_dev_server_logs()
    return f"http://localhost:{expected_port}" in log_text and "Ready" in log_text


def start_dev_server():
    log("Starting Next.js dev server...")
    npm_cmd = "npm.cmd" if sys.platform == "win32" else "npm"

    stdout_log = open(DEV_SERVER_LOG_PATH, "w", encoding="utf-8")
    stderr_log = open(DEV_SERVER_ERR_LOG_PATH, "w", encoding="utf-8")
    expected_port = get_api_port()

    proc = subprocess.Popen(
        [npm_cmd, "run", "dev"],
        cwd=PROJECT_ROOT,
        stdout=stdout_log,
        stderr=stderr_log,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0,
    )
    log(f"Dev server PID: {proc.pid}")

    log(f"Waiting up to {DEV_SERVER_MAX_WAIT_SECONDS}s for dev server to become ready...")
    start_time = time.time()
    while time.time() - start_time < DEV_SERVER_MAX_WAIT_SECONDS:
        port_mismatch = detect_dev_server_port_mismatch(expected_port)
        if port_mismatch:
            stop_dev_server(proc)
            raise RuntimeError(port_mismatch)
        if is_dev_server_ready(expected_port):
            elapsed = int(time.time() - start_time)
            log(f"Dev server is ready. Took {elapsed}s.")
            return proc
        if proc.poll() is not None:
            raise RuntimeError(f"Dev server process exited with code {proc.returncode}")
        time.sleep(3)

    raise RuntimeError(f"Dev server did not respond within {DEV_SERVER_MAX_WAIT_SECONDS}s.")


def stop_dev_server(proc):
    if not proc:
        return
    log("Stopping dev server...")
    try:
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                capture_output=True,
            )
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        proc.wait(timeout=10)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    log("Dev server stopped.")


def cleanup_dev_server_port():
    port = get_api_port()
    lingering_pids = get_listening_pids_on_port(port)
    if not lingering_pids:
        return

    log(
        f"Detected lingering process(es) on port {port} after shutdown: "
        + ", ".join(sorted(lingering_pids))
    )
    try:
        kill_process_on_port(port)
    except Exception as exc:
        log(f"Warning: Could not fully release port {port}: {exc}")


def api_post(endpoint: str, data: dict) -> dict:
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(
        f"{API_BASE}{endpoint}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_get(endpoint: str) -> dict:
    req = urllib.request.Request(f"{API_BASE}{endpoint}", method="GET")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def submit_job(topic_id: str) -> str:
    log(f"Submitting generation job for topic: {topic_id}")
    data = {"topicId": topic_id, "aspectRatio": "9:16"}
    result = api_post("/api/generate", data)
    job_id = result.get("id")
    if not job_id:
        raise RuntimeError(f"No job ID returned: {result}")
    log(f"Job submitted: {job_id}")
    return job_id


def poll_job(job_id: str) -> dict:
    max_polls = (MAX_POLL_MINUTES * 60) // POLL_INTERVAL_SECONDS
    last_step = None

    for poll_index in range(max_polls):
        try:
            job = api_get(f"/api/generate/{job_id}")
        except Exception as exc:
            log(f"  Poll error: {exc}")
            time.sleep(POLL_INTERVAL_SECONDS)
            continue

        status = job.get("status", "unknown")
        steps = job.get("steps", [])

        current_step = None
        for step in steps:
            if step.get("status") == "running":
                current_step = step.get("label", "Unknown")
                break

        step_info = f" -> {current_step}" if current_step else ""
        if current_step != last_step:
            log(f"  [{status.upper()}]{step_info}")
            last_step = current_step
        elif poll_index % 6 == 0:
            log(f"  [{status.upper()}]{step_info}")

        if status == "completed":
            log("Job completed.")
            return job

        if status == "failed":
            error = job.get("error", "Unknown error")
            failed_step = None
            for step in steps:
                if step.get("status") == "failed":
                    failed_step = step.get("label", "Unknown")
                    break
            raise JobFailure(failed_step or "Video Generation", f"Job failed: {error}")

        time.sleep(POLL_INTERVAL_SECONDS)

    raise RuntimeError(f"Job timed out after {MAX_POLL_MINUTES} minutes.")


def ensure_shorts(text: str) -> str:
    if "#shorts" not in text.lower():
        text = text.rstrip() + " #shorts"
    return text


def ensure_youtube_auth_ready():
    log("Checking YouTube upload auth...")
    result = subprocess.run(
        [
            sys.executable,
            os.path.join(PROJECT_ROOT, "upload.py"),
            "--check-auth",
        ],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
    )

    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "Unknown auth error").strip()
        raise YouTubeAuthFailure(f"YouTube auth check failed:\n{detail}")

    log("YouTube auth is ready.")


def upload_to_youtube(
    video_path: str,
    title: str,
    description: str,
    tags_file: str,
    publish_at: str | None = None,
) -> str:
    title = ensure_shorts(title)
    description = ensure_shorts(description)
    privacy_status = "private" if publish_at else "unlisted"

    if publish_at:
        log(f"Uploading to YouTube for scheduled publication at {publish_at}: {title}")
    else:
        log(f"Uploading to YouTube: {title}")
    command = [
        sys.executable,
        os.path.join(PROJECT_ROOT, "upload.py"),
        "--file",
        video_path,
        "--title",
        title,
        "--description",
        description,
        "--tags-file",
        os.path.join(PROJECT_ROOT, tags_file),
        "--privacy",
        privacy_status,
    ]
    if publish_at:
        command.extend(["--publish-at", publish_at])

    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
    )

    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "Unknown upload error").strip()
        raise UploadFailure(f"YouTube upload failed:\n{detail}")

    video_id = result.stdout.strip().split("\n")[-1].strip()
    log(f"YouTube upload complete. Video ID: {video_id}")
    return video_id


def save_last_upload_state(
    *,
    video_id: str,
    title: str,
    final_video_path: str,
    topic_id: str,
    topic_label: str,
    tags_file: str,
    privacy_status: str,
    publish_at: str | None = None,
):
    record = {
        "videoId": video_id,
        "title": title,
        "finalVideoPath": final_video_path,
        "topicId": topic_id,
        "topicLabel": topic_label,
        "tagsFile": tags_file,
        "privacyStatus": privacy_status,
        "uploadedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "projectRoot": PROJECT_ROOT,
    }
    if publish_at:
        record["publishAt"] = publish_at

    with open(LAST_UPLOAD_STATE_PATH, "w", encoding="utf-8") as handle:
        json.dump(record, handle, indent=2, ensure_ascii=False)

    log(f"Saved last upload metadata: {LAST_UPLOAD_STATE_PATH}")


def send_discord_notification(
    topic_label: str,
    title: str,
    video_id: str,
    publish_at: str | None = None,
):
    yt_url = f"https://youtube.com/shorts/{video_id}" if video_id else "Upload ID unknown"
    schedule_line = f"Scheduled publish: {publish_at}\n" if publish_at else ""
    message = (
        f"V-GEN {PROJECT_LABEL} Upload Complete!\n"
        f"Title: {title}\n"
        f"Topic: {topic_label}\n"
        f"{schedule_line}"
        f"{yt_url}"
    )

    log("Sending Discord notification...")
    result = subprocess.run(
        [
            sys.executable,
            os.path.join(PROJECT_ROOT, "scripts", "notify_discord.py"),
            "--message",
            message,
        ],
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
    )

    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "Unknown Discord error").strip()
        raise DiscordFailure(f"Discord notification failed:\n{detail}")

    log("Discord notification sent.")


def should_run_publish_after_upload() -> bool:
    raw_value = os.environ.get(PUBLISH_AFTER_UPLOAD_ENV, "true").strip().lower()
    if raw_value in {"true", "1", "yes", "on"}:
        return True
    if raw_value in {"false", "0", "no", "off"}:
        return False
    raise PublishFailure(
        f"{PUBLISH_AFTER_UPLOAD_ENV} must be true or false; received {raw_value!r}."
    )


def run_publish_after_upload():
    if not should_run_publish_after_upload():
        log(f"Automatic publish disabled by {PUBLISH_AFTER_UPLOAD_ENV}; skipping publish.bat.")
        return

    publish_path = os.path.join(PROJECT_ROOT, "publish.bat")
    if not os.path.isfile(publish_path):
        raise PublishFailure(f"Publish script not found: {publish_path}")

    log("Running publish.bat for the uploaded YouTube video...")
    command_processor = os.environ.get("COMSPEC", "cmd.exe")
    result = subprocess.run(
        [command_processor, "/d", "/c", publish_path],
        cwd=PROJECT_ROOT,
    )
    if result.returncode != 0:
        raise PublishFailure(f"publish.bat failed with exit code {result.returncode}.")

    log("publish.bat completed successfully.")


def prune_final_videos(max_keep: int = MAX_FINAL_VIDEOS):
    os.makedirs(FINAL_VIDEO_DIR, exist_ok=True)
    video_entries = []

    with os.scandir(FINAL_VIDEO_DIR) as entries:
        for entry in entries:
            if entry.is_file() and entry.name.lower().endswith(".mp4"):
                stat = entry.stat()
                video_entries.append((stat.st_ctime, entry.path))

    video_entries.sort(key=lambda item: item[0], reverse=True)
    old_entries = video_entries[max_keep:]

    for _, file_path in old_entries:
        try:
            os.remove(file_path)
            log(f"Deleted old video: {file_path}")
            json_path = os.path.splitext(file_path)[0] + ".json"
            if os.path.exists(json_path):
                try:
                    os.remove(json_path)
                    log(f"Deleted old payload json: {json_path}")
                except Exception as exc:
                    log(f"Warning: Could not delete old payload json {json_path}: {exc}")
        except Exception as exc:
            log(f"Warning: Could not delete old video {file_path}: {exc}")


def show_desktop_alert(title: str, message: str):
    if sys.platform != "win32":
        log(f"ALERT {title}: {message}")
        return

    try:
        MB_OK = 0x00000000
        MB_ICONERROR = 0x00000010
        MB_SYSTEMMODAL = 0x00001000
        MB_TOPMOST = 0x00040000
        ctypes.windll.user32.MessageBoxW(
            0,
            message,
            title,
            MB_OK | MB_ICONERROR | MB_SYSTEMMODAL | MB_TOPMOST,
        )
    except Exception as exc:
        log(f"Warning: Could not display desktop alert: {exc}")
        log(f"ALERT {title}: {message}")


def format_post_video_alert(stage_label: str, error: Exception, final_video_path: str) -> str:
    detail = str(error).strip() or repr(error)
    return (
        f"An issue occurred while {stage_label}.\n\n"
        f"The video was already created successfully.\n"
        f"Video: {final_video_path}\n\n"
        f"Error:\n{detail}"
    )


def format_pre_render_alert(stage_label: str, error: Exception) -> str:
    detail = str(error).strip() or repr(error)
    return (
        f"An issue occurred during the pre render pipeline.\n\n"
        f"Step: {stage_label}\n\n"
        f"Error:\n{detail}"
    )


def should_show_pre_render_alert() -> bool:
    return os.environ.get(PRE_RENDER_ALERT_ENV, "1").strip() == "1"


def should_show_desktop_alert() -> bool:
    return os.environ.get(DESKTOP_ALERTS_ENV, "1").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


def run_automation(
    contingency_retry: bool,
    publish_at: str | None,
    slot_label: str,
) -> int:
    run_kind = "Contingency Retry" if contingency_retry else "Run"
    run_label = f"V-GEN {slot_label} {run_kind}"
    log("=" * 60)
    log(f"{run_label} Starting")
    log("=" * 60)

    topic_id = random.choice(TOPICS)
    topic_label = TOPIC_LABELS.get(topic_id, topic_id)
    tags_file = TOPIC_TO_TAGS_FILE.get(topic_id, "")
    log(f"Selected topic: {topic_label} ({topic_id})")

    dev_proc = None
    final_video_path = ""
    current_stage = "initialization"
    video_created = False
    exit_code = EXIT_SUCCESS
    alert_title = None
    alert_message = None

    try:
        current_stage = "checking YouTube auth"
        ensure_youtube_auth_ready()

        current_stage = "starting dev server"
        kill_process_on_port(get_api_port())
        dev_proc = start_dev_server()

        current_stage = "submitting generation job"
        job_id = submit_job(topic_id)

        current_stage = "waiting for video generation"
        job = poll_job(job_id)

        current_stage = "extracting generation metadata"
        payload = job.get("payload", {})
        yt_title = payload.get("youtubeTitle", f"{topic_label} #shorts")
        yt_desc = payload.get("youtubeDescription", f"{topic_label} video #shorts")

        final_video_path = job.get("finalVideoPath") or os.path.join(
            PROJECT_ROOT, "Final_Video", f"final_output-{job_id}.mp4"
        )
        if not os.path.exists(final_video_path):
            raise RuntimeError(f"Final video not found at: {final_video_path}")

        video_created = True
        log(f"Final video: {final_video_path}")
        log(f"YouTube Title: {yt_title}")

        current_stage = "pruning old videos"
        prune_final_videos()

        current_stage = "uploading to YouTube"
        video_id = upload_to_youtube(
            final_video_path,
            yt_title,
            yt_desc,
            tags_file,
            publish_at,
        )
        privacy_status = "private" if publish_at else "unlisted"
        save_last_upload_state(
            video_id=video_id,
            title=yt_title,
            final_video_path=final_video_path,
            topic_id=topic_id,
            topic_label=topic_label,
            tags_file=tags_file,
            privacy_status=privacy_status,
            publish_at=publish_at,
        )

        if publish_at:
            log(f"YouTube will publish this private video automatically at {publish_at}.")
        else:
            current_stage = "publishing uploaded YouTube video"
            run_publish_after_upload()

        current_stage = "sending Discord notification"
        send_discord_notification(topic_label, yt_title, video_id, publish_at)

        log("=" * 60)
        log(f"{run_label} Complete")
        log("=" * 60)
    except YouTubeAuthFailure as exc:
        log(f"YOUTUBE AUTH ERROR: {exc}")
        exit_code = EXIT_AUTH_FAILURE
    except UploadFailure as exc:
        log(f"FATAL ERROR: {exc}")
        traceback.print_exc()
        alert_title = "YouTube upload error occurred"
        alert_message = (
            format_post_video_alert("uploading to YouTube", exc, final_video_path)
            if video_created
            else str(exc)
        )
        exit_code = EXIT_UPLOAD_FAILURE
    except DiscordFailure as exc:
        log(f"FATAL ERROR: {exc}")
        traceback.print_exc()
        alert_title = "Couldn't send Discord message"
        alert_message = format_post_video_alert(
            "sending the Discord message",
            exc,
            final_video_path,
        )
        exit_code = EXIT_DISCORD_FAILURE
    except PublishFailure as exc:
        log(f"FATAL ERROR: {exc}")
        traceback.print_exc()
        alert_title = "YouTube publish error occurred"
        alert_message = format_post_video_alert(
            "publishing the uploaded YouTube video",
            exc,
            final_video_path,
        )
        exit_code = EXIT_PUBLISH_FAILURE
    except Exception as exc:
        log(f"FATAL ERROR: {exc}")
        traceback.print_exc()
        if video_created:
            alert_title = "V-GEN Post-Render Issue"
            alert_message = format_post_video_alert(current_stage, exc, final_video_path)
            exit_code = EXIT_POST_VIDEO_FAILURE
        else:
            if isinstance(exc, JobFailure):
                current_stage = exc.stage_label
            if should_show_pre_render_alert():
                alert_title = "Pre Render Pipeline issue"
                alert_message = format_pre_render_alert(current_stage, exc)
            exit_code = EXIT_PRE_VIDEO_FAILURE
    finally:
        if dev_proc:
            stop_dev_server(dev_proc)
            cleanup_dev_server_port()

    if alert_title and alert_message and should_show_desktop_alert():
        show_desktop_alert(
            alert_title,
            alert_message,
        )
    return exit_code


if __name__ == "__main__":
    cli_args = parse_args()
    sys.exit(
        run_automation(
            cli_args.contingency_retry,
            cli_args.publish_at,
            cli_args.slot_label,
        )
    )

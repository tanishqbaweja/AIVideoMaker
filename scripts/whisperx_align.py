import argparse
import json
import os
import sys
from pathlib import Path


ALIGN_MODEL_FILENAME = "wav2vec2_fairseq_base_ls960_asr_ls960.pth"
ALIGN_MODEL_SIZE = 377_664_473


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio-file")
    parser.add_argument("--segments-file")
    parser.add_argument("--jobs-file")
    parser.add_argument("--output-file", required=True)
    parser.add_argument("--language-code", default="en")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--model-dir")
    return parser.parse_args()


def resolve_model_dir(explicit_model_dir):
    configured_dir = explicit_model_dir or os.environ.get("WHISPERX_MODEL_DIR")
    if configured_dir:
        return Path(configured_dir).expanduser().resolve()

    project_root = Path(__file__).resolve().parents[1]
    if project_root.name.lower() == "india":
        project_root = project_root.parent
    return project_root / ".models" / "whisperx"


def require_local_align_model(model_dir):
    model_path = model_dir / ALIGN_MODEL_FILENAME
    if not model_path.is_file() or model_path.stat().st_size != ALIGN_MODEL_SIZE:
        raise FileNotFoundError(
            f"WhisperX alignment model is missing or incomplete at {model_path}. "
            "Download the model once before running the pipeline."
        )


def load_jobs(args):
    if args.jobs_file:
        jobs_path = Path(args.jobs_file)
        with jobs_path.open("r", encoding="utf-8-sig") as handle:
            payload = json.load(handle)
        jobs = payload.get("jobs", [])
        return jobs if isinstance(jobs, list) else []

    if not args.audio_file or not args.segments_file:
        raise ValueError("Either --jobs-file or both --audio-file and --segments-file are required.")

    segments_path = Path(args.segments_file)
    with segments_path.open("r", encoding="utf-8-sig") as handle:
        payload = json.load(handle)

    return [
        {
            "chunkId": "legacy",
            "audioFile": args.audio_file,
            "offset": 0,
            "timeScale": 1,
            "segments": payload.get("segments", payload),
        }
    ]


def main() -> int:
    args = parse_args()

    try:
        import whisperx
    except ImportError:
        print(
            "whisperx is not installed. Run `python -m pip install whisperx` before using alignment.",
            file=sys.stderr,
        )
        return 2

    try:
        jobs = load_jobs(args)
    except Exception as exc:
        print(f"Failed to load WhisperX jobs: {exc}", file=sys.stderr)
        return 2

    output_path = Path(args.output_file)
    results = []

    if jobs:
        model_dir = resolve_model_dir(args.model_dir)
        require_local_align_model(model_dir)
        model_a, metadata = whisperx.load_align_model(
            language_code=args.language_code,
            device=args.device,
            model_dir=str(model_dir),
            model_cache_only=True,
        )

        for job in jobs:
            results.append(align_job(whisperx, model_a, metadata, args.device, job))

    with output_path.open("w", encoding="utf-8") as handle:
        json.dump({"results": results}, handle, ensure_ascii=False)

    return 0


def align_job(whisperx_module, model_a, metadata, device: str, job: dict) -> dict:
    chunk_id = str(job.get("chunkId", "chunk"))
    audio_file = job.get("audioFile")
    segments = job.get("segments", [])
    offset = to_number(job.get("offset"), 0.0)
    time_scale = to_number(job.get("timeScale"), 1.0)

    if not audio_file:
        return {
            "chunk_id": chunk_id,
            "success": False,
            "error": "Missing audioFile.",
            "word_segments": [],
        }

    if not isinstance(segments, list):
        return {
            "chunk_id": chunk_id,
            "success": False,
            "error": "Segments payload must be a list.",
            "word_segments": [],
        }

    try:
        audio = whisperx_module.load_audio(str(audio_file))
        aligned = whisperx_module.align(
            segments,
            model_a,
            metadata,
            audio,
            device,
            return_char_alignments=False,
        )
        word_segments = aligned.get("word_segments")
        if word_segments is None:
            word_segments = []
            for segment in aligned.get("segments", []):
                word_segments.extend(segment.get("words", []))

        adjusted_words = [adjust_word_timing(word, offset, time_scale) for word in word_segments]
        adjusted_words = [word for word in adjusted_words if word.get("end", 0) > word.get("start", 0)]

        return {
            "chunk_id": chunk_id,
            "success": True,
            "word_segments": adjusted_words,
        }
    except Exception as exc:
        return {
            "chunk_id": chunk_id,
            "success": False,
            "error": str(exc),
            "word_segments": [],
        }


def adjust_word_timing(word: dict, offset: float, time_scale: float) -> dict:
    adjusted = dict(word)
    start = to_number(word.get("start"))
    end = to_number(word.get("end"))
    adjusted["start"] = round(max(0.0, offset + start * time_scale), 3)
    adjusted["end"] = round(max(adjusted["start"], offset + end * time_scale), 3)
    return adjusted


def to_number(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


if __name__ == "__main__":
    raise SystemExit(main())

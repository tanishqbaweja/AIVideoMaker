# V-GEN | AI Architect v4.2

V-GEN is a local Next.js app that generates short AI videos from a prompt. It uses Gemini for tagged script generation and full-length narration, Groq Whisper Turbo for rough transcript segments, WhisperX for local word alignment, Pexels for stock video retrieval, and FFmpeg for 60fps video assembly. Video duration adapts to the actual TTS audio length — no trailing silence.

## Features

- Dark three-column video generation UI featuring a "Quick Topic" dropdown with 10 highly-engaging presets (e.g., Obscure Facts, Creepy Knowledge).
- **Anti-Repetition Engine:** The pipeline maintains a circular fact history buffer (10 entries) per topic. Past facts are injected back into the prompt to ensure unique, non-repetitive content across multiple runs.
- Gemini script generation with dynamic API key failover (supports unlimited backup keys sequentially numbered like `GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`, etc.).
- Gemini targets exactly 40-45 second videos with 120-150 spoken words and returns tagged narration, scene durations, Pexels search queries, and subtitle highlight keywords.
- Enforces strict 1-2 word concrete search queries for Pexels to avoid keyword dilution, and mandates a "Subscribe" call-to-action at the end of the script.
- Gemini TTS uses `gemini-3.1-flash-tts-preview` first and `gemini-2.5-flash-preview-tts` as the per-key fallback, with bracketed audio tags interpreted as performance directions.
- Video duration automatically adapts to the actual TTS audio length.
- Resilient 503 overload handling: the pipeline automatically waits 30 seconds and retries up to 5 times for script generation, TTS, and Groq transcription. Gemini 429 rate limits switch to the next configured key.
- Groq Whisper `whisper-large-v3-turbo` transcribes the natural-speed TTS without a script prompt. Narration below 85% exact script coverage is rejected and regenerated, preventing omitted speech from becoming mistimed subtitles.
- Groq rough transcript segments are corrected against the original script for chunk-recovery alignment.
- WhisperX runs locally on CPU and directly aligns one full-script segment to the natural-speed narration, preventing faulty Groq segment boundaries from distorting word timings.
- Strict timing sanitization: if WhisperX alignment fails (e.g., words cover <80% of audio or are crammed >6 words/sec), the entire pipeline resets and retries from script generation (up to 3 times) for self-healing.
- Multiple unique Pexels videos downloaded per scene to avoid visual repetition. Videos are ranked by quality and scaled to fill the target aspect ratio (orientation filtering is bypassed to maximize the video pool).
- Scene footage is synchronized perfectly using word-level `actualDuration` to guarantee the visuals switch exactly when the corresponding spoken sentence ends.
- FFmpeg normalization to:
  - `1080x1920` for `9:16`
  - `1920x1080` for `16:9`
  - `60fps` final export
- Final assembly features background music mixing, a dynamic green-screen chroma key overlay (`sub.mp4` scaled to 130% width) for the final 3 seconds.
- **Dynamic "Pop" Subtitles:** A Python script generates advanced ASS subtitles with a per-word spring/bounce animation (0% -> 130% -> 100% scale), zero-gap continuity, and smooth scale-downs during pauses.
- Final videos saved permanently in `Final_Video/`.
- **Fully Automated End-to-End Orchestrator (`scripts/automate.py`)**: Can be run via Windows Task Scheduler. It randomly selects a topic, starts the server, generates a video, requests CTR-optimized titles/descriptions (per topic rules) from Gemini, and automatically uploads the video to YouTube as a `#shorts`.
- **Discord Notifier (`scripts/notify_discord.py`)**: Sends the project, topic, title, and YouTube Shorts link through the existing Discord bot after upload.

## Requirements

- Windows PC, macOS, or Linux with Node.js 20+ installed.
- Python 3.10+ installed and available as `python` in your terminal.
- Internet access for Gemini, Groq, and Pexels. WhisperX uses a permanently stored local alignment model.
- Gemini API keys.
- Pexels API key.
- Groq API key.
- A `sub.mp4` green-screen subscribe animation and `music.mp3` background track in the root directory.
- `client_secrets.json` for YouTube API (OAuth2) located in the root directory.

The app uses `ffmpeg-static`, so you do not need to install FFmpeg separately for normal use.

## Setup

1. Open a terminal in this folder:

   ```powershell
   cd "H:\Github Repositories\AIVideoMaker"
   ```

2. Install Node dependencies:

   ```powershell
   npm install
   ```

3. Install WhisperX for local alignment:

   ```powershell
   python -m pip install whisperx google-api-python-client google-auth-oauthlib google-auth-httplib2
   ```

   Download the 360 MB wav2vec2 alignment model once. Both the main and India projects use this shared local copy; pipeline runs never download it:

   ```powershell
   New-Item -ItemType Directory -Force ".models\whisperx" | Out-Null
   curl.exe --fail --location --retry 5 --continue-at - --output ".models\whisperx\wav2vec2_fairseq_base_ls960_asr_ls960.pth" "https://download.pytorch.org/torchaudio/models/wav2vec2_fairseq_base_ls960_asr_ls960.pth"
   ```

4. Create `.env.local` from the example file:

   ```powershell
   Copy-Item .env.local.example .env.local
   ```

5. Fill in `.env.local`:

   ```env
   GEMINI_API_KEY=your_primary_key
   # You can add as many backup keys as you want, just keep the numbering sequential
   GEMINI_API_KEY_1=your_backup_key_1
   GEMINI_API_KEY_2=your_backup_key_2
   PEXELS_API_KEY=your_pexels_key
   GROQ_API_KEY=your_groq_key
   GEMINI_SCRIPT_MODEL=gemini-3-flash-preview
   GEMINI_TTS_MODEL=gemini-3.1-flash-tts-preview
   GEMINI_TTS_VOICE=Zephyr
   GEMINI_OVERLOAD_WAIT_MS=30000
   GEMINI_OVERLOAD_RETRIES=5
   ```

`GEMINI_API_KEY`, `PEXELS_API_KEY`, and `GROQ_API_KEY` are required. The backup Gemini keys are optional but used for rate-limit failover.

## Run Locally

Start the dev server:

```powershell
npm run dev
```

Open the URL printed in the terminal, usually:

```text
http://127.0.0.1:3000
```

## Run Automation (Task Scheduler)

The repository includes a fully-automated workflow that handles everything from topic selection to YouTube upload, publishing, and Discord notification.

1. **One-time YouTube Login**: Run the upload script manually once to authenticate via OAuth2. This generates a `token.json` file.
   ```powershell
   python upload.py --file "path/to/any.mp4" --title "Test" --description "Test" --tags-file "tags/obscure_facts_engine.txt"
   ```
2. **Execute**: Run `run_automation.bat` for one visible, immediate generated-video run. Task Scheduler should run `run_automation_headless.vbs` once per day before 8:00 PM IST. The main hidden batch publishes one generated video immediately, schedules one rotating PDFomni video for 8:00 PM IST, then creates and schedules a second generated video for 4:00 AM IST the next day. The India hidden batch publishes one generated video immediately, then creates and schedules a second generated video for 9:00 PM IST the same day.

Each generated-video slot has its own independent allowance of 10 attempts. Slot 2 starts only after slot 1 has been uploaded successfully; in the main batch, the PDFomni upload also completes before slot 2 starts. A failed slot displays its identity in the desktop error message and leaves the complete output in `automation.log`.

Immediate uploads run the project-local `publish.bat` before sending Discord. Scheduled uploads are inserted as private with YouTube's `publishAt` field and become public automatically. `VGEN_RUN_PUBLISH_AFTER_UPLOAD` defaults to `true`; setting it to `false` still leaves manually generated immediate uploads unlisted.

Run `upload_pdf_video.bat` to manually schedule the next eligible PDFomni rotation video for the next 8:00 PM IST using the same authentication recovery flow. Run `python scripts/upload_pdf_video.py --validate-only` to validate all assets without uploading.

Enter a generation prompt, choose the vibe and aspect ratio, then click `COMPILE VIDEO`.

## Pipeline

1. **Scripting:** Gemini generates an exact 40-45s JSON script (120-150 words) ending with a subscribe call-to-action.
2. **TTS:** Gemini generates one continuous narration track. FFmpeg rejects internal silence over 2.5 seconds, and Groq rejects narration with less than 85% script coverage; either failure regenerates only TTS, up to three attempts.
3. **Alignment:** WhisperX directly aligns the full original script to the validated natural-speed narration. Corrected Groq segments are retained only for chunked recovery if direct alignment fails.
4. **Sanitization Check:** The pipeline verifies the word timings span the entire audio. If they fail, the UI steps reset and the pipeline restarts from Step 1 (up to 3 times).
5. **Retrieval:** Multiple unique Pexels videos are downloaded for each scene. Scene durations use word-level `actualDuration` to match the exact narration pacing.
6. **Assembly:** FFmpeg normalizes clips, mixes background audio, burns centered subtitles, applies a chroma-keyed `sub.mp4` overlay for the last 3 seconds, and exports the final 60fps MP4.

## Output Files

Generated videos are saved here:

```text
Final_Video/<youtube-title-without-hashtags>.mp4
Final_Video/<youtube-title-without-hashtags>.json
```

The final JSON file is the saved engine payload for that generation and uses the same base name as the rendered MP4. Temporary downloaded clips, audio files, transcripts, alignment JSON, and FFmpeg intermediates are created under `tmp/` during generation and cleaned after the final outputs have been copied into `Final_Video/`.

## Useful Commands

Build the app:

```powershell
npm run build
```

Run the production server after building:

```powershell
npm start
```

## Troubleshooting

- If the app says an API key is missing, restart the dev server after editing `.env.local`.
- If Gemini returns `503`, the backend waits and retries the same key automatically.
- If Gemini returns `429`, the backend switches to the next configured Gemini key.
- If WhisperX reports a missing or incomplete model, rerun the one-time download command above and verify that `python -m pip install whisperx` completed successfully.
- If Groq transcription fails, check that `GROQ_API_KEY` is valid and that the generated audio file is not empty.
- If the video endpoint returns `Job not found`, the server was restarted and the in-memory job record was lost. The MP4 will still be saved in `Final_Video/` for completed jobs.
- If Pexels retrieval fails, check that `PEXELS_API_KEY` is valid and that your query has usable video results.
- If playback fails in the browser, open the saved MP4 directly from `Final_Video/`.

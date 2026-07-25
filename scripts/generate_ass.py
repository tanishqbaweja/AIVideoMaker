"""
Generate an ASS (Advanced SubStation Alpha) subtitle file with per-word
pop/bounce animation from a JSON input.

Usage:
    python generate_ass.py input.json output.ass

Input JSON schema:
{
  "words": [
    { "word": "Hello", "start": 0.5, "end": 1.2, "highlight": false },
    ...
  ],
  "dimensions": {
    "width": 1080,
    "height": 1920,
    "fontSize": 128,
    "marginV": 540
  },
  "totalDuration": 40.0
}
"""

import json
import sys


def format_ass_time(seconds: float) -> str:
    """Format seconds as ASS timestamp: H:MM:SS.cc (centiseconds)."""
    if seconds < 0:
        seconds = 0
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    cs = int(round((s - int(s)) * 100))
    return f"{h}:{m:02d}:{int(s):02d}.{cs:02d}"


def escape_ass(text: str) -> str:
    """Escape special ASS characters."""
    return text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


def build_ass(words, dimensions, total_duration):
    width = dimensions["width"]
    height = dimensions["height"]
    font_size = dimensions["fontSize"]
    margin_v = dimensions["marginV"]

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,CCSezWho,{font_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H99000000,1,0,0,0,100,100,0,0,1,8,2,5,90,90,{margin_v},1
Style: Highlight,CCSezWho,{font_size},&H004FC7F9,&H004FC7F9,&H00000000,&H99000000,1,0,0,0,100,100,0,0,1,8,2,5,90,90,{margin_v},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"""

    events = []

    for i, word in enumerate(words):
        start = max(0.0, word["start"])
        end = word["end"]

        # Clamp to total duration
        if start >= total_duration:
            continue
        if end > total_duration:
            end = total_duration
        if end <= start:
            continue

        style = "Highlight" if word.get("highlight", False) else "Default"
        display_text = escape_ass(word["word"].upper())

        # Calculate gap to next word
        next_start = words[i + 1]["start"] if i + 1 < len(words) else end
        gap = next_start - end

        # Pop animation: scale 0 → 130% in 60ms, then 130% → 100% in 60ms
        pop_tags = (
            r"{\fscx0\fscy0"
            r"\t(0,60,\fscx130\fscy130)"
            r"\t(60,120,\fscx100\fscy100)}"
        )

        if gap > 0.5:
            # Large pause ahead: scale down to 0 over 100ms before disappearing
            # Calculate the ms offset from the dialogue start where the shrink begins
            word_duration_ms = int(round((end - start) * 1000))
            shrink_start_ms = max(0, word_duration_ms - 100)
            shrink_end_ms = word_duration_ms

            pop_tags = (
                r"{\fscx0\fscy0"
                r"\t(0,60,\fscx130\fscy130)"
                r"\t(60,120,\fscx100\fscy100)"
                rf"\t({shrink_start_ms},{shrink_end_ms},\fscx0\fscy0)"
                r"}"
            )

            # For gapped words, the end time is the actual word end (not next word start)
            dialogue_end = end
        else:
            # Continuous: extend end to next word's start for zero-gap
            dialogue_end = next_start if i + 1 < len(words) else end

        ass_start = format_ass_time(start)
        ass_end = format_ass_time(dialogue_end)

        events.append(
            f"Dialogue: 0,{ass_start},{ass_end},{style},,0,0,0,,{pop_tags}{display_text}"
        )

    return header + "\n" + "\n".join(events) + "\n"


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} input.json output.ass", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    with open(input_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    words = data["words"]
    dimensions = data["dimensions"]
    total_duration = data["totalDuration"]

    ass_content = build_ass(words, dimensions, total_duration)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(ass_content)


if __name__ == "__main__":
    main()

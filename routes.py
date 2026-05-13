"""Server routes for the note_detect plugin.

POST /api/plugins/note_detect/recording
    Body: raw bytes of a RIFF/WAVE file (mono PCM is what the browser
    encodes; we don't crack it open, just validate the header).
    Query: ?slug=<safe-filename-slug>   (optional, defaults to "recording").
    Returns JSON: { path_in_container, relative_path, filename, bytes }.

The WAV lands under ``static/note_detect_recordings/`` (under the
slopsmith static tree, which is bind-mounted in the dev container).
That means the headless harness (``plugins/note_detect/tools/harness.js``)
running on the host can read the same file the browser just saved, with
zero copy / drag-and-drop step. The directory is created on demand.

We deliberately don't write to ``config_dir`` here even though it's the
"correct" home for plugin state — config_dir is a named Docker volume in
the dev compose, so the host can't reach files inside it from outside
the container. ``static/`` IS bind-mounted, which is what we need.
"""

import re
import time
from pathlib import Path
from fastapi import HTTPException, Request

# Subdirectory under the slopsmith static tree where recordings land.
# Bind-mounted via docker-compose (`./static:/app/static`), so the host
# sees these files at `<slopsmith>/static/note_detect_recordings/`.
_RECORDINGS_REL = "note_detect_recordings"

# Filename slug — strip anything that isn't filesystem-safe. Length cap
# keeps us comfortably under any FS limit even with the timestamp tail.
_SLUG_RE = re.compile(r"[^A-Za-z0-9_-]+")
_SLUG_MAX = 40

# Cap to keep a runaway client from filling the disk via the POST body.
# A clean 3-minute recording at 44.1 kHz mono 16-bit PCM is ~15 MB; 32 MB
# leaves headroom for higher sample rates / longer takes while still
# refusing to write multi-GB blobs.
_MAX_BYTES = 32 * 1024 * 1024


def _sanitize_slug(s: str) -> str:
    s = (s or "").strip()
    s = _SLUG_RE.sub("_", s)[:_SLUG_MAX].strip("_")
    return s or "recording"


def setup(app, context):
    log = context["log"]
    out_dir = Path("/app/static") / _RECORDINGS_REL
    out_dir.mkdir(parents=True, exist_ok=True)

    @app.post("/api/plugins/note_detect/recording")
    async def save_recording(request: Request):
        body = await request.body()
        # Tiny WAVs are almost certainly empty / corrupt — RIFF + fmt +
        # data chunks together are 44 bytes minimum even with zero
        # samples, so this is a real-input check, not a hard limit.
        if not body or len(body) < 44:
            raise HTTPException(400, "empty or too-short body (expected a WAV file)")
        if len(body) > _MAX_BYTES:
            raise HTTPException(413, f"recording too large ({len(body)} bytes > {_MAX_BYTES})")
        if body[:4] != b"RIFF" or body[8:12] != b"WAVE":
            raise HTTPException(400, "body is not a WAV file (no RIFF/WAVE header)")

        slug = _sanitize_slug(request.query_params.get("slug", "recording"))
        ts = time.strftime("%Y%m%d_%H%M%S")
        filename = f"note_detect_{slug}_{ts}.wav"
        path = out_dir / filename
        # Use a `.tmp` then rename so a crashed write doesn't leave a
        # truncated WAV that the harness might pick up next time.
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_bytes(body)
        tmp.replace(path)

        rel = f"static/{_RECORDINGS_REL}/{filename}"
        log.info(
            "saved recording (%d bytes, slug=%s) to %s",
            len(body), slug, rel,
        )
        return {
            "path_in_container": str(path),
            "relative_path": rel,
            "filename": filename,
            "bytes": len(body),
        }

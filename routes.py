"""Server routes for the note_detect plugin.

POST /api/plugins/note_detect/recording
    Body: raw bytes of a RIFF/WAVE file (mono PCM is what the browser
    encodes; we don't crack it open, just validate the header).
    Query: ?slug=<safe-filename-slug>   (optional, defaults to "recording").
    Returns JSON: { path_in_container, relative_path, filename, bytes }.

POST /api/plugins/note_detect/live-judgment
    Body: JSON object — one judgment record produced by the detector.
    Query: ?session=<id>   (sanitised; defaults to "default").
    Returns JSON: { ok: true, appended: <bytes> }.
    Appends one JSON line to
    ``static/note_detect_recordings/live_<session>.jsonl``. The plugin
    streams judgments here only when tuning mode is on, so steady-state
    play has zero overhead. Each line is a self-contained record —
    safe to tail / read partially / replay.

Both endpoints write under ``<static>/note_detect_recordings/``, where
``<static>`` is resolved as ``$STATIC_DIR`` (set by native uvicorn
launches and the desktop bundle) and falls back to ``/app/static``
(the in-container bind mount). The directory is created lazily on the
first write so route registration can never fail on a host where the
static tree doesn't exist yet — the route stays mounted, and a real
filesystem problem turns into a clean 500 on save.

We deliberately don't write to ``config_dir`` here even though it's the
"correct" home for plugin state — config_dir is a named Docker volume in
the dev compose, so the host can't reach files inside it from outside
the container. The static tree IS bind-mounted (or repo-relative on
native / desktop runs), which is what we need.
"""

import json
import os
import re
import secrets
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

# Per-judgment payloads are small (~150 bytes typical), but a buggy
# client could spam huge blobs. Cap individual payloads so the JSONL
# file can't be DoSed into millions of bytes per line.
_LIVE_JUDGMENT_MAX_BYTES = 8 * 1024

# JSONL files for a single session shouldn't exceed this — caps total
# accumulation per session. A 2-minute song produces ~60 KB; this gives
# 100× headroom while still bounding pathological cases.
_LIVE_FILE_MAX_BYTES = 8 * 1024 * 1024


def _sanitize_slug(s: str, default: str = "recording") -> str:
    # `default` is parameterised because the same sanitiser feeds the
    # recording-filename slug (where "recording" is the obvious fallback)
    # AND the live-judgment session id (where each route's docstring
    # promises its own fallback — "default" for /live-judgment). If an
    # input sanitises to empty, fall back to the caller's chosen tag
    # rather than coalescing two unrelated routes onto the same name.
    s = (s or "").strip()
    s = _SLUG_RE.sub("_", s)[:_SLUG_MAX].strip("_")
    return s or default


def setup(app, context):
    log = context["log"]
    # Resolve the slopsmith static tree from $STATIC_DIR (set by native
    # uvicorn launches that don't see the Docker `/app` mount) and fall
    # back to the in-container path so this keeps working in compose.
    # The mkdir is deferred to the request handler so a missing/un-
    # writable static dir at plugin-load time can't take down route
    # registration — `/api/plugins/note_detect/recording` would 404 and
    # the in-app save would silently fail.
    static_dir = Path(os.environ.get("STATIC_DIR", "/app/static"))
    out_dir = static_dir / _RECORDINGS_REL

    def _ensure_out_dir() -> Path:
        # Create the recordings directory on first write rather than at
        # setup() time. `static_dir` and `out_dir` are fixed at
        # registration time (changes to $STATIC_DIR after route
        # registration are NOT picked up). mkdir is idempotent
        # (`exist_ok=True`), and an un-writable directory turns into a
        # clean 500 from the caller rather than a load-time crash that
        # 404s the route.
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise HTTPException(
                500,
                f"could not create recordings directory ({out_dir}): {e}",
            )
        return out_dir

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
        # Include milliseconds + a short random suffix so two saves in
        # the same second with the same slug don't overwrite each other
        # (two-panel splitscreen scenario, or rapid arm/save cycles).
        # `secrets.token_hex(3)` is plenty of entropy for human-scale
        # collision avoidance and keeps the filename short.
        now = time.time()
        ts = time.strftime("%Y%m%d_%H%M%S", time.localtime(now))
        ms = int((now - int(now)) * 1000)
        suffix = secrets.token_hex(3)
        filename = f"note_detect_{slug}_{ts}_{ms:03d}_{suffix}.wav"
        path = _ensure_out_dir() / filename
        # Use a `.tmp` then rename so a crashed write doesn't leave a
        # truncated WAV that the harness might pick up next time.
        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            tmp.write_bytes(body)
            tmp.replace(path)
        except OSError as e:
            raise HTTPException(
                500,
                f"could not write recording ({tmp}): {e}",
            )

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

    @app.post("/api/plugins/note_detect/live-judgment")
    async def append_live_judgment(request: Request):
        body = await request.body()
        if not body:
            raise HTTPException(400, "empty body (expected a JSON judgment object)")
        if len(body) > _LIVE_JUDGMENT_MAX_BYTES:
            raise HTTPException(
                413,
                f"judgment too large ({len(body)} bytes > {_LIVE_JUDGMENT_MAX_BYTES})",
            )
        # Parse + re-emit so we (a) reject malformed JSON early and (b)
        # guarantee one self-contained record per line. A buggy client
        # POSTing a multi-line string would otherwise corrupt the JSONL
        # contract (each line = one valid object). Handle both
        # JSONDecodeError (well-formed UTF-8, bad JSON) AND
        # UnicodeDecodeError (raw bytes that aren't valid UTF-8) as
        # 400s — otherwise the latter trickles up as a 500 from
        # `json.loads`, which is misleading to a client sending bad
        # input.
        try:
            obj = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise HTTPException(400, f"body is not valid JSON: {e}")
        if not isinstance(obj, dict):
            raise HTTPException(400, "judgment body must be a JSON object")

        session = _sanitize_slug(request.query_params.get("session", "default"), default="default")
        path = _ensure_out_dir() / f"live_{session}.jsonl"

        # Hard cap on file size — refuse the append rather than truncating
        # existing data, so a buggy client can't lose history. NOTE: the
        # pre-check + append is racy across concurrent POSTs to the same
        # session — two requests can both see `existing` below the cap
        # and then both write, briefly exceeding it. In practice this is
        # bounded by (concurrent-clients × _LIVE_JUDGMENT_MAX_BYTES), and
        # a typical live session has one client per session id, so the
        # race is theoretical. If a future scenario (shared session
        # across multiple panels) makes it real, the fix is to hold a
        # per-session asyncio.Lock around the stat + append.
        try:
            existing = path.stat().st_size
        except FileNotFoundError:
            existing = 0
        except OSError as e:
            raise HTTPException(
                500,
                f"could not stat live-judgment file ({path}): {e}",
            )
        line = json.dumps(obj, separators=(",", ":")) + "\n"
        line_bytes = line.encode("utf-8")
        if existing + len(line_bytes) > _LIVE_FILE_MAX_BYTES:
            raise HTTPException(
                413,
                f"live judgment file at cap ({existing} + {len(line_bytes)} > {_LIVE_FILE_MAX_BYTES})",
            )
        # Append-mode write — POSIX `O_APPEND` makes this atomic per-line
        # even under concurrent requests from a split-screen scenario.
        try:
            with path.open("ab") as f:
                f.write(line_bytes)
        except OSError as e:
            raise HTTPException(
                500,
                f"could not write to live-judgment file ({path}): {e}",
            )
        return {"ok": True, "appended": len(line_bytes), "file": f"static/{_RECORDINGS_REL}/{path.name}"}

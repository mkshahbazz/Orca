"""Supabase Storage for community media (photos and video).

Fisher contributions are photos and short clips, so the files live in Supabase
Storage rather than in Postgres. This module is the *only* place that talks to
it, and it runs exclusively on the server:

    browser --(multipart)--> this API --(service-role key)--> Storage bucket

The service-role key never leaves the backend, and the bucket is public-read so
the browser can display `media_url` directly without a token. Uploads are
validated (kind, size) before they are accepted, and every failure is reported
with its technical detail instead of being swallowed — a contribution that did
not upload must not be recorded as if it had.
"""
import logging
import re
import uuid
from datetime import datetime, timezone

from supabase import create_client

from app.config import settings

log = logging.getLogger("marine.storage")

# Images and short clips only. 20 MB keeps the request inside what the API
# instance can hold in memory while still accepting a phone video clip.
MAX_BYTES = 20 * 1024 * 1024
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}
VIDEO_TYPES = {"video/mp4", "video/quicktime", "video/webm", "video/3gpp", "video/x-matroska"}
ALLOWED_TYPES = IMAGE_TYPES | VIDEO_TYPES

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")

_client = None


class StorageError(RuntimeError):
    """Upload failure with a message safe to show the contributor."""


class StorageNotConfigured(StorageError):
    """Supabase Storage credentials are absent on this deployment."""


def is_configured() -> bool:
    return bool(settings.supabase_url.strip() and settings.supabase_service_role_key.strip())


def bucket() -> str:
    return settings.supabase_storage_bucket.strip() or "community-media"


def _get_client():
    """Server-side Supabase client (service role — never sent to a browser)."""
    global _client
    if not is_configured():
        raise StorageNotConfigured(
            "Media storage is not configured on this server, so photos and video cannot "
            "be uploaded yet. You can still submit the report without media."
        )
    if _client is None:
        _client = create_client(settings.supabase_url, settings.supabase_service_role_key)
    return _client


def media_kind(content_type: str) -> str:
    if content_type in IMAGE_TYPES:
        return "image"
    if content_type in VIDEO_TYPES:
        return "video"
    raise StorageError(
        f"Unsupported file type “{content_type or 'unknown'}”. Upload a JPEG/PNG/WebP photo "
        "or an MP4/MOV/WebM video."
    )


def _object_path(filename: str, content_type: str) -> str:
    ext = ""
    if "." in filename:
        ext = "." + _SAFE_NAME.sub("", filename.rsplit(".", 1)[-1].lower())[:6]
    if not ext:
        ext = ".mp4" if content_type.startswith("video/") else ".jpg"
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    return f"community/{month}/{uuid.uuid4().hex}{ext}"


def upload_media(data: bytes, filename: str, content_type: str) -> dict:
    """Store one contribution file and return its public URL.

    Runs the blocking Supabase SDK in the caller's thread pool (see the router),
    so the event loop is never held up by a 20 MB transfer.
    """
    if not data:
        raise StorageError("The uploaded file was empty.")
    if len(data) > MAX_BYTES:
        raise StorageError(
            f"The file is {len(data) / 1048576:.1f} MB; the limit is "
            f"{MAX_BYTES // 1048576} MB. Please trim the clip or send a smaller photo."
        )
    kind = media_kind(content_type)

    path = _object_path(filename or "upload", content_type)
    client = _get_client()
    try:
        client.storage.from_(bucket()).upload(
            path,
            data,
            {"content-type": content_type, "upsert": "false"},
        )
    except Exception as exc:
        log.error("Supabase Storage upload failed for %s: %s", path, exc)
        raise StorageError(f"Media upload failed: {exc}") from exc

    url = client.storage.from_(bucket()).get_public_url(path)
    if isinstance(url, dict):  # older SDKs return {"publicURL": ...}
        url = url.get("publicURL") or url.get("publicUrl") or ""
    if not url:
        raise StorageError("The upload succeeded but no public URL was returned.")
    log.info("stored community media %s (%s, %d bytes)", path, kind, len(data))
    return {"media_url": str(url), "media_type": kind, "path": path, "bytes": len(data)}

"""Session-upload plumbing: turn a multipart form into BYOI ingest files.

The **decoding** lives here rather than in `routes.py` because it is the one
part of this feature with real edge cases (zip traversal, encodings, nested
archives) and it is pure — no network, no FastAPI — so it can be tested
directly.

**Where the processing happens, and why not here.** The cleaning, digesting, and
upserting pipeline is `gemdex-core`, which is TypeScript; this service is Python
and cannot import it. Rather than port the pipeline (it would immediately drift
from the path-based one that `gemdex sync-history` uses, and the two must produce
identical memories) or bundle Node into this image (a second toolchain in a
runtime stage that deliberately drops it, plus the Gemini key in a third
container), this module only *decodes* the upload. The digest work is done by
`POST /v1/sessions/ingest` on `gemdex-server` — the one process that already has
core, the Gemini key, and the store.

So `GEMINI_API_KEY` stays exactly where it already was: in the BYOI server's
environment. This service never sees it.
"""

from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass

#: Total decoded bytes accepted in one request, across every file. Bounds the
#: memory this process holds at once, since transcripts are read fully into RAM
#: to be forwarded as JSON.
MAX_TOTAL_UPLOAD_BYTES = 64 * 1024 * 1024

#: Per-file decoded cap. A very long agent session is a few MB of JSONL; this
#: leaves generous room while rejecting an obvious mistake (a heap dump, a
#: video) before it is parsed.
MAX_FILE_BYTES = 24 * 1024 * 1024

#: Files forwarded per request. Mirrors the BYOI route's own per-request cap so
#: an over-large selection fails here with a clear message instead of as a
#: relayed upstream 400.
MAX_FILES = 25

#: Only these extensions are accepted. A session transcript is JSONL; a zip is
#: accepted as a container because agents keep sessions in nested folders and
#: browsers cannot upload a directory portably.
SESSION_SUFFIX = ".jsonl"
ZIP_SUFFIXES = (".zip",)


class UploadError(Exception):
    """The upload is malformed in a way that fails the whole request.

    Distinct from a *per-file* failure: a bad transcript inside an otherwise
    valid batch is reported as that file's status, not raised. This is for
    problems with the request itself — nothing usable in it, or over a limit.
    """


@dataclass(frozen=True)
class SessionUpload:
    """One transcript ready to forward: a display name and its JSONL text."""

    filename: str
    content: str


@dataclass(frozen=True)
class RejectedUpload:
    """An entry that never reached the BYOI, and the reason why.

    These are surfaced in the response alongside the BYOI's per-file results so
    the UI can show one uniform list — a zip member that was skipped is just as
    much "a file that did not become a memory" as one the digester rejected.
    """

    filename: str
    error: str


def _decode(raw: bytes, filename: str) -> str:
    """Decode transcript bytes as UTF-8, tolerating a BOM.

    `errors="replace"` is deliberate: a single bad byte in the middle of a long
    session (a truncated write, a mangled paste) should cost that one character,
    not the whole session. The parser already tolerates corrupt lines.
    """
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("utf-8", errors="replace")


def _basename(name: str) -> str:
    """Last path segment, treating both separators as such.

    Zip entries carry their internal path and a hostile archive can contain
    `../` segments or absolute paths. Nothing here writes to disk, but the name
    reaches the digest's provenance and the session-id fallback, so it is
    reduced to a leaf before it travels any further.
    """
    return name.replace("\\", "/").rstrip("/").split("/")[-1]


def is_session_filename(name: str) -> bool:
    return _basename(name).lower().endswith(SESSION_SUFFIX)


def is_zip_filename(name: str) -> bool:
    return _basename(name).lower().endswith(ZIP_SUFFIXES)


def expand_zip(raw: bytes, archive_name: str) -> tuple[list[SessionUpload], list[RejectedUpload]]:
    """Extract the `.jsonl` members of a zip archive.

    Only regular `.jsonl` members are taken; directories, other file types, and
    nested archives are skipped rather than recursed. Members are read through
    `ZipFile.open` with an explicit size check against the *declared*
    uncompressed size first, so a zip bomb is refused before it is inflated.
    """
    uploads: list[SessionUpload] = []
    rejected: list[RejectedUpload] = []
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except (zipfile.BadZipFile, OSError) as error:
        raise UploadError(f"'{_basename(archive_name)}' is not a readable zip archive: {error}") from error

    with archive:
        members = [info for info in archive.infolist() if not info.is_dir()]
        candidates = [info for info in members if is_session_filename(info.filename)]
        if not candidates:
            raise UploadError(
                f"'{_basename(archive_name)}' contains no .jsonl session files "
                f"({len(members)} other entr{'y' if len(members) == 1 else 'ies'} skipped)."
            )
        for info in candidates:
            name = _basename(info.filename)
            # The declared size is checked before inflating: reading first and
            # measuring after is what makes a zip bomb effective.
            if info.file_size > MAX_FILE_BYTES:
                rejected.append(
                    RejectedUpload(name, f"{info.file_size} bytes exceeds the {MAX_FILE_BYTES}-byte limit.")
                )
                continue
            try:
                with archive.open(info) as member:
                    raw_member = member.read(MAX_FILE_BYTES + 1)
            except (zipfile.BadZipFile, OSError, RuntimeError) as error:
                # RuntimeError is what zipfile raises for an encrypted member.
                rejected.append(RejectedUpload(name, f"could not be read from the archive: {error}"))
                continue
            if len(raw_member) > MAX_FILE_BYTES:
                rejected.append(
                    RejectedUpload(name, f"expands past the {MAX_FILE_BYTES}-byte per-file limit.")
                )
                continue
            uploads.append(SessionUpload(name, _decode(raw_member, name)))

    return uploads, rejected


def collect_uploads(
    entries: list[tuple[str, bytes]],
) -> tuple[list[SessionUpload], list[RejectedUpload]]:
    """Flatten uploaded form entries into transcripts to forward.

    `.jsonl` files are taken as-is; `.zip` files are expanded into their `.jsonl`
    members. Anything else is rejected by name — accepting it would mean paying
    for a Gemini call to discover that a screenshot is not a session.

    Raises `UploadError` when the request as a whole is unusable: no files, no
    recognizable transcripts, or over the total-size / file-count caps.
    """
    if not entries:
        raise UploadError("No files were uploaded.")

    uploads: list[SessionUpload] = []
    rejected: list[RejectedUpload] = []
    total = 0

    for raw_name, raw in entries:
        name = _basename(raw_name) or "unnamed"
        total += len(raw)
        if total > MAX_TOTAL_UPLOAD_BYTES:
            raise UploadError(
                f"The upload exceeds the {MAX_TOTAL_UPLOAD_BYTES}-byte total limit. "
                "Upload fewer files at a time."
            )
        if len(raw) == 0:
            rejected.append(RejectedUpload(name, "is empty."))
            continue
        if is_zip_filename(name):
            expanded, zip_rejected = expand_zip(raw, name)
            uploads.extend(expanded)
            rejected.extend(zip_rejected)
            continue
        if not is_session_filename(name):
            rejected.append(RejectedUpload(name, "is not a .jsonl session file or a .zip archive."))
            continue
        if len(raw) > MAX_FILE_BYTES:
            rejected.append(RejectedUpload(name, f"{len(raw)} bytes exceeds the {MAX_FILE_BYTES}-byte limit."))
            continue
        uploads.append(SessionUpload(name, _decode(raw, name)))

    if not uploads:
        if rejected:
            # Every entry was rejected by name/size. That is a request-level
            # failure with a specific cause, so name the first one rather than
            # returning an empty success the user has to interpret.
            raise UploadError(
                f"No session transcripts to ingest: {rejected[0].filename} {rejected[0].error}"
            )
        raise UploadError("No session transcripts to ingest.")
    if len(uploads) > MAX_FILES:
        raise UploadError(
            f"{len(uploads)} session files exceeds the {MAX_FILES}-file per-request limit. "
            "Upload them in smaller batches."
        )

    return uploads, rejected

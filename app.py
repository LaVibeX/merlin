from __future__ import annotations

import io
import json
import re
import uuid
from functools import lru_cache
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, render_template, request, send_file
from pypdf import PdfReader

try:
    from wordfreq import zipf_frequency
except ImportError:  # pragma: no cover - optional dependency guard
    zipf_frequency = None

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
SETTINGS_FILE = DATA_DIR / "settings.json"
ANNOTATIONS_FILE = DATA_DIR / "annotations.json"

DEFAULT_SETTINGS: dict[str, Any] = {"pdf_folder": ""}

app = Flask(__name__)


JOINABLE_COMMON_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "calculate",
    "for",
    "from",
    "has",
    "have",
    "in",
    "integrate",
    "into",
    "is",
    "it",
    "its",
    "key",
    "more",
    "not",
    "of",
    "on",
    "or",
    "out",
    "size",
    "such",
    "that",
    "the",
    "their",
    "there",
    "this",
    "to",
    "update",
    "was",
    "we",
    "were",
    "with",
    "authentication",
    "done",
    "once",
    "part",
}


@lru_cache(maxsize=1)
def get_english_word_set() -> set[str]:
    words = set(JOINABLE_COMMON_WORDS)
    words.update({"a", "i"})

    # Use a system dictionary when available for safer split-word repair.
    for candidate in (Path("/usr/share/dict/words"), Path("/usr/dict/words")):
        if not candidate.exists() or not candidate.is_file():
            continue
        try:
            for raw in candidate.read_text(encoding="utf-8", errors="ignore").splitlines():
                token = raw.strip().lower()
                if token.isalpha():
                    words.add(token)
            break
        except OSError:
            continue

    return words


def is_likely_english_word(token: str) -> bool:
    normalized = token.strip().lower()
    return bool(normalized) and normalized.isalpha() and normalized in get_english_word_set()


def english_word_score(token: str) -> float:
    normalized = token.strip().lower()
    if not normalized.isalpha():
        return 0.0

    if normalized in {"a", "i"}:
        return 8.0

    if normalized in JOINABLE_COMMON_WORDS:
        return 7.0

    if zipf_frequency is not None:
        return float(zipf_frequency(normalized, "en"))

    return 1.0 if is_likely_english_word(normalized) else 0.0


def ensure_data_files() -> None:
    DATA_DIR.mkdir(exist_ok=True)

    if not SETTINGS_FILE.exists():
        SETTINGS_FILE.write_text(json.dumps(DEFAULT_SETTINGS, indent=2), encoding="utf-8")

    if not ANNOTATIONS_FILE.exists():
        ANNOTATIONS_FILE.write_text(json.dumps({}, indent=2), encoding="utf-8")


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def get_pdf_root() -> Path | None:
    settings = read_json(SETTINGS_FILE, DEFAULT_SETTINGS)
    raw_path = str(settings.get("pdf_folder", "")).strip()
    if not raw_path:
        return None

    root = Path(raw_path).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        return None

    return root


def list_pdf_files(root: Path) -> list[str]:
    pdf_files: list[str] = []
    for file_path in root.rglob("*"):
        if file_path.is_file() and file_path.suffix.lower() == ".pdf":
            pdf_files.append(file_path.relative_to(root).as_posix())
    return sorted(pdf_files, key=str.lower)


def safe_pdf_path(root: Path, rel_path: str) -> Path:
    candidate = (root / rel_path).resolve()
    if root == candidate or root not in candidate.parents:
        raise ValueError("Invalid PDF path")
    if not candidate.exists() or candidate.suffix.lower() != ".pdf":
        raise ValueError("PDF file not found")
    return candidate


def normalize_extracted_line(line: str) -> str:
    cleaned = re.sub(r"\s+", " ", line).strip()

    one_char_hint = bool(
        re.search(r"\b[A-Za-z]\s+[A-Za-z]{2,}\b|\b[A-Za-z]{2,}\s+[A-Za-z]\b", cleaned)
    )
    suffix_hint = bool(
        re.search(
            r"\b[A-Za-z]{4,}\s+(ion|tion|sion|ment|ing|ized|ation|ations|late|ality|ance|ence)\b",
            cleaned,
            flags=re.IGNORECASE,
        )
    )
    artifact_hint = one_char_hint or suffix_hint

    def merge_left_single(match: re.Match[str]) -> str:
        left, right = match.group(1), match.group(2)
        merged = f"{left}{right}"
        right_score = english_word_score(right)
        merged_score = english_word_score(merged)

        if left.lower() in {"a", "i"} and right_score > 0 and merged_score <= right_score:
            return match.group(0)

        if right_score <= 0 or merged_score > 0:
            return merged
        return match.group(0)

    def merge_right_single(match: re.Match[str]) -> str:
        left, right = match.group(1), match.group(2)
        merged = f"{left}{right}"
        left_score = english_word_score(left)
        merged_score = english_word_score(merged)

        if right.lower() in {"a", "i"} and left_score > 0:
            return match.group(0)

        if left_score <= 0 or merged_score > 0:
            return merged
        return match.group(0)

    def merge_suffix_fragment(match: re.Match[str]) -> str:
        left, right = match.group(1), match.group(2)
        merged = f"{left}{right}"
        left_score = english_word_score(left)
        right_score = english_word_score(right)
        merged_score = english_word_score(merged)

        if merged_score > 0 and merged_score >= max(left_score, right_score) - 0.6:
            return merged

        if artifact_hint and left_score <= 0 and len(left) >= 4:
            return merged

        return match.group(0)

    # Pass 1: fix splits like "t he", "i ntegrate", "O nce".
    left_single_pattern = re.compile(r"\b([A-Za-z])\s+([A-Za-z]{2,})\b")
    previous = None
    while cleaned != previous:
        previous = cleaned
        cleaned = left_single_pattern.sub(merge_left_single, cleaned)

    # Pass 2: fix splits like "an d", "don e", but avoid "we i ntegrate"-style over-joins.
    right_single_pattern = re.compile(r"\b([A-Za-z]{2,})\s+([A-Za-z])\b(?!\s+[A-Za-z]{2,}\b)")
    previous = None
    while cleaned != previous:
        previous = cleaned
        cleaned = right_single_pattern.sub(merge_right_single, cleaned)

    # Pass 3: fix larger suffix splits like "authenticat ion" and "calcu late".
    suffix_fragment_pattern = re.compile(
        r"\b([A-Za-z]{4,})\s+(ion|tion|sion|ment|ing|ized|ation|ations|late|ality|ance|ence)\b",
        flags=re.IGNORECASE,
    )
    previous = None
    while cleaned != previous:
        previous = cleaned
        cleaned = suffix_fragment_pattern.sub(merge_suffix_fragment, cleaned)

    return cleaned


def extract_text_lines(pdf_path: Path) -> list[dict[str, Any]]:
    reader = PdfReader(str(pdf_path))
    return extract_text_lines_from_reader(reader)


def extract_text_lines_from_reader(reader: PdfReader) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []

    for index, page in enumerate(reader.pages, start=1):
        raw_text = page.extract_text() or ""
        lines = [normalize_extracted_line(line) for line in raw_text.splitlines() if line.strip()]
        pages.append({"page": index, "lines": lines})

    return pages


def default_annotations() -> dict[str, Any]:
    return {
        "notes": "",
        "highlights": [],
        "comments": [],
        "updatedAt": None,
    }


@app.route("/")
def index() -> str:
    ensure_data_files()
    return render_template("index.html")


@app.get("/api/folder")
def get_folder() -> Any:
    ensure_data_files()
    root = get_pdf_root()
    return jsonify({"folder": str(root) if root else ""})


@app.post("/api/folder")
def set_folder() -> Any:
    ensure_data_files()
    data = request.get_json(silent=True) or {}
    raw_path = str(data.get("path", "")).strip()

    if not raw_path:
        return jsonify({"error": "Folder path is required."}), 400

    folder = Path(raw_path).expanduser().resolve()
    if not folder.exists() or not folder.is_dir():
        return jsonify({"error": "Folder does not exist."}), 400

    write_json(SETTINGS_FILE, {"pdf_folder": str(folder)})
    return jsonify({"folder": str(folder)})


@app.get("/api/pdfs")
def get_pdfs() -> Any:
    ensure_data_files()
    root = get_pdf_root()
    if root is None:
        return jsonify({"error": "No valid PDF folder configured."}), 400

    return jsonify({"files": list_pdf_files(root)})


@app.get("/api/pdf")
def serve_pdf() -> Any:
    ensure_data_files()
    root = get_pdf_root()
    if root is None:
        return jsonify({"error": "No valid PDF folder configured."}), 400

    rel_path = str(request.args.get("file", "")).strip()
    if not rel_path:
        return jsonify({"error": "Query param 'file' is required."}), 400

    try:
        target = safe_pdf_path(root, rel_path)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    return send_file(target, mimetype="application/pdf")


@app.get("/api/text")
def get_text() -> Any:
    ensure_data_files()
    root = get_pdf_root()
    if root is None:
        return jsonify({"error": "No valid PDF folder configured."}), 400

    rel_path = str(request.args.get("file", "")).strip()
    if not rel_path:
        return jsonify({"error": "Query param 'file' is required."}), 400

    try:
        target = safe_pdf_path(root, rel_path)
        pages = extract_text_lines(target)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:  # pragma: no cover - protective API boundary
        return jsonify({"error": f"Unable to parse PDF: {exc}"}), 500

    return jsonify({"pages": pages})


@app.post("/api/text-upload")
def get_text_upload() -> Any:
    ensure_data_files()
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return jsonify({"error": "Form file field 'file' is required."}), 400

    if not upload.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Only PDF files are supported."}), 400

    try:
        reader = PdfReader(io.BytesIO(upload.read()))
        pages = extract_text_lines_from_reader(reader)
    except Exception as exc:  # pragma: no cover - protective API boundary
        return jsonify({"error": f"Unable to parse PDF: {exc}"}), 500

    return jsonify({"pages": pages})


@app.get("/api/annotations")
def get_annotations() -> Any:
    ensure_data_files()
    rel_path = str(request.args.get("file", "")).strip()
    if not rel_path:
        return jsonify({"error": "Query param 'file' is required."}), 400

    data = read_json(ANNOTATIONS_FILE, {})
    payload = data.get(rel_path, default_annotations())
    return jsonify(payload)


@app.put("/api/annotations")
def save_annotations() -> Any:
    ensure_data_files()
    rel_path = str(request.args.get("file", "")).strip()
    if not rel_path:
        return jsonify({"error": "Query param 'file' is required."}), 400

    body = request.get_json(silent=True) or {}

    sanitized = {
        "notes": str(body.get("notes", "")),
        "highlights": body.get("highlights", []),
        "comments": body.get("comments", []),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }

    if not isinstance(sanitized["highlights"], list) or not isinstance(sanitized["comments"], list):
        return jsonify({"error": "Highlights and comments must be arrays."}), 400

    for item in sanitized["highlights"]:
        item.setdefault("id", str(uuid.uuid4()))

    for item in sanitized["comments"]:
        item.setdefault("id", str(uuid.uuid4()))

    data = read_json(ANNOTATIONS_FILE, {})
    data[rel_path] = sanitized
    write_json(ANNOTATIONS_FILE, data)

    return jsonify({"status": "ok", "updatedAt": sanitized["updatedAt"]})


if __name__ == "__main__":
    ensure_data_files()
    app.run(debug=True)

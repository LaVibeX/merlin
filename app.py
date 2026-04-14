from __future__ import annotations

import io
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, render_template, request, send_file
from pypdf import PdfReader

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
SETTINGS_FILE = DATA_DIR / "settings.json"
ANNOTATIONS_FILE = DATA_DIR / "annotations.json"

DEFAULT_SETTINGS: dict[str, Any] = {"pdf_folder": ""}

app = Flask(__name__)


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


def extract_text_lines(pdf_path: Path) -> list[dict[str, Any]]:
    reader = PdfReader(str(pdf_path))
    return extract_text_lines_from_reader(reader)


def extract_text_lines_from_reader(reader: PdfReader) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []

    for index, page in enumerate(reader.pages, start=1):
        raw_text = page.extract_text() or ""
        lines = [line.strip() for line in raw_text.splitlines() if line.strip()]
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

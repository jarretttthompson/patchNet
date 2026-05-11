#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "sentence-transformers>=3.0",
#   "sqlite-vec>=0.1.6",
# ]
# ///
"""
patchNet vault RAG — local semantic search over the project brain.

Run with `uv run scripts/vault_rag.py ...` (recommended) or after
`pip install sentence-transformers sqlite-vec`.

Indexes:
  - patchNet-Vault/wiki/**/*.md
  - PLAN.md, DESIGN_LANGUAGE.md, CHANGELOG.md, CLAUDE.md, README.md

Usage:
  python scripts/vault_rag.py index               # build / rebuild index
  python scripts/vault_rag.py query "straight cables rationale"
  python scripts/vault_rag.py query "..." --k 8 --json

Output of `query` is markdown chunks with file:line headers — paste straight
into a chat with Claude or pipe to a local model.

Embedding model: BAAI/bge-small-en-v1.5 (384-dim, ~130 MB, already cached).
Storage: scripts/.vault_rag.sqlite (single file, gitignore it).
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

import sqlite_vec
from sentence_transformers import SentenceTransformer

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(__file__).resolve().parent / ".vault_rag.sqlite"
MODEL_NAME = "BAAI/bge-small-en-v1.5"
EMBED_DIM = 384

INCLUDE_GLOBS = [
    "patchNet-Vault/wiki/**/*.md",
]
INCLUDE_FILES = [
    "PLAN.md",
    "DESIGN_LANGUAGE.md",
    "CHANGELOG.md",
    "CLAUDE.md",
    "README.md",
]

CHUNK_TARGET_CHARS = 1200   # ~300 tokens, fits BGE's 512-token window comfortably
CHUNK_OVERLAP_CHARS = 200


def collect_files() -> list[Path]:
    files: set[Path] = set()
    for pattern in INCLUDE_GLOBS:
        files.update(ROOT.glob(pattern))
    for name in INCLUDE_FILES:
        p = ROOT / name
        if p.exists():
            files.add(p)
    return sorted(files)


def chunk_markdown(text: str) -> list[tuple[int, str]]:
    """Split on H1/H2/H3, then window long sections. Returns (start_line, chunk)."""
    lines = text.splitlines()
    sections: list[tuple[int, list[str]]] = []
    current_start = 0
    current: list[str] = []
    header_re = re.compile(r"^#{1,3} ")
    for i, line in enumerate(lines):
        if header_re.match(line) and current:
            sections.append((current_start, current))
            current = [line]
            current_start = i
        else:
            current.append(line)
    if current:
        sections.append((current_start, current))

    chunks: list[tuple[int, str]] = []
    for start_line, sec_lines in sections:
        body = "\n".join(sec_lines).strip()
        if not body:
            continue
        if len(body) <= CHUNK_TARGET_CHARS:
            chunks.append((start_line + 1, body))
            continue
        # Window long sections
        i = 0
        while i < len(body):
            piece = body[i : i + CHUNK_TARGET_CHARS]
            # approximate line offset
            line_offset = body[:i].count("\n")
            chunks.append((start_line + 1 + line_offset, piece))
            if i + CHUNK_TARGET_CHARS >= len(body):
                break
            i += CHUNK_TARGET_CHARS - CHUNK_OVERLAP_CHARS
    return chunks


def open_db() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.enable_load_extension(True)
    sqlite_vec.load(db)
    db.enable_load_extension(False)
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL,
            line INTEGER NOT NULL,
            text TEXT NOT NULL
        )
        """
    )
    db.execute(
        f"CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks "
        f"USING vec0(embedding float[{EMBED_DIM}])"
    )
    return db


def cmd_index(args: argparse.Namespace) -> int:
    files = collect_files()
    print(f"[index] {len(files)} files", file=sys.stderr)
    model = SentenceTransformer(MODEL_NAME)

    db = open_db()
    db.execute("DELETE FROM chunks")
    db.execute("DELETE FROM vec_chunks")

    all_chunks: list[tuple[str, int, str]] = []
    for fp in files:
        rel = str(fp.relative_to(ROOT))
        try:
            text = fp.read_text(encoding="utf-8")
        except Exception as e:
            print(f"  skip {rel}: {e}", file=sys.stderr)
            continue
        for line, chunk in chunk_markdown(text):
            all_chunks.append((rel, line, chunk))
    print(f"[index] {len(all_chunks)} chunks", file=sys.stderr)

    # Encode with bge prefix for retrieval-style embeddings
    inputs = [c[2] for c in all_chunks]
    embeds = model.encode(
        inputs, batch_size=32, show_progress_bar=True, normalize_embeddings=True
    )

    for (rel, line, chunk), emb in zip(all_chunks, embeds):
        cur = db.execute(
            "INSERT INTO chunks (path, line, text) VALUES (?, ?, ?)",
            (rel, line, chunk),
        )
        rowid = cur.lastrowid
        db.execute(
            "INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)",
            (rowid, sqlite_vec.serialize_float32(list(map(float, emb)))),
        )
    db.commit()
    print(f"[index] wrote {DB_PATH}", file=sys.stderr)
    return 0


def cmd_query(args: argparse.Namespace) -> int:
    if not DB_PATH.exists():
        print("No index. Run: vault_rag.py index", file=sys.stderr)
        return 1
    model = SentenceTransformer(MODEL_NAME)
    # BGE recommends a query prefix for asymmetric retrieval
    q = "Represent this sentence for searching relevant passages: " + args.query
    emb = model.encode([q], normalize_embeddings=True)[0]

    db = open_db()
    rows = db.execute(
        """
        SELECT chunks.path, chunks.line, chunks.text, vec_chunks.distance
        FROM vec_chunks
        JOIN chunks ON chunks.id = vec_chunks.rowid
        WHERE vec_chunks.embedding MATCH ?
          AND k = ?
        ORDER BY vec_chunks.distance
        """,
        (sqlite_vec.serialize_float32(list(map(float, emb))), args.k),
    ).fetchall()

    if args.json:
        print(json.dumps(
            [{"path": p, "line": l, "score": 1 - d, "text": t} for p, l, t, d in rows],
            indent=2,
        ))
        return 0

    for path, line, text, dist in rows:
        print(f"\n--- {path}:{line}  (score {1 - dist:.3f}) ---")
        print(text)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("index", help="build / rebuild the vector index")

    qp = sub.add_parser("query", help="semantic search the vault")
    qp.add_argument("query", type=str)
    qp.add_argument("--k", type=int, default=5)
    qp.add_argument("--json", action="store_true")

    args = parser.parse_args()
    if args.cmd == "index":
        return cmd_index(args)
    if args.cmd == "query":
        return cmd_query(args)
    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())

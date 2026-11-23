"""Store committed SocialNet posts by run with a bounded archive."""
from __future__ import annotations

import json
import os
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .models import ChatMessage


ARCHIVE_NAME = re.compile(r"[0-9]{8}T[0-9]{12}Z_[0-9a-f]{32}")


@dataclass
class PostArchive:
    folder: Path
    part: int = 1
    part_bytes: int = 0

    @property
    def current_file(self) -> Path:
        return self.folder / f"posts-{self.part:06d}.jsonl"


class PostArchives:
    def __init__(self, root: Path, *, max_runs: int = 30, max_bytes: int = 128 * 1024**2,
                 part_bytes: int = 4 * 1024**2):
        self.root = root.resolve()
        self.max_runs = max_runs
        self.max_bytes = max_bytes
        self.part_bytes = part_bytes

    def open(self, run_id: str, target_poi_id: str, seed: int) -> PostArchive:
        started = datetime.now(timezone.utc)
        folder = self.root / (started.strftime('%Y%m%dT%H%M%S%fZ') + "_" + run_id)
        folder.mkdir(parents=True, exist_ok=False)
        metadata = {"run_id": run_id, "target_poi_id": target_poi_id, "seed": seed, "started_at": started.isoformat()}
        (folder / "run.json").write_text(json.dumps(metadata, ensure_ascii=False) + "\n", encoding="utf-8")
        archive = PostArchive(folder)
        self._prune(archive)
        return archive

    def append(self, archive: PostArchive, messages: list[ChatMessage]):
        if not messages:
            return
        payload = ("\n".join(message.model_dump_json() for message in messages) + "\n").encode("utf-8")
        if archive.part_bytes and archive.part_bytes + len(payload) > self.part_bytes:
            archive.part += 1
            archive.part_bytes = 0
        with archive.current_file.open("ab") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        archive.part_bytes += len(payload)
        self._prune(archive)

    def _prune(self, active: PostArchive):
        runs = []
        for path in sorted(self.root.iterdir()):
            if (not ARCHIVE_NAME.fullmatch(path.name) or path.is_symlink() or not path.is_dir()
                    or path.resolve().parent != self.root):
                continue
            size = sum(file.stat().st_size for file in path.iterdir() if file.is_file())
            runs.append((path, size))
        total = sum(size for _, size in runs)
        kept = len(runs)
        for folder, size in runs:
            if kept <= self.max_runs and total <= self.max_bytes:
                return
            if folder != active.folder:
                shutil.rmtree(folder)
                total -= size
                kept -= 1
        # A single long-running simulation also rotates its oldest closed segments.
        for part in sorted(active.folder.glob("posts-*.jsonl")):
            if total <= self.max_bytes or part == active.current_file:
                break
            total -= part.stat().st_size
            part.unlink()

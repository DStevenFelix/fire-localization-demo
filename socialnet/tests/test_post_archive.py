import json
from datetime import datetime, timezone

from app.models import ChatMessage
from app.post_archive import PostArchives


def post(sequence):
    return ChatMessage(id=f"post-{sequence}", timestamp=datetime.now(timezone.utc), simulation_minute=5,
                       sequence=sequence, resident_id="R1", resident_name="居民", building_id="B1",
                       building_name="住宅", unit="1", position={"x": 1, "y": 2},
                       content="看到远处有烟", community_id="C1")


def test_posts_are_rotated_within_the_current_run(tmp_path):
    one_post = len(post(1).model_dump_json().encode("utf-8")) + 1
    archives = PostArchives(tmp_path, part_bytes=one_post + 16, max_bytes=one_post * 2 + 256)
    run = archives.open("a" * 32, "T-NE-01", 42)
    for index in range(1, 6):
        archives.append(run, [post(index)])
    messages = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(run.folder.glob("posts-*.jsonl"))]
    assert [message["sequence"] for message in messages] == [4, 5]
    assert sum(p.stat().st_size for p in run.folder.iterdir()) <= archives.max_bytes


def test_oldest_run_is_pruned_only_in_managed_archive(tmp_path):
    marker = tmp_path / "simulation.sqlite3"
    marker.write_text("legacy posts and reports", encoding="utf-8")
    archives = PostArchives(tmp_path, max_runs=2)
    first = archives.open("a" * 32, "T-NE-01", 42)
    archives.append(first, [post(1)])
    second = archives.open("b" * 32, "T-NE-02", 42)
    third = archives.open("c" * 32, "T-NE-02", 42)
    assert not first.folder.exists()
    assert set(tmp_path.iterdir()) == {marker, second.folder, third.folder}
    assert marker.read_text(encoding="utf-8") == "legacy posts and reports"

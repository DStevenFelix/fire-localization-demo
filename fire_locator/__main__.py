import argparse
import json
from pathlib import Path

from .config import Settings
from .demo import generate
from .engine import FireLocalizer
from .models import Post
from .poi import DEFAULT_TARGET_ID, PoiRepository
from .providers import atomic_json


def main():
    parser = argparse.ArgumentParser(description="LangChain 火灾定位 demo，每批独立提取每条帖子的参照物和方位")
    commands = parser.add_subparsers(dest="command", required=True)
    demo = commands.add_parser("generate", help="生成模拟帖子，真实着火标签单独保存")
    demo.add_argument("--count", type=int, default=100)
    demo.add_argument("--seed", type=int, default=42)
    demo.add_argument("--target", default=DEFAULT_TARGET_ID)
    demo.add_argument("--output", type=Path, default=Path("data/demo_posts.jsonl"))
    replay = commands.add_parser("replay", help="按时间回放帖子，每 10 条发布一次结果")
    replay.add_argument("--input", type=Path, default=Path("data/demo_posts.jsonl"))
    replay.add_argument("--offline", action="store_true", help="明确使用测试替身，不调用真实 API")
    replay.add_argument("--output-dir", type=Path)
    replay.add_argument("--resume", action="store_true", help="从同一 output-dir 的 memory.json 继续")
    args = parser.parse_args()
    settings = Settings.load()
    if args.command == "generate":
        metadata = generate(PoiRepository(settings.root), args.output, args.count, args.seed, args.target)
        print(json.dumps(metadata, ensure_ascii=False, indent=2))
        return
    output = args.output_dir or settings.root/"runtime"/("offline" if args.offline else "live")
    output.mkdir(parents=True, exist_ok=True)
    raw_posts = [json.loads(line) for line in args.input.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    posts = sorted([Post.model_validate(item) for item in raw_posts], key=lambda post: post.timestamp)
    repository = PoiRepository(settings.root)
    for post in posts:
        repository.validate_location(post.location_poi_id)
    ids = [post.id for post in posts]
    if len(ids) != len(set(ids)):
        raise ValueError("输入文件含重复帖子 ID")
    engine = FireLocalizer(settings, args.offline, output/"memory.json", args.resume)
    updates = []
    history = output/"batch_results.json"
    if args.resume and history.exists():
        updates = json.loads(history.read_text(encoding="utf-8"))
    try:
        for start in range(0, len(posts), settings.batch_size):
            response = engine.ingest(posts[start:start+settings.batch_size], flush=True)
            for update in response["updates"]:
                updates.append(update)
                prediction = update["prediction"]
                names = ", ".join(candidate["name"] for candidate in prediction["candidates"])
                print(f"batch={update['batch_number']} processed={prediction['processed_count']} top3=[{names}]", flush=True)
            atomic_json(history, updates)
        prediction = engine.prediction()
        atomic_json(output/"prediction.json", prediction)
        atomic_json(output/"clusters.json", engine.cluster_summary())
        report = {"mode": "offline" if args.offline else "live", "input_count": len(posts),
                  "processed_count": engine.memory.processed_count, "ignored_count": engine.memory.ignored_count,
                  "batch_count": engine.memory.batch_count, "llm_calls_this_process": engine.extractor.calls,
                  "embedding_requests_this_process": engine.embeddings.request_count,
                  "embedding_cache_hits": engine.embeddings.cache_hits, "prediction": prediction}
        meta_path = args.input.with_suffix(".meta.json")
        if meta_path.exists():
            metadata = json.loads(meta_path.read_text(encoding="utf-8"))
            ground_truth = metadata.get("single_fire_ground_truth")
            if ground_truth:
                predicted_ids = [item["poi_id"] for item in prediction["candidates"]]
                report["synthetic_evaluation"] = {"ground_truth": ground_truth,
                                                   "target_rank": predicted_ids.index(ground_truth["poi_id"])+1 if ground_truth["poi_id"] in predicted_ids else None,
                                                   "note": "仅验证模拟数据流程，不代表实际定位效果。"}
        atomic_json(output/"report.json", report)
        print(json.dumps(report, ensure_ascii=False, indent=2))
    except Exception as error:
        atomic_json(output/"failure.json", {"error_type": type(error).__name__, "processed_count": engine.memory.processed_count,
                                           "pending_count": len(engine.memory.pending), "retry": "修复接口后使用 --resume 重试"})
        # 第三方异常可能包含完整响应，只打印类型及恢复路径。
        raise SystemExit(f"运行失败 ({type(error).__name__})，待处理帖子已保留。检查 API 设置后用 --resume 重试。") from None


if __name__ == "__main__":
    main()

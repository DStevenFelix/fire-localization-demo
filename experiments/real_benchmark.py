"""随机抽不同罐子，逐个用真实 API 回放；不提供离线模式。"""
import argparse
import json
import random
import re
import time
from collections import Counter
from datetime import datetime
from pathlib import Path

from fire_locator.config import Settings
from fire_locator.demo import generate
from fire_locator.engine import FireLocalizer
from fire_locator.models import Post, SHANGHAI
from fire_locator.poi import PoiRepository
from fire_locator.providers import atomic_json


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def analyze(engine, posts, updates, target_id):
    """只用已保存的真实提取结果做诊断，不再次调用模型。"""
    repository = engine.repository
    audits = {detail["post_id"]: detail for batch in updates for detail in batch["posts"]}
    rows = []
    ideal_votes = Counter()
    for index, post in enumerate(posts):
        detail = audits[post.id]
        origin = repository.pois[post.location_poi_id]
        expected_direction = "附近"
        kind = index % 10
        if kind < 6:
            # 模板中明确参照物就是生成时的观察点；移除地名后读取模板里的方向。
            names = [origin.name, *origin.aliases]
            reference = next(iter(sorted((name for name in names if name in post.text), key=len, reverse=True)), None)
            if not reference:
                raise ValueError("无法从模板恢复生成时参照物")
            directional_text = post.text.replace(reference, "")
            match = re.search(r"(东北|西北|东南|西南|东|西|南|北)(?:边|侧|面|方向)", directional_text)
            if not match:
                raise ValueError("无法从模板恢复生成时方向")
            expected_direction = match.group(1)
        ideal_candidates = repository.candidates(origin, expected_direction, engine.settings.radius_m, engine.settings.sector_degrees)
        ideal_votes.update(ideal_candidates)
        rows.append({"post_id": post.id, "text": post.text, "kind": ["named_directional", "vague", "low_urgency", "empty_range"][(0 if kind < 6 else 1 if kind < 8 else 2 if kind == 8 else 3)],
                     "posting_poi_id": post.location_poi_id, "expected_origin_poi_id": origin.id,
                     "expected_origin_name": origin.name, "expected_direction": expected_direction,
                     "extracted_reference": detail["reference"], "extracted_direction": detail["direction"],
                     "resolved_origin_poi_id": detail["origin_poi_id"], "resolved_origin_name": detail["origin_name"],
                     "resolution_reason": detail["reference_resolution"], "match_similarity": detail["match_similarity"],
                     "direction_mismatch": kind < 6 and detail["direction"] != expected_direction,
                     "origin_mismatch": kind < 6 and detail["origin_poi_id"] != origin.id,
                     "actual_candidates": detail["candidate_poi_ids"], "expected_candidates": ideal_candidates,
                     "actual_contains_target": target_id in detail["candidate_poi_ids"],
                     "expected_contains_target": target_id in ideal_candidates})
    scores = Counter()
    votes = Counter()
    for cluster in engine.memory.clusters:
        if not cluster.cold:
            for poi_id, count in cluster.votes.items():
                votes[poi_id] += count
                scores[poi_id] += count*max(0, cluster.confidence)
    ranked = sorted(scores, key=lambda key: (-scores[key], -votes[key], key))
    full_ranking = [{"rank": i+1, "poi_id": key, "name": repository.tanks[key].name,
                     "votes": votes[key], "score": scores[key]} for i, key in enumerate(ranked)]
    ideal_order = sorted(ideal_votes, key=lambda key: (-ideal_votes[key], key))
    named = [row for row in rows if row["kind"] == "named_directional"]
    losses = [row for row in rows if row["expected_contains_target"] and not row["actual_contains_target"]]
    return {"full_ranking": full_ranking, "target_full_rank": ranked.index(target_id)+1 if target_id in ranked else None,
            "target_votes": votes[target_id], "target_candidate_retention": sum(row["actual_contains_target"] for row in rows),
            "named_origin_mismatches": sum(row["origin_mismatch"] for row in named),
            "named_direction_mismatches": sum(row["direction_mismatch"] for row in named),
            "resolution_counts": dict(Counter(row["resolution_reason"] for row in rows)),
            "lost_target_posts": losses, "post_diagnostics": rows,
            "geometry_only_expected_votes": [{"poi_id": key, "name": repository.tanks[key].name, "votes": ideal_votes[key]} for key in ideal_order],
            "geometry_only_expected_target_rank": ideal_order.index(target_id)+1 if target_id in ideal_order else None,
            "note": "geometry_only 是用生成时参照物/方向重算空间范围的诊断，非另一轮离线模型实验。正式实验全部使用真实 API。"}


def write_summary(output, plan, reports):
    complete = [report for report in reports if report["status"] == "completed"]
    summary = {"selection_seed": plan["selection_seed"], "requested_cases": len(plan["cases"]), "completed_cases": len(complete),
               "posts_per_case": plan["posts_per_case"], "total_processed": sum(r["processed_count"] for r in complete),
               "top1_hits": sum(r["top1_hit"] for r in complete), "top3_hits": sum(r["top3_hit"] for r in complete),
               "case_results": reports,
               "method": "固定种子从当前地图独立罐中无放回抽样；每罐独立生成100条模板帖子，独立Memory，真实DeepSeek及SiliconFlow，静态及重复文本向量允许复用真实编码缓存。"}
    atomic_json(output/"summary.json", summary)
    lines = ["本次随机罐体真实 API 实验", "", f"抽样种子：{plan['selection_seed']}。每罐 {plan['posts_per_case']} 条，当前完成 {len(complete)}/{len(plan['cases'])} 个实验。",
             f"第一名命中 {summary['top1_hits']}/{len(complete)}，前三名命中 {summary['top3_hits']}/{len(complete)}。", "",
             "| 真实着火罐 | POI ID | 预测前三 | 真值完整排名 | 第一名命中 | 前三名命中 |", "|---|---|---|---:|---|---|"]
    for report in reports:
        if report["status"] != "completed":
            lines.append(f"| {report['target_name']} | {report['target_id']} | 执行失败：{report['error_type']} | — | — | — |")
        else:
            lines.append(f"| {report['target_name']} | {report['target_id']} | {'、'.join(report['top3_names'])} | {report['target_full_rank']} | {'是' if report['top1_hit'] else '否'} | {'是' if report['top3_hit'] else '否'} |")
    lines += ["", "每个罐目录保留 posts.jsonl、posts.meta.json、batch_results.json、memory.json、prediction.json、report.json、diagnostics.json。真实标签只用于生成与事后评价，不进入提取提示词。",
              "数据由几何规则选取能覆盖目标的观察点，并用模板生成，因此这些命中率仅描述本次合成数据，不能外推为实际社交帖子定位准确率。"]
    (output/"report.md").write_text("\n".join(lines)+"\n", encoding="utf-8")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection-seed", type=int, default=20261023)
    parser.add_argument("--cases", type=int, default=8)
    parser.add_argument("--posts-per-case", type=int, default=100)
    parser.add_argument("--output-dir", type=Path, default=Path("runtime/benchmarks/20261023_8tanks_seed20261023"))
    parser.add_argument("--prepare-only", action="store_true", help="只固定抽样并生成输入，不启动API")
    parser.add_argument("--resume", action="store_true", help="保留已完成实验，并恢复未完成批次")
    args = parser.parse_args()
    settings = Settings.load()
    repository = PoiRepository(settings.root)
    if not 1 <= args.cases <= len(repository.tanks) or args.posts_per_case <= 0:
        raise ValueError("实验数或帖子数无效")
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    selected = random.Random(args.selection_seed).sample(sorted(repository.tanks), args.cases)
    plan = {"selection_seed": args.selection_seed, "posts_per_case": args.posts_per_case,
            "mode": "live", "deepseek_model": settings.deepseek_model, "embedding_model": settings.embedding_model,
            "poi_fingerprint": repository.fingerprint,
            "cases": [{"target_id": target_id, "target_name": repository.tanks[target_id].name,
                       "post_seed": args.selection_seed*100+i} for i, target_id in enumerate(selected)]}
    plan_path = output/"plan.json"
    if plan_path.exists() and read_json(plan_path) != plan:
        raise ValueError("已有计划不一致，请选新的结果目录")
    atomic_json(plan_path, plan)
    for case in plan["cases"]:
        case_dir = output/case["target_id"]
        generate(repository, case_dir/"posts.jsonl", args.posts_per_case, case["post_seed"], case["target_id"])
    print("Selected:", ", ".join(f"{case['target_name']}({case['target_id']})" for case in plan["cases"]), flush=True)
    if args.prepare_only:
        return
    reports = []
    for index, case in enumerate(plan["cases"], 1):
        case_dir = output/case["target_id"]
        report_path = case_dir/"report.json"
        if args.resume and report_path.exists() and read_json(report_path).get("status") == "completed":
            reports.append(read_json(report_path))
            write_summary(output, plan, reports)
            print(f"Case {index}/{len(selected)} {case['target_name']}: already completed", flush=True)
            continue
        if not args.resume and (case_dir/"memory.json").exists():
            raise ValueError("结果目录已有实验状态，继续请加 --resume 或换目录")
        started = time.perf_counter()
        engine = None
        updates = read_json(case_dir/"batch_results.json") if args.resume and (case_dir/"batch_results.json").exists() else []
        try:
            engine = FireLocalizer(settings, offline=False, state_path=case_dir/"memory.json", resume=args.resume)
            assert not engine.offline and engine.embeddings.model == settings.embedding_model
            posts = [Post.model_validate(json.loads(line)) for line in (case_dir/"posts.jsonl").read_text(encoding="utf-8").splitlines()]
            for start in range(0, len(posts), settings.batch_size):
                response = engine.ingest(posts[start:start+settings.batch_size], flush=True)
                updates.extend(response["updates"])
                atomic_json(case_dir/"batch_results.json", updates)
                for batch in response["updates"]:
                    top = batch["prediction"]["candidates"]
                    print(f"Case {index}/{len(selected)} {case['target_name']} batch {batch['batch_number']}: top1={top[0]['name'] if top else 'none'}", flush=True)
            if engine.memory.processed_count != len(posts) or len({p['post_id'] for b in updates for p in b['posts']}) != len(posts):
                raise ValueError("处理数或审计记录不完整")
            prediction = engine.prediction()
            diagnosis = analyze(engine, posts, updates, case["target_id"])
            ids = [item["poi_id"] for item in prediction["candidates"]]
            report = {**case, "status": "completed", "mode": "live", "processed_count": engine.memory.processed_count,
                      "ignored_count": engine.memory.ignored_count, "batch_count": engine.memory.batch_count,
                      "llm_calls_this_process": engine.extractor.calls,
                      "embedding_requests_this_process": engine.embeddings.request_count,
                      "embedding_cache_hits": engine.embeddings.cache_hits,
                      "duration_seconds": round(time.perf_counter()-started, 2),
                      "top3_ids": ids, "top3_names": [item["name"] for item in prediction["candidates"]],
                      "top1_hit": bool(ids) and ids[0] == case["target_id"], "top3_hit": case["target_id"] in ids,
                      "target_full_rank": diagnosis["target_full_rank"], "target_votes": diagnosis["target_votes"],
                      "named_origin_mismatches": diagnosis["named_origin_mismatches"],
                      "named_direction_mismatches": diagnosis["named_direction_mismatches"],
                      "lost_target_posts": len(diagnosis["lost_target_posts"]),
                      "geometry_only_expected_target_rank": diagnosis["geometry_only_expected_target_rank"]}
            atomic_json(case_dir/"prediction.json", prediction)
            atomic_json(case_dir/"clusters.json", engine.cluster_summary())
            atomic_json(case_dir/"diagnostics.json", diagnosis)
            atomic_json(report_path, report)
            print(f"RESULT {case['target_name']}: rank={report['target_full_rank']} top1={report['top1_hit']} top3={report['top3_hit']}", flush=True)
        except Exception as error:
            report = {**case, "status": "failed", "error_type": type(error).__name__,
                      "processed_count": engine.memory.processed_count if engine else 0,
                      "pending_count": len(engine.memory.pending) if engine else 0}
            atomic_json(case_dir/"failure.json", report)
            print(f"FAILED {case['target_name']}: {type(error).__name__}, state preserved", flush=True)
        finally:
            if engine:
                engine.embeddings.client.close()
        reports.append(report)
        summary = write_summary(output, plan, reports)
    print(json.dumps({k: summary[k] for k in ("completed_cases", "total_processed", "top1_hits", "top3_hits")}, ensure_ascii=False), flush=True)
    if summary["completed_cases"] != len(selected):
        raise SystemExit(1)


if __name__ == "__main__":
    main()

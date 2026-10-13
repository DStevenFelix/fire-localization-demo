"""读取真实实验日志，生成诊断报告；不调用模型，不改定位算法。"""
import argparse
import json
from collections import Counter
from pathlib import Path

from fire_locator.providers import atomic_json


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path("runtime/benchmarks/20261008_10tanks_seed20261008"))
    args = parser.parse_args()
    root = args.output_dir
    summary = read(root/"summary.json")
    if summary["completed_cases"] != summary["requested_cases"]:
        raise ValueError("请先完成全部真实实验")
    details = []
    for report in summary["case_results"]:
        directory = root/report["target_id"]
        diagnosis = read(directory/"diagnostics.json")
        batches = read(directory/"batch_results.json")
        clusters = read(directory/"clusters.json")
        target = next(row for row in diagnosis["full_ranking"] if row["poi_id"] == report["target_id"])
        top = diagnosis["full_ranking"][0]
        tied = [row for row in diagnosis["full_ranking"] if abs(row["score"]-target["score"]) < 1e-9 and row["votes"] == target["votes"]]
        counts = Counter(diagnosis["resolution_counts"])
        first_wrong = [batch for batch in batches if not batch["prediction"]["candidates"] or batch["prediction"]["candidates"][0]["poi_id"] != report["target_id"]]
        same_geometry = sum(report["target_id"] in row["expected_candidates"] and top["poi_id"] in row["expected_candidates"] for row in diagnosis["post_diagnostics"])
        item = {**report, "top1_name": top["name"], "top1_votes": top["votes"], "target_score": target["score"],
                "top1_score": top["score"], "tie_with_target": tied, "early_top1_miss_batches": [b["batch_number"] for b in first_wrong],
                "active_clusters": len([cluster for cluster in clusters if not cluster["cold"]]),
                "cluster_confidences": [cluster["confidence"] for cluster in clusters],
                "resolution_counts": dict(counts), "top1_and_target_geometry_cocoverage": same_geometry}
        details.append(item)
    metrics = {"case_count": len(details), "total_posts": sum(r["processed_count"] for r in details),
               "top1_hits": sum(r["top1_hit"] for r in details), "top3_hits": sum(r["top3_hit"] for r in details),
               "batch_extraction_calls": sum(r["llm_calls_this_process"] for r in details),
               "embedding_http_requests": sum(r["embedding_requests_this_process"] for r in details),
               "ignored_posts": sum(r["ignored_count"] for r in details),
               "named_origin_mismatches": sum(r["named_origin_mismatches"] for r in details),
               "named_direction_mismatches": sum(r["named_direction_mismatches"] for r in details),
               "lost_target_posts": sum(r["lost_target_posts"] for r in details),
               "intermediate_top1_hits": sum(10-len(r["early_top1_miss_batches"]) for r in details),
               "results": details}
    atomic_json(root/"analysis.json", metrics)
    lines = ["真实 API 实验诊断", "",
             f"随机抽样种子 {summary['selection_seed']}，10 个不同罐子，每罐 100 条帖子，共 {metrics['total_posts']} 条。",
             f"最终第一名命中 {metrics['top1_hits']}/10，最终前三命中 {metrics['top3_hits']}/10。共 {metrics['batch_extraction_calls']} 次批量提取调用、{metrics['embedding_http_requests']} 次编码 HTTP 请求；其余重复文本复用真实模型编码缓存。",
             "提取调用数按 chain.invoke 计，SDK 内部 HTTP 重试不单独计入此数。", "",
             "| 真实着火罐 | 预测第一名 | 真值排名 | 真值票数/第一名票数 | 首名未命中的批次 | 参照物偏离/方向偏离 |", "|---|---|---:|---|---|---|"]
    for r in details:
        lines.append(f"| {r['target_name']} | {r['top1_name']} | {r['target_full_rank']} | {r['target_votes']}/{r['top1_votes']} | {','.join(map(str,r['early_top1_miss_batches'])) or '无'} | {r['named_origin_mismatches']}/{r['named_direction_mismatches']} |")
    lines += ["", f"600 条带名称和方向的帖子中，解析后参照原点偏离生成时原点 {metrics['named_origin_mismatches']} 条，方向偏离 {metrics['named_direction_mismatches']} 条。按生成时范围应包含真值、处理后却丢失真值的帖子共 {metrics['lost_target_posts']} 条。", ""]
    for r in details:
        if r["top1_hit"]:
            continue
        lines += [f"失败个案：{r['target_name']}（{r['target_id']}）", "",
                  f"预测前三：{'、'.join(r['top3_names'])}。真值第 {r['target_full_rank']}，仍进入前三。",
                  f"第一名 {r['top1_name']} {r['top1_votes']} 票，真值 {r['target_votes']} 票；分数分别为 {r['top1_score']:.9f} 和 {r['target_score']:.9f}。",
                  f"活跃簇 {r['active_clusters']} 个，簇内一致性 {r['cluster_confidences']}。",
                  f"将模型解析结果替换成生成时明确的原点与方向，仅重算几何投票时，真值排名仍是 {r['geometry_only_expected_target_rank']}。本次几何诊断有 {r['top1_and_target_geometry_cocoverage']} 条帖子同时覆盖第一名与真值。"]
        if len(r["tie_with_target"]) > 1:
            lines += [f"与真值同分同票的罐：{'、'.join(row['name'] for row in r['tie_with_target'])}。",
                      "这些罐落在相同帖子对应的圆或扇形范围内，得到相同票数；同簇共用一致性权重，仍无法区分。当前代码在分数和票数并列时按 POI ID 排序，因此 ID 在前的罐排在第一。",
                      "这条证据支持本例的主要原因是空间候选及投票信息不足，且排序没有显式表达并列不确定性。"]
        lines.append("")
    early_only = [r for r in details if r["top1_hit"] and r["early_top1_miss_batches"]]
    for r in early_only:
        lines += [f"中途偏差：{r['target_name']}在批次 {r['early_top1_miss_batches']} 首名未命中，后续累积帖子后最终恢复第一名。可检查该目录 batch_results.json 对应批次的分数和票数。", ""]
    lines += ["评价边界：这些帖子由几何规则先选能覆盖目标的观察点，再套有限模板生成；低紧急度及模糊帖子也来自这些观察点。该构造对目标十分有利，报告中的命中率仅说明本次合成实验，不是实际社交帖子的泛化准确率。",
              "每个实验仅一只罐子着火，独立 Memory；真实标签只用于生成及事后评价，不加入模型提示词。"]
    (root/"analysis.md").write_text("\n".join(lines)+"\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in metrics.items() if key != "results"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

"""Curated offline evaluation and bounded-stream benchmark; no trained model or API is used.

Corpus is separate from unit tests, manually labeled, and intentionally tiny/artificial.
Reported precision/recall describe this corpus only, never real urban social-media accuracy.
"""
import argparse
from datetime import UTC, datetime
import json
from pathlib import Path
import time
import tracemalloc

from app.event_discovery import CATEGORY_LABELS, EventDiscovery, MONITOR_CATEGORIES, classify_text
from app.models import ChatMessage, Point


def evaluate(count):
    path=Path(__file__).with_name("fixtures")/"discovery_eval.jsonl"
    corpus=[json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    measurements={category:dict(tp=0,fp=0,fn=0,gold=0) for category in CATEGORY_LABELS}
    mismatches=[];candidates=forwarded=all_chars=sent_chars=0
    for row in corpus:
        actual=set(classify_text(row["text"])[0]);gold=set(row["labels"])
        candidates+=bool(actual);all_chars+=len(row["text"])
        if actual & MONITOR_CATEGORIES:
            forwarded+=1;sent_chars+=len(row["text"])
        if actual!=gold:mismatches.append(dict(text=row["text"],gold=sorted(gold),actual=sorted(actual)))
        for category,m in measurements.items():
            m["tp"]+=category in actual and category in gold
            m["fp"]+=category in actual and category not in gold
            m["fn"]+=category not in actual and category in gold
            m["gold"]+=category in gold
    for m in measurements.values():
        m["precision"]=round(m["tp"]/(m["tp"]+m["fp"]),4) if m["tp"]+m["fp"] else None
        m["recall"]=round(m["tp"]/(m["tp"]+m["fn"]),4) if m["tp"]+m["fn"] else None
    # Public projection contains no fire/topic/evidence tags. Constant-sized batches and a
    # moving 15-minute window isolate discovery's working memory from complete DB history.
    engine=EventDiscovery();timestamp=datetime(2026,1,1,tzinfo=UTC);batch_size=100
    peaks=[];max_window=0;start=time.perf_counter();tracemalloc.start()
    for offset in range(0,count,batch_size):
        minute=offset//batch_size+1
        batch=[ChatMessage(id=f"offline-{i}",sequence=i+1,timestamp=timestamp,simulation_minute=minute,
                  resident_id=f"author-{i%500}",resident_name="离线居民",building_id="offline",building_name="离线住宅",
                  unit="101",position=Point(x=1,y=1),community_id=f"community-{i%10}",
                  content=corpus[i%len(corpus)]["text"]) for i in range(offset,min(count,offset+batch_size))]
        engine.scan(batch,[],minute,{})
        max_window=max(max_window,len(engine._window))
        if (offset+batch_size)%5000==0 or offset+batch_size>=count:
            current,peak=tracemalloc.get_traced_memory()
            peaks.append(dict(messages=min(count,offset+batch_size),current_bytes=current,peak_bytes=peak))
    elapsed=time.perf_counter()-start;_,peak=tracemalloc.get_traced_memory();tracemalloc.stop()
    return dict(caveat="独立人工离线小集；候选比例、精确率和召回率均不代表真实城市数据；含tracemalloc开销。",
                corpus=str(path),corpus_size=len(corpus),per_category=measurements,mismatches=mismatches,
                candidate_ratio=round(candidates/len(corpus),4),monitor_post_ratio=round(forwarded/len(corpus),4),
                monitor_body_character_reduction=round(1-sent_chars/all_chars,4),
                reduction_scope="仅候选原帖字符，独立单帖无回复上下文；不含固定提示词/输出或token/费用估计。",
                benchmark=dict(messages=count,seconds=round(elapsed,3),posts_per_second=round(count/elapsed),
                               peak_bytes=peak,memory_samples=peaks,max_window_entries=max_window,
                               retained_candidates=len(engine.state.recent_candidates)))


if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--messages",type=int,default=20000)
    parser.add_argument("--output",type=Path)
    args=parser.parse_args()
    if args.messages<=0:parser.error("--messages must be positive")
    result=evaluate(args.messages);body=json.dumps(result,ensure_ascii=False,indent=2)
    if args.output:args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(body+"\n")
    print(body)

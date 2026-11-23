"""Local discovery: handwritten public examples, routing and durable lifecycle. No model calls."""
import asyncio
from copy import deepcopy
from datetime import UTC, datetime
import json

from fastapi.testclient import TestClient
from langchain_core.runnables import RunnableLambda
import pytest

from app.event_discovery import (EventDiscovery,
                                 PublicPost, classify_post, classify_text, monitor_context)
from app.models import ChatMessage, FirePolicy, Point
from app.simulation import SimulationEngine
from app.storage import SimulationStore
from test_persistence import install


def post(text, sequence=1, **changes):
    values = dict(id=f"public-{sequence}", sequence=sequence, timestamp=datetime(2026, 1, 1, tzinfo=UTC),
                  simulation_minute=5, resident_id=f"resident-{sequence}", resident_name="测试居民",
                  building_id="B-W-01", building_name="锦安社区1号楼", unit="101", position=Point(x=2, y=16),
                  content=text, community_id="A-WEST")
    values.update(changes)
    return ChatMessage(**values)


@pytest.mark.parametrize("category,positive,negative", [
    ("fire", "好像闻到一点焦味，来源不确定", "没看到明火，也没有闻到烟味"),
    ("gas", "楼下有股煤气味，疑似燃气泄漏", "燃气没有泄漏"),
    ("traffic", "路口电动车撞到了行人", "厨艺翻车了，大家别笑"),
    ("flood", "雨停了但是地下车库积水已经到膝盖", "昨晚在看洪水纪录片"),
    ("facility", "墙上突然出现裂缝，电梯也坏了", "课本讲了桥梁坍塌的例子"),
    ("security", "有人正在撬门，听到邻居在喊", "电影里面有人持刀抢劫"),
    ("rescue", "老人摔倒了，急需救护车", "明天演练，有人被困需要救护车"),
])
def test_seven_categories_manual_examples(category, positive, negative):
    assert category in classify_text(positive)[0]
    assert category not in classify_text(negative)[0]


@pytest.mark.parametrize("text,expected", [
    ("没看到明火，但楼道浓烟很大", {"fire"}),
    ("不确定是否起火，听邻居说有烟味", {"fire"}),
    ("电影里起火了。楼下有浓烟往外冒！", {"fire"}),
    ("昨天发生火灾，现在楼道又冒烟了", {"fire"}),
    ("预定消防演练，楼道会冒烟，请勿惊慌", set()),
    ("我们讨论怎么预防火灾", set()),
    ("油烟机开着，炒菜有点糊味", set()),
    ("做饭时锅起火了，楼道全是浓烟", {"fire"}),
    ("消防演练结束，但真的闻到煤气味了", {"gas"}),
    ("燃气没有泄漏，电梯没有故障", set()),
    ("燃气没有明显异味", set()),
    ("不排除天然气泄漏", {"gas"}),
    ("路口没有井盖，非常危险", {"facility"}),
    ("井盖不见了", {"facility"}),
    ("信号灯不亮了", {"traffic", "facility"}),
    ("听说积水中电线漏电，有人被困", {"flood", "facility", "rescue"}),
    ("发生车祸后车起火，有人受伤", {"traffic", "fire", "rescue"}),
    ("禁止明火，预防火灾", set()),
    ("单元门口有人持刀", {"security"}),
    ("我没看见有人打架", set()),
    ("没有明火有浓烟", {"fire"}),
    ("安全培训讨论了盗窃", set()),
    ("刚才笑死我了，考试翻车", set()),
    ("救命这也太好笑了", set()),
    ("今天要燃烧卡路里", set()),
    ("好笑的节目还没看完就有人被困，救命", {"rescue"}),
    ("午饭准备吃火锅", set()),
])
def test_clause_context_and_mixed_risks(text, expected):
    assert set(classify_text(text)[0]) == expected


def test_public_projection_and_hidden_labels_cannot_change_discovery():
    original = post("楼道里有一点焦味，不知道来源")
    changed = original.model_copy(update=dict(fire_id="secret", topic="fire", topic_key="hidden",
        evidence_signals=["flame"], evidence_quotes={"flame":"HIDDEN"}, evidence_source="direct",
        position=Point(x=80,y=70), expression_kind="detailed"))
    assert PublicPost.from_message(original) == PublicPost.from_message(changed)
    assert classify_post(PublicPost.from_message(original)) == classify_post(PublicPost.from_message(changed))
    ordinary = post("晚饭吃什么", 2, fire_id="fire-truth", topic="fire", evidence_signals=["flame"])
    assert not classify_post(PublicPost.from_message(ordinary))[0]


def test_reply_ellipsis_keeps_hearsay_and_never_invents_independent_witness():
    parent = post("听说小区门口有煤气味")
    reply = post("具体在哪里？我还没核实", 2, reply_to_id=parent.id, reply_quote=parent.content)
    found, flags, reasons = classify_post(PublicPost.from_message(reply), PublicPost.from_message(parent))
    assert set(found) == {"gas"}
    assert set(flags) >= {"contextual_reply", "hearsay"}
    assert reasons[0].source_message_id == parent.id and reasons[0].excerpt in parent.content
    for text in ("谢谢提醒", "收到", "已经没有了", "不是那个情况"):
        child = reply.model_copy(update={"content":text})
        assert not classify_post(PublicPost.from_message(child), PublicPost.from_message(parent))[0]
    # Parent can leave the in-memory window; its public quote is still permitted.
    assert classify_post(PublicPost.from_message(reply))[0] == found
    assert "hearsay" in classify_text("朋友说楼下有浓烟")[1]


def test_window_duplicate_counts_independent_communities_and_idempotence():
    discovery = EventDiscovery()
    messages = [post("路口积水很深",1), post("路口积水很深",2,community_id="A-EAST"),
                post("昨晚看了电影",3)]
    records = discovery.scan(messages + [messages[0]], [], 5, {})
    assert len(records) == 2 and all(r.categories == ["flood"] for r in records)
    stats = next(s for s in discovery.state.window_stats if s.category == "flood")
    assert (stats.candidate_count,stats.author_count,stats.community_count,stats.duplicate_count) == (2,2,2,1)
    # Same category across communities stays two post records, with no incident ID or inferred coordinates.
    assert "event_id" not in records[0].model_dump() and "position" not in records[0].model_dump()
    assert discovery.scan(messages, [], 10, {}) == []
    restored = EventDiscovery.restore(discovery.checkpoint())
    assert restored.checkpoint() == discovery.checkpoint()
    restored.scan([], [], 20, {})
    assert not restored._window and all(s.candidate_count == 0 for s in restored.state.window_stats)
    assert restored.state.candidate_total == 2


def test_recent_window_is_50_but_full_batch_available_for_storage():
    discovery = EventDiscovery()
    rows = discovery.scan([post("路口积水了", i) for i in range(1,101)], [],5,{})
    assert len(rows)==100 and len(discovery.state.recent_candidates)==50
    assert discovery.state.scanned_total==discovery.state.candidate_total==100
    assert discovery.state.recent_candidates[0].sequence==51
    assert len(EventDiscovery.restore(discovery.checkpoint()).state.recent_candidates)==50
    legacy = EventDiscovery.restore(None,minute=60,sequence=150)
    assert not legacy.scan([post("起火了",i) for i in range(1,151)],[],60,{})
    assert legacy.state.started_minute==60 and legacy.state.started_sequence==150


def test_monitor_context_parent_priority_limit_and_same_community():
    parents=[post("这里是现场位置",i) for i in range(1,41)]
    candidates=[post("在哪里？",100+i,reply_to_id=p.id) for i,p in enumerate(parents)]
    unrelated=post("无关社区",50,community_id="A-EAST")
    context=monitor_context(candidates,[*parents,unrelated],[])
    assert len(context)==32 and [m.id for m in context]==[m.id for m in parents[:32]]
    assert not set(m.id for m in context)&set(m.id for m in candidates)


def inject_batch(monkeypatch, engine, texts):
    async def generate(community, fire):
        if community.id != engine.communities[0].id:
            return []
        return [post(text, i+1, id=f"minute-{engine.simulation_minute}-{i}",
                     simulation_minute=engine.simulation_minute, community_id=community.id,
                     resident_id=engine.residents[0].id, building_id=engine.residents[0].building_id)
                for i,text in enumerate(texts)]
    monkeypatch.setattr(engine,"_community_tick",generate)


def test_nonfire_categories_skip_monitor_and_never_enqueue_locator(monkeypatch):
    engine=SimulationEngine(fire_policy=FirePolicy(base_probability=0))
    inject_batch(monkeypatch,engine,["车祸有人受伤", "路面积水", "有人撬门", "墙体开裂", "晚饭吃什么"])
    engine.monitor.chain=RunnableLambda(lambda _:pytest.fail("Non-fire discovery called monitor"))
    asyncio.run(engine.tick())
    assert engine.simulation_minute==5 and not engine.generation_error
    state=engine.discovery.state
    assert (state.scanned_total,state.candidate_total,state.forwarded_total,state.skipped_monitor_steps)==(5,4,0,1)
    assert not engine.reports and not engine.localization_outbox


def test_fire_candidates_only_with_bounded_public_context(monkeypatch):
    engine=SimulationEngine(fire_policy=FirePolicy(base_probability=0))
    engine.chats=[post("现场在这里",i) for i in range(1,45)]
    engine._message_sequence=44
    inject_batch(monkeypatch,engine,["今晚吃什么", "煤气味很重", "车库积水了", "楼道浓烟很大"])
    calls=[]
    engine.monitor.chain=RunnableLambda(lambda values:calls.append(deepcopy(values)) or '{"events": []}')
    asyncio.run(engine.tick())
    assert not engine.generation_error and len(calls)==1
    new=json.loads(calls[0]["new_messages"])
    assert {m["content"] for m in new}=={"煤气味很重","楼道浓烟很大"}
    assert len(json.loads(calls[0]["history"]))<=32
    assert engine.discovery.state.forwarded_total==2 and not engine.localization_outbox


def test_failed_monitor_discards_provisional_records_and_progress(monkeypatch):
    engine=SimulationEngine(fire_policy=FirePolicy(base_probability=0))
    inject_batch(monkeypatch,engine,["楼道浓烟", "路口积水"])
    before=engine.checkpoint()
    engine.monitor.chain=RunnableLambda(lambda _:"invalid JSON")
    asyncio.run(engine.tick())
    assert engine.generation_error.agent_role=="monitor" and engine.simulation_minute==0
    for key in ("discovery","discovery_pending","message_sequence","observations","fire_random","agent_random"):
        assert engine.checkpoint()[key]==before[key]
    assert not engine.chats and not engine.reports and not engine.localization_outbox


def test_history_api_restart_pagination_filter_switch_delete(monkeypatch,tmp_path):
    main=install(monkeypatch,tmp_path)
    main.engine.fire_policy=FirePolicy(base_probability=0)
    inject_batch(monkeypatch,main.engine,["路口积水", "墙体开裂", "车祸有人受伤", "晚饭吃什么"])
    with TestClient(main.app) as client:
        for _ in range(17):
            result=client.post("/api/simulation",json={"action":"step"})
            assert result.status_code==200,result.text
        state=client.get("/api/state").json();run=state["persistence"]["run_id"]
        assert state["discovery"]["candidate_total"]==51 and len(state["discovery"]["recent_candidates"])==50
        assert main.store.connection.execute("SELECT count(*) FROM discovery_posts").fetchone()[0]==51
        # Saving the same pending batch repeatedly is idempotent.
        main.store.save(run,main.engine.checkpoint(),main.localization.checkpoint())
        assert main.store.connection.execute("SELECT count(*) FROM discovery_posts").fetchone()[0]==51
        rows=[];cursor=None
        while True:
            params={"run_id":run,"limit":8}
            if cursor:params["before"]=cursor
            page=client.get("/api/discovery",params=params).json()
            rows+=page["items"]
            if not page["has_more"]:break
            cursor=page["next_before"]
        assert len(rows)==len({r["message_id"] for r in rows})==51
        filtered=client.get("/api/discovery?category=rescue&community_id=A-WEST&limit=200").json()["items"]
        assert len(filtered)==17 and all("rescue" in r["categories"] for r in filtered)
        assert client.get("/api/discovery?category=invalid").status_code==422
        assert client.get("/api/discovery?limit=0").status_code==422
        assert client.get("/api/discovery?community_id=missing").status_code==404
        blank=client.post("/api/simulation",json={"action":"reset"}).json()
        new=blank["persistence"]["run_id"]
        assert blank["discovery"]["scanned_total"]==0
        assert client.get("/api/discovery",params={"run_id":run}).status_code==409
        assert client.get("/api/discovery").json()["items"]==[]
        # Reuse the same public IDs in a new run: histories must stay isolated.
        assert client.post("/api/simulation",json={"action":"step"}).status_code==200
        assert len(client.get("/api/discovery").json()["items"])==3
        loaded=client.post(f"/api/runs/{run}/activate",json={"expected_run_id":new})
        assert loaded.status_code==200,loaded.text
        assert loaded.json()["discovery"]==state["discovery"]
        assert len(client.get("/api/discovery?limit=200").json()["items"])==51
    main=install(monkeypatch,tmp_path)
    with TestClient(main.app) as client:
        restored=client.get("/api/state").json()
        assert restored["discovery"]==state["discovery"]
        assert len(client.get("/api/discovery?limit=200").json()["items"])==51
        assert client.post(f"/api/runs/{new}/activate",json={"expected_run_id":run}).status_code==200
        assert client.get("/api/state").json()["discovery"]["candidate_total"]==3
        archived=client.delete(f"/api/runs/{run}",params={"expected_run_id":new})
        assert archived.status_code==200 and archived.json()["state"] is None
        assert len(client.get("/api/discovery").json()["items"])==3
        deleted=client.delete(f"/api/runs/{new}",params={"expected_run_id":new})
        assert deleted.status_code==200,deleted.text
        assert deleted.json()["state"]["discovery"]["candidate_total"]==0
        for table in ("discovery_posts","discovery_categories"):
            assert main.store.connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]==0


def test_full_single_batch_over_50_is_saved_without_using_display_window(monkeypatch,tmp_path):
    main=install(monkeypatch,tmp_path)
    main.engine.fire_policy=FirePolicy(base_probability=0)
    inject_batch(monkeypatch,main.engine,["路口积水" for _ in range(100)])
    with TestClient(main.app) as client:
        result=client.post("/api/simulation",json={"action":"step"})
        assert result.status_code==200,result.text
        assert len(result.json()["discovery"]["recent_candidates"])==50
        records=client.get("/api/discovery?limit=200").json()["items"]
        assert len(records)==100 and records[0]["sequence"]==1


def test_save_failure_and_discovery_sql_error_are_atomic(monkeypatch,tmp_path):
    main=install(monkeypatch,tmp_path)
    main.engine.fire_policy=FirePolicy(base_probability=0)
    inject_batch(monkeypatch,main.engine,["路口积水了"])
    with TestClient(main.app) as client:
        before=main.engine.discovery.checkpoint()
        main.store.connection.execute("CREATE TRIGGER reject_discovery BEFORE INSERT ON discovery_posts BEGIN SELECT RAISE(ABORT,'test'); END")
        response=client.post("/api/simulation",json={"action":"step"})
        assert response.status_code==503
        assert main.engine.discovery.checkpoint()==before
        assert main.engine.simulation_minute==0 and main.engine.chats==[]
        assert main.store.load()["engine"]["state"]["discovery"]["candidate_total"]==0
        assert main.store.connection.execute("SELECT count(*) FROM messages").fetchone()[0]==0
        assert main.store.connection.execute("SELECT count(*) FROM discovery_posts").fetchone()[0]==0


def test_schema3_upgrade_never_backfills_and_legacy_checkpoint_starts_here(tmp_path):
    path=tmp_path/"legacy.sqlite3"
    store=SimulationStore(path)
    from app.localization import LocalizationService
    from test_persistence import factory
    engine=SimulationEngine(fire_policy=FirePolicy(base_probability=1))
    asyncio.run(engine.tick())
    old=engine.checkpoint()
    for key in ("discovery","discovery_pending"):old.pop(key)
    old["state"].pop("discovery")
    service=LocalizationService(factory,tmp_path/"cache")
    run=service.state.session_id
    store.create(run,old,service.checkpoint())
    store.connection.executescript("DROP TABLE discovery_categories; DROP TABLE discovery_posts; PRAGMA user_version=3;")
    store.close()
    upgraded=SimulationStore(path)
    try:
        assert upgraded.connection.execute("PRAGMA user_version").fetchone()[0]==4
        assert upgraded.discovery_history(run)["items"]==[]
        engine.restore(upgraded.load()["engine"])
        assert engine.discovery.state.started_sequence==engine._message_sequence==30
        assert engine.discovery.state.started_minute==5 and engine.discovery.state.scanned_total==0
        asyncio.run(engine.tick())
        upgraded.save(run,engine.checkpoint(),service.checkpoint())
        assert engine.discovery.state.scanned_total==30
        assert all(r["sequence"]>30 for r in upgraded.discovery_history(run)["items"])
    finally:upgraded.close()

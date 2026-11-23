"""Explicit browser-only mixed public feed; never imported by production resident generation."""
from datetime import UTC, datetime
from mock_server import app, main, control
from app.models import ChatMessage

original_tick = main.engine._community_tick
EXAMPLES = ["疑似有一股焦味，来源还不确定", "听说楼下煤气味很重", "路口车辆追尾了",
            "地下通道积水到膝盖", "门口井盖不见了", "有人正在撬门", "老人摔倒需要急救"]


async def mixed_tick(community, fire):
    if control["mode"] != "discovery_mixed":
        return await original_tick(community, fire)
    index = next(i for i,c in enumerate(main.engine.communities) if c.id == community.id)
    resident = next(r for r in main.engine.residents if r.community_id == community.id)
    building = main.engine._entity_by_id[resident.building_id]
    minute = main.engine.simulation_minute
    base = dict(timestamp=datetime.now(UTC), simulation_minute=minute, resident_id=resident.id,
                resident_name=resident.name, building_id=building.id, building_name=building.name,
                unit=resident.unit, position=resident.position, community_id=community.id)
    first = ChatMessage(**base, id=f"mixed-{minute}-{community.id}",
                        content=EXAMPLES[index % 7] + ' <img src=x onerror="window.BAD=1">')
    reply = ChatMessage(**base, id=first.id+"-reply", content="具体在哪里？我还没核实",
                        reply_to_id=first.id, reply_quote=first.content)
    daily = ChatMessage(**base, id=first.id+"-daily", content="明天大家去散步吗")
    return [first,reply,daily]


main.engine._community_tick = mixed_tick


@app.post("/_test/discovery")
async def mixed_mode():
    control.update(mode="discovery_mixed", calls=0, monitor_calls=0)
    return control

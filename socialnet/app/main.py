# FastAPI 入口与运行协调：加载环境、恢复存档、管理仿真循环、HTTP 接口和 WebSocket。
# 控制操作在仿真锁内提交，保存成功后发布状态；后台定位通过独立回调保存和通知。

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from datetime import datetime
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .models import ActivateRunRequest, DiscoveryCategory, FirePolicy, PersistenceState, SimulationCommand, SimulationState, SocketEvent
from .simulation import SimulationEngine
from .localization import LocalizationService
from .spatial import CITY_ROOT, DATA_ROOT, ROOT
from .storage import RunConflict, SimulationStore, StorageError

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(ENV_FILE)
logger = logging.getLogger("uvicorn.error")
STATIC_DIR = Path(__file__).parent / "static"


# 维护当前 WebSocket 连接集合，向页面广播已确认的业务更新。
class ConnectionManager:
    def __init__(self) -> None:
        self.connections: set[WebSocket] = set()

    # 接受握手后登记连接，初始业务状态由 WebSocket 入口发送。
    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.connections.add(websocket)

    # 幂等移除连接，供主动断开及广播失败清理使用。
    def disconnect(self, websocket: WebSocket) -> None:
        self.connections.discard(websocket)

    # 序列化事件并逐连接发送，清除发送失败的连接。
    async def broadcast(self, event: SocketEvent) -> None:
        stale: list[WebSocket] = []
        payload = event.model_dump(mode="json")
        for connection in tuple(self.connections):
            try:
                await connection.send_json(payload)
            except Exception:
                stale.append(connection)
        for connection in stale:
            self.disconnect(connection)


# 这些单例在导入时建立；数据库及循环到 lifespan 才打开，不要通过导入来启动第二个写入者。
engine = SimulationEngine()
connections = ConnectionManager()
localization = LocalizationService()
store: SimulationStore | None = None
persistence = PersistenceState()
_saved_engine = None
_saved_localization = None
_transition = False
_cleanup_lock = None


# 合并仿真、定位和持久化状态；调用者根据场景决定是否持有仿真锁。
def snapshot():
    return engine.snapshot().model_copy(update={"localization": localization.snapshot(),
                                              "persistence": persistence.model_copy(deep=True)})


# 把已成功生成的 outbox 转交定位队列，并同步当前仿真时钟；此时不调用模型。
def dispatch_localization():
    while engine.localization_outbox:
        localization.submit(engine.localization_outbox.pop(0))
    localization.advance_time(engine.simulation_minute)


# 记录数据库已确认的回滚基线；激活轮次时生成新令牌并更新单调序号。
def adopt_checkpoint(engine_data, loc_data, saved_at, *, activated=False):
    global _saved_engine, _saved_localization
    _saved_engine, _saved_localization = engine_data, loc_data
    persistence.run_id, persistence.saved_at = loc_data["state"]["session_id"], datetime.fromisoformat(saved_at)
    persistence.error = None
    if activated:
        persistence.activation_id = uuid4().hex
        persistence.activation_sequence = store.activation_sequence()


# 保存引擎与定位的一致检查点；普通保存不能隐式切换轮次。
def save_all(*, creating=False, restoring=False, expected_current=None, reason="create"):
    if store is None:
        raise StorageError("存档服务尚未就绪")
    engine_data, loc_data = engine.checkpoint(), localization.checkpoint()
    if creating:
        saved_at = store.create(localization.state.session_id, engine_data, loc_data,
                                expected_current=expected_current, reason=reason)
    else:
        saved_at = store.save(localization.state.session_id, engine_data, loc_data, restoring=restoring)
    adopt_checkpoint(engine_data, loc_data, saved_at, activated=creating or restoring)


# 拒绝切档期间、激活令牌过期或持久化故障后的写操作。
def check_mutation(activation=None):
    if _transition:
        raise HTTPException(409, "正在切换存档，请等待当前操作完成")
    if activation and activation != persistence.activation_id:
        raise HTTPException(409, "当前存档已变化，请刷新后重试")
    if persistence.error:
        raise HTTPException(503, persistence.error)


# 恢复最后成功保存的引擎/定位状态，丢弃未提交的业务变化。
def rollback_checkpoint():
    if _saved_engine:
        engine.restore(_saved_engine)
    if _saved_localization:
        localization.restore(_saved_localization)


# 等待仿真锁后发布暂停及存储错误状态，避免广播正在回滚的中间态。
async def broadcast_storage_error():
    async with engine.lock:
        value = snapshot()
    await connections.broadcast(SocketEvent(type="control", state=value))


# 存储故障时暂停仿真与定位，安排页面通知，不继续累积未保存步骤。
def storage_failed(error):
    engine.running = False
    localization._suspended = True
    persistence.error = str(error)
    logger.error("Simulation persistence failed; retaining the last committed checkpoint")
    asyncio.create_task(broadcast_storage_error())


# 后台定位独立保存当前轮次；失败时恢复最后确认的定位检查点。
def save_localization():
    global _saved_localization
    if persistence.error:
        raise StorageError(persistence.error)
    try:
        data = localization.checkpoint()
        saved_at = store.save_localization(localization.state.session_id, data)
        _saved_localization = data
        persistence.saved_at = datetime.fromisoformat(saved_at)
    except StorageError as error:
        if _saved_localization:
            localization.restore(_saved_localization)
        storage_failed(error)
        raise


# 写操作边界：加锁、执行、转交 outbox、保存，再唤醒定位；磁盘失败则回滚并返回 503。
@asynccontextmanager
async def mutation(activation=None):
    """Hold the simulation lock, publish only durable state, roll back on disk errors."""
    check_mutation(activation)
    async with engine.lock:
        check_mutation(activation)
        try:
            yield
            if persistence.error:
                raise StorageError(persistence.error)
            dispatch_localization()
            save_all()
        except StorageError as error:
            rollback_checkpoint()
            storage_failed(error)
            raise HTTPException(503, str(error)) from None
        localization.wake()


# 先阻止新步启动，再等待当前步释放锁并保存，之后执行载入/重置/删除当前轮次。
@asynccontextmanager
async def run_transition(expected_current, activation=None):
    """Prevent another step from starting; let the current locked step finish and save."""
    global _transition
    check_mutation(activation)
    if expected_current != persistence.run_id:
        raise HTTPException(409, "当前存档已变化，请刷新后重试")
    # 先设置切换标志再等待锁：正在生成的步骤可以完成，但后续自动/手动步骤不得抢先开始。
    _transition = True
    try:
        async with engine.lock:
            if expected_current != persistence.run_id:
                raise HTTPException(409, "当前存档已变化，请刷新后重试")
            if persistence.error:
                raise HTTPException(503, persistence.error)
            engine.running = False
            try:
                save_all()
                yield
            except StorageError as error:
                rollback_checkpoint()
                storage_failed(error)
                raise HTTPException(503, str(error)) from None
            except (ValueError, KeyError) as error:
                rollback_checkpoint()
                raise HTTPException(404 if isinstance(error, KeyError) else 409,
                                    "存档不存在" if isinstance(error, KeyError) else "存档无法载入，请检查兼容性和内容") from None
    finally:
        _transition = False


# 只删除已移除轮次的合法缓存目录；仍有线程使用、符号链接或越界路径均不删除。
async def cleanup_pending():
    if store is None or _cleanup_lock is None or _cleanup_lock.locked():
        return
    async with _cleanup_lock:
        for job in store.pending_cleanup():
            run_id = job["run_id"]
            if run_id in localization.busy_sessions():
                continue
            error = None
            root = localization.runtime_root.resolve()
            folder = root / run_id
            # 轮次 ID 和目录边界双重校验；旧线程仍在使用的会话已在上方跳过。
            if (not re.fullmatch(r"[0-9a-f]{32}", run_id) or folder.is_symlink()
                    or folder.resolve().parent != root):
                error = "缓存目录不符合安全路径范围，未执行清理。"
            elif store.connection.execute("SELECT id FROM runs WHERE id=?", (run_id,)).fetchone():
                error = "该轮次仍存在，未执行缓存清理。"
            else:
                try:
                    if folder.exists():
                        await asyncio.to_thread(shutil.rmtree, folder)
                except OSError:
                    error = "定位缓存清理失败，请检查目录权限；系统会重试。"
            store.finish_cleanup(run_id, error)


# 定期尝试持久化队列中的缓存清理，不因单次清理记录故障终止循环。
async def cleanup_loop():
    while True:
        try:
            await cleanup_pending()
        except StorageError:
            logger.error("Archive cache cleanup could not be checkpointed; will retry")
        await asyncio.sleep(5)


# 按真实时间间隔调度运行中的仿真，每轮仍通过统一保存和广播边界。
async def simulation_loop() -> None:
    interval = float(os.getenv("SIMULATION_INTERVAL_SECONDS", "3"))
    while True:
        await asyncio.sleep(interval)
        if engine.running and not _transition:
            try:
                async with mutation():
                    if engine.running:
                        await engine.tick()
                await connections.broadcast(SocketEvent(type="tick", state=snapshot()))
            except HTTPException:
                pass  # Storage failure has already paused and notified the UI.


# 启动时持锁打开数据库并恢复为暂停，注册定位回调；关闭时等待任务退出再关闭存档。
@asynccontextmanager
async def lifespan(_: FastAPI):
    global store, persistence, _saved_engine, _saved_localization, _transition, _cleanup_lock
    store = SimulationStore(Path(os.getenv("SIMULATION_STORAGE_PATH") or str(ROOT / "runtime" / "simulation.sqlite3")))
    try:
        saved = store.load()
        persistence = PersistenceState(enabled=True, restored=bool(saved))
        _transition, _cleanup_lock = False, asyncio.Lock()
        if saved:
            engine.restore(saved["engine"])
            localization.restore(saved["localization"])
        save_all(creating=not bool(saved), restoring=bool(saved))
    except Exception:
        store.close()
        store = None
        raise
    async def localization_changed(value):
        await connections.broadcast(SocketEvent(type="localization", localization=value,
                                                persistence=persistence.model_copy(deep=True)))
    localization.on_change = localization_changed
    localization.on_persist = save_localization
    localization._closed = False
    from fire_locator.config import Settings
    logger.info("Localization search radius: %s simulation_units; evidence window: %s simulation_minutes",
                Settings.radius_m, Settings.cold_minutes)
    if os.getenv("OPENAI_API_KEY", "").strip():
        logger.info("Resident LLM: OpenAI (OPENAI_API_KEY configured)")
    elif os.getenv("DASHSCOPE_API_KEY", "").strip():
        logger.info("Resident LLM: DashScope/Qwen (DASHSCOPE_API_KEY configured)")
    else:
        logger.warning("Resident LLM unavailable; configure a key in %s. Simulation cannot start without a model.", ENV_FILE)
    task = asyncio.create_task(simulation_loop())
    cleaner = asyncio.create_task(cleanup_loop())
    try:
        yield
    finally:
        task.cancel()
        cleaner.cancel()
        with suppress(asyncio.CancelledError):
            await task
        with suppress(asyncio.CancelledError):
            await cleaner
        await localization.close()
        localization.on_persist = None
        localization.on_change = None
        store.close()
        store = None


app = FastAPI(title="火灾应急管理仿真社交网络系统", version="3.0.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/map-assets", StaticFiles(directory=DATA_ROOT), name="map-assets")
app.mount("/city-assets", StaticFiles(directory=CITY_ROOT / "assets"), name="city-assets")


# 返回静态主页面，React 地图脚本也由同一个后端提供。
@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


# 在仿真锁内取得一致的组合快照，可能等待当前模型生成步骤完成。
@app.get("/api/state", response_model=SimulationState)
async def get_state() -> SimulationState:
    async with engine.lock:
        return snapshot()


# 保存首发火源概率；兼容字段 suppression_factor 不参与当前单火源计算。
@app.put("/api/fire-policy", response_model=SimulationState)
async def update_fire_policy(policy: FirePolicy, activation: str | None = Header(None, alias="X-Simulation-Activation")) -> SimulationState:
    async with mutation(activation):
        engine.fire_policy = policy
    current = snapshot()
    await connections.broadcast(SocketEvent(type="fire", state=current))
    return current


# 清除指定真实火源并保存；不按真值自动清除定位历史证据。
@app.delete("/api/fire/{fire_id}", response_model=SimulationState)
async def delete_one_fire(fire_id: str, activation: str | None = Header(None, alias="X-Simulation-Activation")) -> SimulationState:
    async with mutation(activation):
        if not any(fire.id == fire_id for fire in engine.fires):
            raise HTTPException(status_code=404, detail="Fire not found")
        engine.clear_fire(fire_id)
    current = snapshot()
    await connections.broadcast(SocketEvent(type="fire", state=current))
    return current


# 清除全部真实火源但不推进时间，也不清空定位推断结果。
@app.delete("/api/fire", response_model=SimulationState)
async def delete_fire(activation: str | None = Header(None, alias="X-Simulation-Activation")) -> SimulationState:
    async with mutation(activation):
        engine.clear_fire()
    current = snapshot()
    await connections.broadcast(SocketEvent(type="fire", state=current))
    return current


# 处理开始、暂停、单步和重置；重置归档旧轮次，成功继续时解除定位恢复挂起。
@app.post("/api/simulation", response_model=SimulationState)
async def control_simulation(command: SimulationCommand, activation: str | None = Header(None, alias="X-Simulation-Activation")) -> SimulationState:
    if command.action == "reset":
        old = persistence.run_id
        async with run_transition(old, activation):
            engine.reset()
            localization.reset()
            save_all(creating=True, expected_current=old, reason="reset")
            persistence.restored = False
        current = snapshot()
        await connections.broadcast(SocketEvent(type="reset", state=current))
        return current
    async with mutation(activation):
        if command.action == "start":
            engine.start()
            if engine.running:
                localization.resume()
                persistence.restored = False
        elif command.action == "pause":
            engine.running = False
        elif command.action == "step":
            minute = engine.simulation_minute
            await engine.tick()
            if engine.simulation_minute > minute:
                localization.resume()
                persistence.restored = False
    current = snapshot()
    event_type = "reset" if command.action == "reset" else "control"
    await connections.broadcast(SocketEvent(type=event_type, state=current))
    return current


# 直接读取定位快照，不等待主仿真锁，便于观察后台进度。
@app.get("/api/localization")
async def localization_state():
    return localization.snapshot()


# 分页返回存档摘要、兼容性及当前激活标识，不载入记录或请求模型。
@app.get("/api/runs")
async def list_runs(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100)):
    if store is None:
        raise HTTPException(503, "存档服务尚未就绪")
    result = store.list_runs(page=page, page_size=page_size,
                             localization_config=localization.configuration_fingerprint())
    result.update(current_run_id=persistence.run_id, activation_id=persistence.activation_id,
                  activation_sequence=persistence.activation_sequence)
    return result


# 验证目标及当前令牌，等待当前步骤后切换原记录，恢复为暂停并广播完整状态。
@app.post("/api/runs/{run_id}/activate", response_model=SimulationState)
async def activate_run(run_id: str, command: ActivateRunRequest,
                       activation: str | None = Header(None, alias="X-Simulation-Activation")):
    check_mutation(activation)
    if command.expected_run_id != persistence.run_id:
        raise HTTPException(409, "当前存档已变化，请刷新后重试")
    if run_id == persistence.run_id:
        raise HTTPException(409, "该存档已在使用")
    try:
        saved = store.load(run_id)
    except StorageError as error:
        raise HTTPException(409, str(error)) from None
    if not saved:
        raise HTTPException(404, "存档不存在")
    loc = saved["localization"]
    if (loc.get("memory") and loc["memory"].get("schema_version") != 1
            and loc["configuration"] != localization.configuration_fingerprint()):
        raise HTTPException(409, "存档的定位模型或规则不兼容，请恢复原配置后载入")
    async with run_transition(command.expected_run_id, activation):
        engine.restore(saved["engine"])
        localization.restore(loc)
        engine_data, loc_data = engine.checkpoint(), localization.checkpoint()
        saved_at = store.activate(run_id, command.expected_run_id, engine_data, loc_data)
        adopt_checkpoint(engine_data, loc_data, saved_at, activated=True)
        persistence.restored = True
    current = snapshot()
    await connections.broadcast(SocketEvent(type="reset", state=current))
    return current


# 历史记录直接事务删除；删除当前记录时同事务创建空白轮次，缓存另行安全清理。
@app.delete("/api/runs/{run_id}")
async def delete_run(run_id: str, expected_run_id: str = Query(..., min_length=1, max_length=64),
                     activation: str | None = Header(None, alias="X-Simulation-Activation")):
    check_mutation(activation)
    if expected_run_id != persistence.run_id:
        raise HTTPException(409, "当前存档已变化，请刷新后重试")
    if not store.connection.execute("SELECT id FROM runs WHERE id=?", (run_id,)).fetchone():
        raise HTTPException(404, "存档不存在")
    current = None
    if run_id == persistence.run_id:
        async with run_transition(expected_run_id, activation):
            engine.reset()
            localization.reset()
            engine_data, loc_data = engine.checkpoint(), localization.checkpoint()
            saved_at = store.delete(run_id, expected_run_id,
                                     replacement=(localization.state.session_id, engine_data, loc_data))
            adopt_checkpoint(engine_data, loc_data, saved_at, activated=True)
            persistence.restored = False
        current = snapshot()
        await connections.broadcast(SocketEvent(type="reset", state=current))
    else:
        # No await: deleting a different record cannot interleave with a run switch.
        try:
            store.delete(run_id, expected_run_id)
        except KeyError:
            raise HTTPException(404, "存档不存在") from None
        except RunConflict as error:
            raise HTTPException(409, str(error)) from None
        except StorageError as error:
            raise HTTPException(503, str(error)) from None
    try:
        await cleanup_pending()
    except StorageError:
        logger.error("Deleted run retained its cache cleanup task for retry")
    cleanup = store.pending_cleanup()
    await connections.broadcast(SocketEvent(type="archives", persistence=persistence.model_copy(deep=True)))
    return {"deleted_run_id":run_id, "state":current, "cleanup_pending":any(j["run_id"]==run_id for j in cleanup),
            "cleanup":cleanup}


# 显式重排失败任务并先保存状态，再唤醒后台；错误不泄露原始提供商响应。
@app.post("/api/localization/{job_id}/retry")
async def retry_localization(job_id: str, activation: str | None = Header(None, alias="X-Simulation-Activation")):
    check_mutation(activation)
    before = localization.checkpoint()
    try:
        localization.retry(job_id)
        localization.resume()
        await localization.notify()
    except KeyError:
        raise HTTPException(404, "定位任务不存在") from None
    except ValueError as error:
        raise HTTPException(409, str(error)) from None
    except StorageError as error:
        localization.restore(before)
        raise HTTPException(503, str(error)) from None
    localization.wake()
    return localization.snapshot()


# 把历史查询绑定到当前轮次，避免切档后旧分页请求读取其他场景。
def history_run(run_id):
    if store is None:
        raise HTTPException(503, "存档服务尚未就绪")
    if run_id and run_id != persistence.run_id:
        raise HTTPException(409, "仿真轮次已变化，请刷新后重试")
    return persistence.run_id


# 按社区和 sequence 向前读取完整消息历史，区别于实时快照的有限窗口。
@app.get("/api/communities/{community_id}/messages")
async def message_history(community_id: str, run_id: str | None = None,
                          before: int | None = Query(None, ge=1), limit: int = Query(50, ge=1, le=200)):
    current = history_run(run_id)
    if community_id not in {c.id for c in engine.communities}:
        raise HTTPException(404, "社区不存在")
    return store.history(current, "messages", community_id=community_id, before=before, limit=limit)


# 从数据库分页读取完整监测报告，不增加模型上下文窗口。
@app.get("/api/reports")
async def report_history(run_id: str | None = None, before: int | None = Query(None, ge=1),
                         limit: int = Query(20, ge=1, le=200)):
    return store.history(history_run(run_id), "reports", before=before, limit=limit)


# 与群聊历史使用相同轮次校验；筛选不改变全城发现进度或模型输入。
@app.get("/api/discovery")
async def discovery_history(run_id: str | None = None, category: DiscoveryCategory | None = None,
                            community_id: str | None = None, before: int | None = Query(None, ge=1),
                            limit: int = Query(50, ge=1, le=200)):
    current = history_run(run_id)
    if community_id is not None and community_id not in {c.id for c in engine.communities}:
        raise HTTPException(404, "社区不存在")
    return store.discovery_history(current, category=category, community_id=community_id, before=before, limit=limit)


# 按原帖 ID 查完整历史详情，支持实时窗口之外的引用。
@app.get("/api/messages/{message_id}")
async def message_detail(message_id: str, run_id: str | None = None):
    current = history_run(run_id)
    item = store.item(current, "messages", message_id)
    if not item:
        raise HTTPException(404, "消息不存在")
    return {"run_id": current, "item": item}


# 按报告 ID 查历史详情，找不到时明确返回 404。
@app.get("/api/reports/{report_id}")
async def report_detail(report_id: str, run_id: str | None = None):
    current = history_run(run_id)
    item = store.item(current, "reports", report_id)
    if not item:
        raise HTTPException(404, "监测报告不存在")
    return {"run_id": current, "item": item}


# 连接后发送当前状态并维持连接；各类更新由 ConnectionManager 统一广播。
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await connections.connect(websocket)
    async with engine.lock:
        current = snapshot()
    await websocket.send_json(SocketEvent(type="snapshot", state=current).model_dump(mode="json"))
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        connections.disconnect(websocket)

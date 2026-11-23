# SQLite 存档层：单进程写入、事务检查点、完整消息/发现/报告历史、轮次管理与清理任务。
# runs 保存续跑状态；历史表保留超出内存窗口的数据；此层不调用模型。

"""Transactional continuation checkpoints and immutable full history for one writer."""

from contextlib import contextmanager
from datetime import datetime, UTC
try:
    import fcntl
except ImportError:  # Windows
    fcntl = None
    import msvcrt
import hashlib
import json
from pathlib import Path
import sqlite3

from .spatial import load_spatial_model, load_city_scene, load_city_catalog
from .world import create_residents


# 可安全展示的存储故障；上层据此暂停并恢复最后确认的检查点。
class StorageError(RuntimeError):
    pass


# 调用方预期轮次与数据库当前轮次不符，转为并发操作冲突处理。
class RunConflict(ValueError):
    pass


# 统一紧凑 JSON 编码，拒绝 NaN/Infinity，供存档、历史及指纹使用。
def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


# 对规范地图、居民定义和单火源规则取指纹，阻止不兼容的续跑。
def compatibility():
    payload = {"schema": 1, "fire_mode": "single", "map": load_spatial_model(),
               "city": load_city_scene(), "extended": load_city_catalog(),
               "residents": [r.model_dump(mode="json") for r in create_residents()]}
    return hashlib.sha256(encode(payload).encode()).hexdigest()


# 单写者 SQLite 仓库，负责事务与历史，业务内存恢复由 main/engine/service 负责。
class SimulationStore:
    # 先获取非阻塞进程锁，再检查数据库完整性并创建或迁移表；不静默覆盖坏档。
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = None
        self.lock_file = self.path.with_suffix(".lock").open("a+")
        try:
            if fcntl is not None:
                fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:
                self.lock_file.seek(0)
                msvcrt.locking(self.lock_file.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            self.lock_file.close()
            raise StorageError("仿真存档已被另一个后端进程占用，请先停止旧服务；更换端口不能共享写入。") from None
        try:
            self.connection = sqlite3.connect(self.path, timeout=5, check_same_thread=False)
            self.connection.row_factory = sqlite3.Row
            self.connection.execute("PRAGMA journal_mode=DELETE")
            self.connection.execute("PRAGMA synchronous=FULL")
            self.connection.execute("PRAGMA foreign_keys=ON")
            version = self.connection.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1, 2, 3, 4):
                raise StorageError("存档版本不兼容，原文件已保留，请使用对应版本程序。")
            if self.connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise StorageError("存档完整性检查失败，原文件已保留，请从备份恢复。")
            self.connection.executescript("""
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY, active INTEGER NOT NULL, fingerprint TEXT NOT NULL,
                    engine TEXT NOT NULL, localization TEXT NOT NULL, saved_at TEXT NOT NULL,
                    archived_at TEXT);
                CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(active) WHERE active=1;
                CREATE TABLE IF NOT EXISTS messages (
                    run_id TEXT NOT NULL REFERENCES runs(id), id TEXT NOT NULL,
                    sequence INTEGER NOT NULL, community_id TEXT NOT NULL, body TEXT NOT NULL,
                    PRIMARY KEY(run_id,id), UNIQUE(run_id,sequence));
                CREATE INDEX IF NOT EXISTS community_history ON messages(run_id,community_id,sequence);
                CREATE TABLE IF NOT EXISTS reports (
                    run_id TEXT NOT NULL REFERENCES runs(id), id TEXT NOT NULL,
                    sequence INTEGER NOT NULL, body TEXT NOT NULL,
                    PRIMARY KEY(run_id,id), UNIQUE(run_id,sequence));
            """)
            with self.connection:
                self.connection.execute("""CREATE TABLE IF NOT EXISTS run_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
                    action TEXT NOT NULL, source TEXT NOT NULL, from_run_id TEXT,
                    to_run_id TEXT, details TEXT NOT NULL)""")
                self.connection.execute("""CREATE TABLE IF NOT EXISTS cleanup_queue (
                    run_id TEXT PRIMARY KEY, requested_at TEXT NOT NULL, error TEXT)""")
            self.fingerprint = compatibility()
            if version < 3:
                self._upgrade_city_runs()
            # 只增表和索引，不回扫旧消息，不改轮次兼容指纹或已有模型状态。
            with self.transaction() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS discovery_posts (
                    run_id TEXT NOT NULL REFERENCES runs(id), message_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL, community_id TEXT NOT NULL, body TEXT NOT NULL,
                    PRIMARY KEY(run_id,message_id), UNIQUE(run_id,sequence),
                    FOREIGN KEY(run_id,message_id) REFERENCES messages(run_id,id))""")
                db.execute("CREATE INDEX IF NOT EXISTS discovery_community_history ON discovery_posts(run_id,community_id,sequence)")
                db.execute("""CREATE TABLE IF NOT EXISTS discovery_categories (
                    run_id TEXT NOT NULL, message_id TEXT NOT NULL, category TEXT NOT NULL, sequence INTEGER NOT NULL,
                    PRIMARY KEY(run_id,message_id,category),
                    FOREIGN KEY(run_id,message_id) REFERENCES discovery_posts(run_id,message_id) ON DELETE CASCADE)""")
                db.execute("CREATE INDEX IF NOT EXISTS discovery_category_history ON discovery_categories(run_id,category,sequence)")
                db.execute("PRAGMA user_version=4")
        except Exception as error:
            self.close()
            if isinstance(error, StorageError):
                raise
            raise StorageError("无法打开仿真存档，请检查文件权限、磁盘与数据库完整性；原文件未清空。") from None

    def _upgrade_city_runs(self):
        """备份后原子迁移已知旧版的活动/归档轮次及完整历史，只执行一次。"""
        from .city_migration import legacy_fingerprint, migrate_checkpoints, migrate_message, migrate_report
        from uuid import uuid4
        old_fingerprint = legacy_fingerprint(encode)
        rows = self.connection.execute("SELECT * FROM runs WHERE fingerprint=?", (old_fingerprint,)).fetchall()
        if rows:
            backup_path = self.path.with_name(self.path.stem + ".pre-city-" + uuid4().hex[:8] + ".sqlite3")
            backup = sqlite3.connect(backup_path)
            try:
                self.connection.backup(backup)
            finally:
                backup.close()
        with self.transaction() as db:
            for row in rows:
                engine, loc = migrate_checkpoints(json.loads(row["engine"]), json.loads(row["localization"]))
                db.execute("UPDATE runs SET engine=?,localization=?,fingerprint=? WHERE id=?",
                           (encode(engine), encode(loc), self.fingerprint, row["id"]))
                for table, migrate in (("messages", migrate_message), ("reports", migrate_report)):
                    for item in db.execute(f"SELECT id,body FROM {table} WHERE run_id=?", (row["id"],)).fetchall():
                        db.execute(f"UPDATE {table} SET body=? WHERE run_id=? AND id=?",
                                   (encode(migrate(json.loads(item["body"]))), row["id"], item["id"]))
                self._event(db, "migrate_city", "startup", row["id"], row["id"], {"from": "LOCAL30x25", "to": "CITY90x75"})
            db.execute("PRAGMA user_version=3")

    # 先关闭数据库再释放进程锁，避免仍有写入时允许第二实例打开。
    def close(self):
        if self.connection:
            self.connection.close()
            self.connection = None
        if not self.lock_file.closed:
            if fcntl is not None:
                fcntl.flock(self.lock_file, fcntl.LOCK_UN)
            else:
                self.lock_file.seek(0)
                msvcrt.locking(self.lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            self.lock_file.close()

    # 统一事务提交/回滚边界，把 SQLite 与文件系统错误转换为 StorageError。
    @contextmanager
    def transaction(self):
        try:
            with self.connection:
                yield self.connection
        except (sqlite3.Error, OSError) as error:
            raise StorageError("自动保存失败，仿真已暂停；请检查存档权限、磁盘空间与数据库状态。") from None

    # 读取指定或活动轮次，校验指纹及定位 session_id；不存在返回 None。
    def load(self, run_id=None):
        row = (self.connection.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone() if run_id
               else self.connection.execute("SELECT * FROM runs WHERE active=1").fetchone())
        if not row:
            return None
        if row["fingerprint"] != self.fingerprint:
            raise StorageError("存档地图、居民定义或规则与当前程序不兼容，原存档已保留；请先备份并使用兼容版本。")
        try:
            data = {"run_id": row["id"], "engine": json.loads(row["engine"]),
                    "localization": json.loads(row["localization"]), "saved_at": row["saved_at"]}
            if data["localization"]["state"]["session_id"] != row["id"]:
                raise StorageError("存档轮次与定位会话不一致，原数据已保留。")
            return data
        except (ValueError, TypeError):
            raise StorageError("存档内容无法解析，原存档已保留，请从备份恢复。") from None

    # 在调用者当前事务内读取活动轮次，作为切换和保存的并发校验基准。
    @staticmethod
    def _active(db):
        row = db.execute("SELECT id FROM runs WHERE active=1").fetchone()
        return row[0] if row else None

    # 记录轮次操作审计，事件自增 ID 也用于生成激活序号。
    @staticmethod
    def _event(db, action, source, old, new, details=None):
        db.execute("INSERT INTO run_events(created_at,action,source,from_run_id,to_run_id,details) VALUES(?,?,?,?,?,?)",
                   (datetime.now(UTC).isoformat(), action, source, old, new, encode(details or {})))

    # 读取会改变激活状态的最近事件序号，用于多页面判断状态新旧。
    def activation_sequence(self):
        return self.connection.execute("""SELECT coalesce(max(id),0) FROM run_events
            WHERE action IN ('create','reset','activate','delete_current','restore')""").fetchone()[0]

    # 消息/报告窗口与发现的完整待提交批次按 ID 幂等追加；旧历史不随窗口裁剪删除。
    @staticmethod
    def _history(db, run_id, engine_data):
        for message in engine_data["state"]["chats"]:
            db.execute("INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?)",
                       (run_id, message["id"], message["sequence"], message["community_id"], encode(message)))
        for report in engine_data["state"]["reports"]:
            db.execute("INSERT OR IGNORE INTO reports VALUES(?,?,?,?)",
                       (run_id, report["id"], report["sequence"], encode(report)))
        for row in engine_data.get("discovery_pending", []):
            db.execute("INSERT OR IGNORE INTO discovery_posts VALUES(?,?,?,?,?)",
                       (run_id, row["message_id"], row["sequence"], row["community_id"], encode(row)))
            for category in row["categories"]:
                db.execute("INSERT OR IGNORE INTO discovery_categories VALUES(?,?,?,?)",
                           (run_id, row["message_id"], category, row["sequence"]))

    # 在调用者事务中插入新活动轮次及初始历史，要求轮次与定位会话一致。
    def _insert(self, db, run_id, engine_data, localization_data, now):
        if localization_data["state"]["session_id"] != run_id:
            raise StorageError("新存档轮次与定位会话不一致")
        db.execute("INSERT INTO runs VALUES(?,1,?,?,?,?,NULL)",
                   (run_id, self.fingerprint, encode(engine_data), encode(localization_data), now))
        self._history(db, run_id, engine_data)

    # 显式新建时才归档上一活动轮次，并与新档和审计同事务提交。
    def create(self, run_id, engine_data, localization_data, *, expected_current=None, reason="create"):
        """Only an explicit new-run operation may archive the active record."""
        now = datetime.now(UTC).isoformat()
        with self.transaction() as db:
            if self._active(db) != expected_current:
                raise RunConflict("当前存档已变化，请刷新后重试")
            db.execute("UPDATE runs SET active=0,archived_at=? WHERE active=1", (now,))
            self._insert(db, run_id, engine_data, localization_data, now)
            self._event(db, reason, "startup" if expected_current is None else "api.reset", expected_current, run_id)
        return now

    # 只更新现有活动轮次，同时追加历史；拒绝把普通保存当成隐式切档。
    def save(self, run_id, engine_data, localization_data, *, restoring=False):
        """Update the active record only: an unexpected ID must never switch runs."""
        now = datetime.now(UTC).isoformat()
        engine_json, loc_json = encode(engine_data), encode(localization_data)
        with self.transaction() as db:
            if self._active(db) != run_id or localization_data["state"]["session_id"] != run_id:
                raise StorageError("当前存档 ID 不一致，普通保存已拒绝切换轮次；原数据已保留。")
            db.execute("UPDATE runs SET engine=?,localization=?,saved_at=? WHERE id=? AND active=1",
                       (engine_json, loc_json, now, run_id))
            self._history(db, run_id, engine_data)
            if restoring:
                self._event(db, "restore", "startup", run_id, run_id)
        return now

    # 检查预期活动轮次后激活已有记录，不复制为新记录，也不调用模型。
    def activate(self, run_id, expected_current, engine_data, localization_data):
        now = datetime.now(UTC).isoformat()
        with self.transaction() as db:
            if self._active(db) != expected_current:
                raise RunConflict("当前存档已变化，请刷新后重试")
            row = db.execute("SELECT fingerprint FROM runs WHERE id=?", (run_id,)).fetchone()
            if row is None:
                raise KeyError(run_id)
            if row[0] != self.fingerprint or localization_data["state"]["session_id"] != run_id:
                raise RunConflict("存档与当前地图、居民或轮次定义不兼容")
            db.execute("UPDATE runs SET active=0,archived_at=? WHERE active=1", (now,))
            db.execute("UPDATE runs SET active=1,archived_at=NULL,engine=?,localization=?,saved_at=? WHERE id=?",
                       (encode(engine_data), encode(localization_data), now, run_id))
            self._event(db, "activate", "api.runs.activate", expected_current, run_id)
        return now

    # 原子删除轮次及完整历史；当前轮次必须有空白替代，并持久登记缓存清理任务。
    def delete(self, run_id, expected_current, *, replacement=None):
        now = datetime.now(UTC).isoformat()
        with self.transaction() as db:
            if self._active(db) != expected_current:
                raise RunConflict("当前存档已变化，请刷新后重试")
            if not db.execute("SELECT id FROM runs WHERE id=?", (run_id,)).fetchone():
                raise KeyError(run_id)
            if run_id == expected_current and replacement is None:
                raise RunConflict("删除当前存档需要同时创建空白轮次")
            if run_id != expected_current and replacement is not None:
                raise RunConflict("删除历史存档不能替换当前轮次")
            counts = {table: db.execute(f"SELECT count(*) FROM {table} WHERE run_id=?", (run_id,)).fetchone()[0]
                      for table in ("messages", "reports", "discovery_posts")}
            for table in ("discovery_posts", "messages", "reports", "runs"):
                db.execute(f"DELETE FROM {table} WHERE {'id' if table == 'runs' else 'run_id'}=?", (run_id,))
            new_id = expected_current
            if replacement:
                new_id, engine_data, loc_data = replacement
                self._insert(db, new_id, engine_data, loc_data, now)
            db.execute("INSERT INTO cleanup_queue VALUES(?,?,NULL)", (run_id, now))
            self._event(db, "delete_current" if replacement else "delete", "api.runs.delete", run_id, new_id, counts)
        return now

    # 分页统计完整历史数量并给出兼容性原因，损坏/不兼容记录仍可显示并删除。
    def list_runs(self, *, page=1, page_size=20, localization_config=None):
        total = self.connection.execute("SELECT count(*) FROM runs").fetchone()[0]
        rows = self.connection.execute("""SELECT r.*,
            (SELECT count(*) FROM messages m WHERE m.run_id=r.id) AS message_count,
            (SELECT count(*) FROM reports p WHERE p.run_id=r.id) AS report_count
            FROM runs r ORDER BY saved_at DESC,id DESC LIMIT ? OFFSET ?""",
            (page_size, (page-1)*page_size)).fetchall()
        items = []
        for row in rows:
            reason, minute, fire_count = None, 0, 0
            localization_warning = None
            try:
                state, loc = json.loads(row["engine"])["state"], json.loads(row["localization"])
                minute, fire_count = state["simulation_minute"], len(state["fires"])
                if row["fingerprint"] != self.fingerprint:
                    reason = "地图或居民定义不兼容"
                elif loc["state"]["session_id"] != row["id"]:
                    reason = "存档轮次与定位会话不一致"
                elif loc.get("memory") and localization_config and loc["configuration"] != localization_config:
                    if loc["memory"].get("schema_version") == 1:
                        localization_warning = "旧定位规则不兼容；可载入群聊及报告，定位保持暂停，重置后使用新版定位。"
                    else:
                        reason = "定位模型或规则不兼容"
            except (ValueError, KeyError, TypeError):
                reason = "存档内容无法解析"
            items.append({"run_id":row["id"], "active":bool(row["active"]), "saved_at":row["saved_at"],
                          "simulation_minute":minute, "message_count":row["message_count"],
                          "report_count":row["report_count"], "fire_count":fire_count,
                          "compatible":reason is None, "incompatible_reason":reason,
                          "localization_warning":localization_warning})
        return {"items":items,"total":total,"page":page,"page_size":page_size,"cleanup":self.pending_cleanup()}

    # 读取重启后仍需继续的清理任务，目录删除由宿主实施。
    def pending_cleanup(self):
        return [dict(row) for row in self.connection.execute("SELECT * FROM cleanup_queue ORDER BY requested_at")]

    # 清理成功才删除任务；失败保留错误信息供展示及后续重试。
    def finish_cleanup(self, run_id, error=None):
        with self.transaction() as db:
            if error:
                db.execute("UPDATE cleanup_queue SET error=? WHERE run_id=? AND error IS NOT ?", (error,run_id,error))
            else:
                db.execute("DELETE FROM cleanup_queue WHERE run_id=?", (run_id,))

    # 独立更新当前轮次的定位检查点，不能覆盖已归档或已删除的轮次。
    def save_localization(self, run_id, data):
        now = datetime.now(UTC).isoformat()
        with self.transaction() as db:
            if data["state"]["session_id"] != run_id:
                raise StorageError("定位检查点所属轮次不一致，未覆盖当前存档。")
            result = db.execute("UPDATE runs SET localization=?,saved_at=? WHERE id=? AND active=1",
                                (encode(data), now, run_id))
            if result.rowcount != 1:
                raise StorageError("定位结果所属仿真已失效，未覆盖当前存档。")
        return now

    # 按 sequence 向前分页、多查一条判断 has_more，返回条目按时间正序供界面展示。
    def history(self, run_id, kind, *, community_id=None, before=None, limit=50):
        table = "messages" if kind == "messages" else "reports"
        clauses, args = ["run_id=?"], [run_id]
        if community_id is not None:
            clauses.append("community_id=?"); args.append(community_id)
        if before is not None:
            clauses.append("sequence<?"); args.append(before)
        rows = self.connection.execute(
            f"SELECT body,sequence FROM {table} WHERE {' AND '.join(clauses)} ORDER BY sequence DESC LIMIT ?",
            [*args, limit + 1]).fetchall()
        selected = rows[:limit]
        return {"run_id": run_id, "items": [json.loads(row["body"]) for row in reversed(selected)],
                "has_more": len(rows) > limit, "next_before": selected[-1]["sequence"] if selected else None}

    # 查询当前指定轮次中的完整历史对象，未命中返回 None。
    def item(self, run_id, kind, item_id):
        table = "messages" if kind == "messages" else "reports"
        row = self.connection.execute(f"SELECT body FROM {table} WHERE run_id=? AND id=?", (run_id, item_id)).fetchone()
        return json.loads(row["body"]) if row else None

    def discovery_history(self, run_id, *, category=None, community_id=None, before=None, limit=50):
        """按消息序号分页候选，类别用索引关系表检索，避免扫描完整 JSON 历史。"""
        # 有类别时先按类别/序号索引取候选，再主键回表；罕见类别不逐条解析全轮JSON。
        source = "discovery_posts d"
        sequence = "d.sequence"
        clauses, args = ["d.run_id=?"], [run_id]
        if category is not None:
            source = "discovery_categories c JOIN discovery_posts d ON d.run_id=c.run_id AND d.message_id=c.message_id"
            sequence = "c.sequence"
            clauses, args = ["c.run_id=?", "c.category=?"], [run_id, category]
        if community_id is not None:
            clauses.append("d.community_id=?")
            args.append(community_id)
        if before is not None:
            clauses.append(f"{sequence}<?")
            args.append(before)
        rows = self.connection.execute(
            f"SELECT d.body,d.sequence FROM {source} WHERE {' AND '.join(clauses)} ORDER BY {sequence} DESC LIMIT ?",
            [*args, limit+1]).fetchall()
        selected = rows[:limit]
        return {"run_id": run_id, "items": [json.loads(row["body"]) for row in reversed(selected)],
                "has_more": len(rows) > limit, "next_before": selected[-1]["sequence"] if selected else None}

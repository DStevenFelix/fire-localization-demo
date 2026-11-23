#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
沙盘集成平台通信协议 v1.0 — 室内定位 TCP 二进制帧 二次开发 Demo
==============================================================
TCP 客户端，向 C# 服务端 (TcpServerHelper) 发送三种设备的模拟定位帧。
同时展示每种设备的协议结构与实时数据。

协议版本: v1.0
帧格式:
  标准帧: FF FE | Type | Rsv | Len | Data(Len) | 55 AA
  兼容帧: FF FE | Type | Rsv | Len | Data(Len) | AA
"""

import struct
import socket
import threading
import time
import math
from datetime import datetime
import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox


# ============================================================================
# 帧构建器
# ============================================================================

class FrameBuilder:
    """构建符合协议 v1.0 的二进制帧"""

    HEADER = bytes([0xFF, 0xFE])
    TAIL_DUAL = bytes([0x55, 0xAA])
    TAIL_SINGLE = bytes([0xAA])

    # 协议常量
    DEV_TYPE_CAR = 0x01
    DEV_TYPE_DRONE = 0x02
    DEV_TYPE_SPECTRAL_DRONE = 0x03
    DEV_TYPE_SIGNAL_CONTROLLER = 0x04
    DEV_TYPE_FIRE_ACCIDENT = 0x05
    MSG_TYPE_POSITION = 0x01
    MSG_TYPE_GREEN_WAVE = 0x01  # 信号控制机: 绿波方案
    MSG_FIRE_TRIGGER = 0x01     # 火灾事故: 触发
    MSG_FIRE_CANCEL = 0x02      # 火灾事故: 取消

    @classmethod
    def build_car_position(cls, x: float, y: float, velocity: float, yaw: float) -> bytes:
        """轮式车定位帧: X8 Y8 Z8(0) Vel4 Yaw4, 大端, 双字节尾"""
        data = struct.pack('>dddff', x, y, 0.0, velocity, yaw)  # 32 bytes
        return cls.HEADER + bytes([cls.DEV_TYPE_CAR, cls.MSG_TYPE_POSITION, len(data)]) + data + cls.TAIL_DUAL

    @classmethod
    def build_drone_position(cls, x: float, y: float, z: float, velocity: float, yaw: float) -> bytes:
        """无人机定位帧: X8 Y8 Z8 Vel4 Yaw4, 大端, 双字节尾"""
        data = struct.pack('>dddff', x, y, z, velocity, yaw)  # 32 bytes
        return cls.HEADER + bytes([cls.DEV_TYPE_DRONE, cls.MSG_TYPE_POSITION, len(data)]) + data + cls.TAIL_DUAL

    @classmethod
    def build_spectral_position(cls, rigid_body_id: int, x_cm: int, y_cm: int) -> bytes:
        """光谱无人机定位帧: ID(1B) X(3B int24 cm) Y(3B int24 cm), 大端, 单字节尾"""
        data = bytes([rigid_body_id & 0xFF])
        data += cls._int24_be(x_cm)
        data += cls._int24_be(y_cm)
        return cls.HEADER + bytes([cls.DEV_TYPE_SPECTRAL_DRONE, cls.MSG_TYPE_POSITION, len(data)]) + data + cls.TAIL_SINGLE

    @classmethod
    def build_green_wave_plan(cls, plan_name: str) -> bytes:
        """信号控制机绿波方案帧: PlanName(UTF-8), 双字节尾"""
        data = plan_name.encode("utf-8")
        return cls.HEADER + bytes([cls.DEV_TYPE_SIGNAL_CONTROLLER, cls.MSG_TYPE_GREEN_WAVE, len(data)]) + data + cls.TAIL_DUAL

    @classmethod
    def build_fire_accident_trigger(cls, name: str, x: float, y: float,
                                     width: float = 0.0, height: float = 0.0) -> bytes:
        """火灾事故触发帧: Name(UTF-8) + X(float64,8B) + Y(float64,8B) [+ Width(float32,4B) + Height(float32,4B)], 大端, 双字节尾"""
        name_bytes = name.encode("utf-8")
        if width > 0 or height > 0:
            data = name_bytes + struct.pack('>ddff', x, y, width, height)
        else:
            data = name_bytes + struct.pack('>dd', x, y)
        return cls.HEADER + bytes([cls.DEV_TYPE_FIRE_ACCIDENT, cls.MSG_FIRE_TRIGGER, len(data)]) + data + cls.TAIL_DUAL

    @classmethod
    def build_fire_accident_cancel(cls, name: str) -> bytes:
        """火灾事故取消帧: Name(UTF-8), 双字节尾"""
        data = name.encode("utf-8")
        return cls.HEADER + bytes([cls.DEV_TYPE_FIRE_ACCIDENT, cls.MSG_FIRE_CANCEL, len(data)]) + data + cls.TAIL_DUAL

    @staticmethod
    def _int24_be(value: int) -> bytes:
        value &= 0xFFFFFF
        return bytes([(value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF])


# ============================================================================
# 设备模拟器 (运动轨迹生成)
# ============================================================================

class DeviceSimulator:
    """单个设备的运动模拟，每次调用 next() 返回 (帧bytes, 显示值dict)"""

    def __init__(self, dev_type: int, rigid_body_id: int = 0):
        self.dev_type = dev_type
        self.rigid_body_id = rigid_body_id
        self._t = 0.0

    def next(self, dt: float) -> tuple:
        self._t += dt

        if self.dev_type == 0x01:  # 轮式车 — 平面圆周
            r = 5.0
            x = r * math.cos(self._t * 0.5)
            y = r * math.sin(self._t * 0.5)
            vel = 1.5
            yaw = math.degrees(self._t * 0.5) % 360
            frame = FrameBuilder.build_car_position(x, y, vel, yaw)
            info = {"X": x, "Y": y, "Z": 0.0, "Vel": vel, "Yaw": yaw}
            return frame, info

        elif self.dev_type == 0x02:  # 无人机 — 3D 螺旋
            r = 4.0
            x = r * math.cos(self._t * 0.4)
            y = r * math.sin(self._t * 0.4)
            z = 2.0 + self._t * 0.3
            vel = 2.0 + 0.5 * math.sin(self._t)
            yaw = math.degrees(self._t * 0.6) % 360
            frame = FrameBuilder.build_drone_position(x, y, z, vel, yaw)
            info = {"X": x, "Y": y, "Z": z, "Vel": vel, "Yaw": yaw}
            return frame, info

        elif self.dev_type == 0x03:  # 光谱无人机 — 厘米级平面
            r = 300  # cm
            x_cm = int(r * math.cos(self._t * 0.5))
            y_cm = int(r * math.sin(self._t * 0.5))
            frame = FrameBuilder.build_spectral_position(self.rigid_body_id, x_cm, y_cm)
            info = {"刚体ID": self.rigid_body_id, "X(cm)": x_cm, "Y(cm)": y_cm,
                    "X(m)": x_cm / 100.0, "Y(m)": y_cm / 100.0}
            return frame, info

        return b'', {}


# ============================================================================
# TCP 发送器
# ============================================================================

class TcpSender:
    """后台线程 TCP 客户端，定时向服务端发送三台设备的定位帧"""

    def __init__(self):
        self._sock: socket.socket | None = None
        self._running = False
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

        self._devices: list[DeviceSimulator] = []
        self._enabled = [True, True, True]  # 三台设备是否启用
        self._interval = 0.5

        # 回调 (主线程安全由调用方通过 root.after 保证)
        self.on_log: callable = None     # (text: str)
        self.on_state: callable = None   # (connected: bool, msg: str)
        self.on_device_update: callable = None  # (dev_index: int, frame_hex: str, info: dict)

    # ---------- 连接 ----------

    def connect(self, host: str, port: int):
        self.disconnect()
        try:
            self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self._sock.settimeout(3.0)
            self._sock.connect((host, port))
            self._sock.settimeout(1.0)
        except Exception as e:
            self._sock = None
            if self.on_state:
                self.on_state(False, f"连接失败: {e}")
            return

        self._running = True
        self._init_devices()
        self._thread = threading.Thread(target=self._send_loop, daemon=True)
        self._thread.start()
        if self.on_state:
            self.on_state(True, f"已连接 {host}:{port}")

    def disconnect(self):
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        with self._lock:
            try:
                if self._sock:
                    self._sock.close()
            except Exception:
                pass
            self._sock = None
        if self.on_state:
            self.on_state(False, "已断开")

    @property
    def is_connected(self) -> bool:
        return self._running and self._sock is not None

    # ---------- 设备控制 ----------

    def _init_devices(self):
        self._devices = [
            DeviceSimulator(0x01),
            DeviceSimulator(0x02),
            DeviceSimulator(0x03, rigid_body_id=1),
        ]

    def set_enabled(self, index: int, enabled: bool):
        if 0 <= index < len(self._enabled):
            self._enabled[index] = enabled

    def set_interval(self, interval: float):
        self._interval = max(0.1, interval)

    def send_once(self, frame: bytes) -> bool:
        """单次发送一帧（非周期性），返回是否成功"""
        with self._lock:
            if self._sock:
                try:
                    self._sock.sendall(frame)
                    return True
                except Exception:
                    self._running = False
        return False

    # ---------- 发送循环 ----------

    def _send_loop(self):
        while self._running:
            for i, dev in enumerate(self._devices):
                if not self._enabled[i]:
                    continue

                frame, info = dev.next(self._interval)
                if not frame:
                    continue

                hex_str = frame.hex(' ').upper()

                # 发送
                ok = False
                with self._lock:
                    if self._sock:
                        try:
                            self._sock.sendall(frame)
                            ok = True
                        except Exception:
                            self._running = False

                if ok:
                    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
                    dev_names = ["轮式车", "无人机", "光谱无人机"]
                    if self.on_log:
                        self.on_log(f"[{ts}] → {dev_names[i]}: {hex_str}")
                    if self.on_device_update:
                        self.on_device_update(i, hex_str, info)

            time.sleep(self._interval)

        # 连接断开
        with self._lock:
            try:
                if self._sock:
                    self._sock.close()
            except Exception:
                pass
            self._sock = None
        if self.on_state:
            self.on_state(False, "连接断开")


# ============================================================================
# UI
# ============================================================================

class Application:
    TITLE = "沙盘集成平台通信协议 v1.0 — 室内定位 TCP 二进制帧 二次开发 Demo"

    # 字体配置
    FONT = ("Microsoft YaHei", 9)
    FONT_BOLD = ("Microsoft YaHei", 9, "bold")
    FONT_MONO = ("Consolas", 9)
    FONT_MONO_SM = ("Consolas", 8)
    FONT_DATA = ("Microsoft YaHei", 11)  # 实时数据大字

    # ---------- 三种设备的协议说明 ----------

    DEVICE_DEFS = [
        {
            "name": "轮式车",
            "type_hex": "0x01",
            "desc": "标准定位帧，Data 区 32 字节，双字节尾 55 AA",
            "proto": (
                "FF FE | 01 | 01 | 20 | "
                "X(float64,8B) Y(float64,8B) Z(float64,8B) "
                "Vel(float32,4B) Yaw(float32,4B) | "
                "55 AA"
            ),
            "data_fields": (
                "X: float64 大端, 偏移0, 8字节, 单位米\n"
                "Y: float64 大端, 偏移8, 8字节, 单位米\n"
                "Z: float64 大端, 偏移16, 8字节, 单位米 (地面车辆为0)\n"
                "Vel: float32 大端, 偏移24, 4字节, 单位米/秒\n"
                "Yaw: float32 大端, 偏移28, 4字节, 单位度"
            ),
        },
        {
            "name": "无人机",
            "type_hex": "0x02",
            "desc": "标准定位帧，Data 区 32 字节，双字节尾 55 AA（与轮式车相同结构）",
            "proto": (
                "FF FE | 02 | 01 | 20 | "
                "X(float64,8B) Y(float64,8B) Z(float64,8B) "
                "Vel(float32,4B) Yaw(float32,4B) | "
                "55 AA"
            ),
            "data_fields": (
                "X: float64 大端, 偏移0, 8字节, 单位米\n"
                "Y: float64 大端, 偏移8, 8字节, 单位米\n"
                "Z: float64 大端, 偏移16, 8字节, 单位米 (飞行高度)\n"
                "Vel: float32 大端, 偏移24, 4字节, 单位米/秒\n"
                "Yaw: float32 大端, 偏移28, 4字节, 单位度"
            ),
        },
        {
            "name": "光谱无人机",
            "type_hex": "0x03",
            "desc": "光谱定位帧，Data 区 7 字节，单字节尾 AA（兼容格式）",
            "proto": (
                "FF FE | 03 | 01 | 07 | "
                "RigidBodyId(uint8,1B) X(int24,3B,cm) Y(int24,3B,cm) | "
                "AA"
            ),
            "data_fields": (
                "RigidBodyId: uint8, 偏移0, 1字节, 刚体编号\n"
                "X: int24 有符号大端, 偏移1, 3字节, 单位厘米 (→ /100 = 米)\n"
                "Y: int24 有符号大端, 偏移4, 3字节, 单位厘米 (→ /100 = 米)\n"
                "注: 单字节尾 AA, 无 Z/Vel/Yaw 字段"
            ),
        },
    ]

    def __init__(self):
        self._sender = TcpSender()
        self._sender.on_log = self._handle_log
        self._sender.on_state = self._handle_state
        self._sender.on_device_update = self._handle_device_update

        self._root = tk.Tk()
        self._root.title(self.TITLE)
        self._root.state("zoomed")
        self._root.minsize(900, 650)
        self._root.protocol("WM_DELETE_WINDOW", self._on_close)

        self._build_toolbar()
        self._build_device_panels()
        self._build_signal_control_panel()
        self._build_fire_accident_panel()
        self._build_send_log()
        self._build_statusbar()

    # ======================== 工具栏 ========================

    def _build_toolbar(self):
        bar = ttk.Frame(self._root, padding=(8, 6))
        bar.pack(fill=tk.X)

        ttk.Label(bar, text="服务器 IP:").pack(side=tk.LEFT)
        self._entry_host = ttk.Entry(bar, width=14)
        self._entry_host.insert(0, "192.168.1.190")
        self._entry_host.pack(side=tk.LEFT, padx=(4, 10))

        ttk.Label(bar, text="端口:").pack(side=tk.LEFT)
        self._entry_port = ttk.Entry(bar, width=6)
        self._entry_port.insert(0, "5100")
        self._entry_port.pack(side=tk.LEFT, padx=(4, 12))

        ttk.Label(bar, text="间隔(s):").pack(side=tk.LEFT)
        self._entry_interval = ttk.Entry(bar, width=4)
        self._entry_interval.insert(0, "0.5")
        self._entry_interval.pack(side=tk.LEFT, padx=(4, 12))

        self._btn_connect = ttk.Button(bar, text="连接并发送", command=self._on_connect)
        self._btn_connect.pack(side=tk.LEFT, padx=(0, 6))

        self._btn_disconnect = ttk.Button(bar, text="停止", command=self._on_disconnect, state=tk.DISABLED)
        self._btn_disconnect.pack(side=tk.LEFT)

        # 状态灯
        self._canvas_status = tk.Canvas(bar, width=18, height=18, highlightthickness=0)
        self._canvas_status.pack(side=tk.LEFT, padx=(16, 6))
        self._led = self._canvas_status.create_oval(3, 3, 15, 15, fill="gray", outline="")

        self._lbl_state = ttk.Label(bar, text="未连接", foreground="gray")
        self._lbl_state.pack(side=tk.LEFT)

        ttk.Label(bar, text="  |  向 C# 服务端 (TcpServerHelper) 发送模拟定位帧",
                  foreground="#888").pack(side=tk.LEFT, padx=(10, 0))

    # ======================== 设备面板区 ========================

    def _build_device_panels(self):
        container = ttk.Frame(self._root)
        container.pack(fill=tk.BOTH, expand=True, padx=8, pady=(6, 0))

        self._device_frames: list[ttk.LabelFrame] = []
        self._device_labels: list[dict] = []   # 每个设备的动态标签引用
        self._device_hex_labels: list[ttk.Label] = []  # 帧 HEX 显示
        self._device_vars: list[tk.BooleanVar] = []

        for i, dev_def in enumerate(self.DEVICE_DEFS):
            lf = ttk.LabelFrame(container, text=f" {dev_def['name']} (Type={dev_def['type_hex']}) ", padding=(8, 6))
            lf.pack(fill=tk.X, pady=(0, 6))
            self._device_frames.append(lf)

            # --- 第1行: 协议结构 ---
            proto_frame = ttk.Frame(lf)
            proto_frame.pack(fill=tk.X)
            ttk.Label(proto_frame, text="协议结构:", font=self.FONT_BOLD).pack(side=tk.LEFT)
            ttk.Label(proto_frame, text=dev_def["proto"], foreground="#555",
                      font=("Consolas", 8)).pack(side=tk.LEFT, padx=(4, 0))

            # --- 第2行: Data 区说明 + 帧 HEX ---
            row2 = ttk.Frame(lf)
            row2.pack(fill=tk.X, pady=(4, 0))

            # 左侧: Data 区字段说明
            field_text = tk.Text(row2, height=4, width=52, font=("Consolas", 8),
                                 bg="#f5f5f5", relief=tk.FLAT, borderwidth=0,
                                 wrap=tk.NONE, state=tk.DISABLED)
            field_text.pack(side=tk.LEFT, fill=tk.X)

            # 让 Text 可选中但不可编辑
            field_text.configure(state=tk.NORMAL)
            field_text.insert("1.0", dev_def["data_fields"])
            field_text.configure(state=tk.DISABLED)

            # 右侧: 当前帧 HEX
            hex_frame = ttk.Frame(row2)
            hex_frame.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(8, 0))

            hex_lbl = ttk.Label(hex_frame, text="(等待发送...)", foreground="#999",
                                font=("Consolas", 8), anchor=tk.W, wraplength=400)
            hex_lbl.pack(fill=tk.X)
            self._device_hex_labels.append(hex_lbl)

            # --- 第3行: 实时数据 + 开关 ---
            row3 = ttk.Frame(lf)
            row3.pack(fill=tk.X, pady=(4, 0))

            info_labels = {}
            if i == 0:  # 轮式车: X Y Z Vel Yaw
                for field in ["X", "Y", "Z", "Vel", "Yaw"]:
                    lbl = ttk.Label(row3, text=f"{field}:--", font=("Consolas", 10),
                                    foreground="#0066cc")
                    lbl.pack(side=tk.LEFT, padx=(0, 16))
                    info_labels[field] = lbl
            elif i == 1:  # 无人机: X Y Z Vel Yaw
                for field in ["X", "Y", "Z", "Vel", "Yaw"]:
                    lbl = ttk.Label(row3, text=f"{field}:--", font=("Consolas", 10),
                                    foreground="#cc6600")
                    lbl.pack(side=tk.LEFT, padx=(0, 16))
                    info_labels[field] = lbl
            else:  # 光谱: 刚体ID X(cm) Y(cm) X(m) Y(m)
                for field in ["刚体ID", "X(cm)", "Y(cm)", "X(m)", "Y(m)"]:
                    lbl = ttk.Label(row3, text=f"{field}:--", font=("Consolas", 10),
                                    foreground="#009933")
                    lbl.pack(side=tk.LEFT, padx=(0, 16))
                    info_labels[field] = lbl

            self._device_labels.append(info_labels)

            # 启用开关
            var = tk.BooleanVar(value=True)
            self._device_vars.append(var)
            cb = ttk.Checkbutton(row3, text="发送", variable=var,
                                 command=lambda idx=i: self._on_toggle_device(idx))
            cb.pack(side=tk.RIGHT)

            # --- 分隔提示 ---
            ttk.Label(lf, text=dev_def["desc"], foreground="#888",
                      font=self.FONT).pack(anchor=tk.W, pady=(2, 0))

    # ======================== 信号控制机面板 (Type=0x04) ========================

    def _build_signal_control_panel(self):
        lf = ttk.LabelFrame(self._root, text=" 信号控制机 (Type=0x04) — 绿波方案下发 ", padding=(8, 6))
        lf.pack(fill=tk.X, padx=8, pady=(6, 0))

        # 协议结构
        proto_row = ttk.Frame(lf)
        proto_row.pack(fill=tk.X)
        ttk.Label(proto_row, text="协议结构:", font=self.FONT_BOLD).pack(side=tk.LEFT)
        proto_text = "FF FE | 04 | 01 | Len | PlanName(UTF-8, Len字节) | 55 AA"
        ttk.Label(proto_row, text=proto_text, foreground="#555",
                  font=("Consolas", 8)).pack(side=tk.LEFT, padx=(4, 0))

        # Data 区说明
        field_text = tk.Text(lf, height=2, width=52, font=("Consolas", 8),
                             bg="#f5f5f5", relief=tk.FLAT, borderwidth=0, wrap=tk.NONE)
        field_text.pack(fill=tk.X, pady=(4, 0))
        field_text.insert("1.0", "PlanName: UTF-8 字符串, 长度由 Len 字段指定\nC# 端收到后根据方案名称查本地文件并下发绿波配时方案")
        field_text.configure(state=tk.DISABLED)

        # 输入行: 方案名称 + 发送按钮 + 已发送的 HEX
        input_row = ttk.Frame(lf)
        input_row.pack(fill=tk.X, pady=(6, 0))

        ttk.Label(input_row, text="方案名称:", font=self.FONT_BOLD).pack(side=tk.LEFT)
        self._entry_plan_name = ttk.Entry(input_row, width=24, font=self.FONT)
        self._entry_plan_name.insert(0, "绿波方案1")
        self._entry_plan_name.pack(side=tk.LEFT, padx=(4, 10))

        self._btn_send_plan = ttk.Button(input_row, text="发送绿波方案", command=self._on_send_plan)
        self._btn_send_plan.pack(side=tk.LEFT)

        self._lbl_plan_sent = ttk.Label(input_row, text="(未发送)", foreground="#999",
                                         font=("Consolas", 8))
        self._lbl_plan_sent.pack(side=tk.LEFT, padx=(12, 0))

        ttk.Label(lf, text="手动发送，非周期性；C# 端根据方案名称匹配本地绿波配置文件",
                  foreground="#888", font=self.FONT).pack(anchor=tk.W, pady=(4, 0))

    # ======================== 火灾事故面板 (Type=0x05) ========================

    def _build_fire_accident_panel(self):
        lf = ttk.LabelFrame(self._root, text=" 火灾事故 (Type=0x05) — 触发 / 取消 ", padding=(8, 6))
        lf.pack(fill=tk.X, padx=8, pady=(6, 0))

        # 协议结构
        proto_row = ttk.Frame(lf)
        proto_row.pack(fill=tk.X)
        ttk.Label(proto_row, text="协议结构:", font=self.FONT_BOLD).pack(side=tk.LEFT)
        proto_text = (
            "触发: FF FE | 05 | 01 | Len | Name(UTF-8) X(float64,8B) Y(float64,8B) | 55 AA\n"
            "取消: FF FE | 05 | 02 | Len | Name(UTF-8) | 55 AA"
        )
        ttk.Label(proto_row, text=proto_text, foreground="#555",
                  font=("Consolas", 8)).pack(side=tk.LEFT, padx=(4, 0))

        # Data 区说明
        field_text = tk.Text(lf, height=2, width=52, font=("Consolas", 8),
                             bg="#f5f5f5", relief=tk.FLAT, borderwidth=0, wrap=tk.NONE)
        field_text.pack(fill=tk.X, pady=(4, 0))
        field_text.insert("1.0",
            "触发: Name(UTF-8) + X(float64 BE) + Y(float64 BE), 坐标逻辑与无人机一致 (米)\n"
            "取消: Name(UTF-8), 按名称移除地图上的火灾图标")
        field_text.configure(state=tk.DISABLED)

        # 输入行
        input_row = ttk.Frame(lf)
        input_row.pack(fill=tk.X, pady=(6, 0))

        ttk.Label(input_row, text="事故名称:", font=self.FONT_BOLD).pack(side=tk.LEFT)
        self._entry_fire_name = ttk.Entry(input_row, width=14, font=self.FONT)
        self._entry_fire_name.insert(0, "火灾点1")
        self._entry_fire_name.pack(side=tk.LEFT, padx=(4, 10))

        ttk.Label(input_row, text="X(米):", font=self.FONT_BOLD).pack(side=tk.LEFT)
        self._entry_fire_x = ttk.Entry(input_row, width=6, font=self.FONT)
        self._entry_fire_x.insert(0, "3.0")
        self._entry_fire_x.pack(side=tk.LEFT, padx=(4, 8))

        ttk.Label(input_row, text="Y(米):", font=self.FONT_BOLD).pack(side=tk.LEFT)
        self._entry_fire_y = ttk.Entry(input_row, width=6, font=self.FONT)
        self._entry_fire_y.insert(0, "3.0")
        self._entry_fire_y.pack(side=tk.LEFT, padx=(4, 8))

        ttk.Label(input_row, text="宽(px):", font=self.FONT_BOLD).pack(side=tk.LEFT)
        self._entry_fire_w = ttk.Entry(input_row, width=5, font=self.FONT)
        self._entry_fire_w.insert(0, "64")
        self._entry_fire_w.pack(side=tk.LEFT, padx=(4, 8))

        ttk.Label(input_row, text="高(px):", font=self.FONT_BOLD).pack(side=tk.LEFT)
        self._entry_fire_h = ttk.Entry(input_row, width=5, font=self.FONT)
        self._entry_fire_h.insert(0, "64")
        self._entry_fire_h.pack(side=tk.LEFT, padx=(4, 12))

        self._btn_fire_trigger = ttk.Button(input_row, text="触发火灾",
                                             command=self._on_fire_trigger)
        self._btn_fire_trigger.pack(side=tk.LEFT, padx=(0, 6))

        self._btn_fire_cancel = ttk.Button(input_row, text="取消火灾",
                                            command=self._on_fire_cancel)
        self._btn_fire_cancel.pack(side=tk.LEFT)

        self._lbl_fire_sent = ttk.Label(input_row, text="(未发送)", foreground="#999",
                                         font=("Consolas", 8))
        self._lbl_fire_sent.pack(side=tk.LEFT, padx=(12, 0))

        ttk.Label(lf, text="触发 → 地图显示 ic_fire 图标 | 取消 → 按名称移除图标 | 坐标与无人机定位一致",
                  foreground="#888", font=self.FONT).pack(anchor=tk.W, pady=(4, 0))

    # ======================== 发送日志 ========================

    def _build_send_log(self):
        frame = ttk.LabelFrame(self._root, text="发送日志", padding=(6, 4))
        frame.pack(fill=tk.BOTH, expand=True, padx=8, pady=(6, 0))

        header_bar = ttk.Frame(frame)
        header_bar.pack(fill=tk.X)
        ttk.Label(header_bar, text="").pack(side=tk.LEFT)
        self._btn_clear_log = ttk.Button(header_bar, text="清空", command=self._clear_log)
        self._btn_clear_log.pack(side=tk.RIGHT)

        self._log = scrolledtext.ScrolledText(frame, height=6, state=tk.DISABLED,
                                               font=("Consolas", 9), wrap=tk.NONE,
                                               bg="#1e1e1e", fg="#d4d4d4")
        self._log.pack(fill=tk.BOTH, expand=True)

    # ======================== 状态栏 ========================

    def _build_statusbar(self):
        self._status_var = tk.StringVar(value="就绪 | 请点击「连接并发送」")
        self._statusbar = ttk.Label(self._root, textvariable=self._status_var,
                                     relief=tk.SUNKEN, anchor=tk.W, padding=(6, 2))
        self._statusbar.pack(fill=tk.X, side=tk.BOTTOM, padx=8, pady=(6, 6))

    # ======================== 回调 (主线程) ========================

    def _handle_log(self, text: str):
        self._root.after(0, self._append_log, text)

    def _handle_state(self, connected: bool, msg: str):
        self._root.after(0, self._update_state, connected, msg)

    def _handle_device_update(self, dev_index: int, frame_hex: str, info: dict):
        self._root.after(0, self._update_device_ui, dev_index, frame_hex, info)

    # ======================== UI 更新 ========================

    def _append_log(self, text: str):
        self._log.configure(state=tk.NORMAL)
        self._log.insert(tk.END, text + "\n")
        self._log.see(tk.END)
        self._log.configure(state=tk.DISABLED)

    def _update_state(self, connected: bool, msg: str):
        if connected:
            self._set_led("#00cc00")
            self._lbl_state.configure(text=msg, foreground="#008800")
            self._btn_connect.configure(state=tk.DISABLED)
            self._btn_disconnect.configure(state=tk.NORMAL)
            self._status_var.set(f"运行中 | 向 {self._entry_host.get()}:{self._entry_port.get()} 发送定位帧")
        else:
            self._set_led("gray")
            self._lbl_state.configure(text=msg, foreground="gray")
            self._btn_connect.configure(state=tk.NORMAL)
            self._btn_disconnect.configure(state=tk.DISABLED)
            self._status_var.set(msg)

    def _update_device_ui(self, dev_index: int, frame_hex: str, info: dict):
        if dev_index >= len(self._device_hex_labels):
            return

        # 更新 HEX 标签
        self._device_hex_labels[dev_index].configure(
            text=frame_hex, foreground="#333")

        # 更新实时数据标签
        labels = self._device_labels[dev_index]
        for key, lbl in labels.items():
            if key in info:
                val = info[key]
                if isinstance(val, float):
                    lbl.configure(text=f"{key}:{val:.3f}")
                else:
                    lbl.configure(text=f"{key}:{val}")

    def _set_led(self, color: str):
        self._canvas_status.itemconfig(self._led, fill=color)

    # ======================== 事件 ========================

    def _on_connect(self):
        host = self._entry_host.get().strip()
        port_str = self._entry_port.get().strip()
        interval_str = self._entry_interval.get().strip()

        if not host or not port_str:
            messagebox.showwarning("提示", "请输入服务器 IP 和端口")
            return
        try:
            port = int(port_str)
            interval = float(interval_str)
        except ValueError:
            messagebox.showwarning("提示", "端口/间隔必须为数字")
            return

        self._sender.set_interval(interval)
        self._sender._enabled = [v.get() for v in self._device_vars]
        self._sender.connect(host, port)

    def _on_disconnect(self):
        self._sender.disconnect()

    def _on_toggle_device(self, index: int):
        self._sender.set_enabled(index, self._device_vars[index].get())

    def _on_send_plan(self):
        """手动发送绿波方案"""
        plan_name = self._entry_plan_name.get().strip()
        if not plan_name:
            messagebox.showwarning("提示", "请输入方案名称")
            return

        if not self._sender or not self._sender.is_connected:
            messagebox.showwarning("提示", "请先连接服务器")
            return

        frame = FrameBuilder.build_green_wave_plan(plan_name)
        hex_str = frame.hex(' ').upper()

        ok = self._sender.send_once(frame)
        if ok:
            ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
            self._append_log(f"[{ts}] → 信号控制机(绿波方案): {hex_str}")
            self._lbl_plan_sent.configure(text=f"已发送: {hex_str}", foreground="#006600")
        else:
            self._lbl_plan_sent.configure(text="发送失败", foreground="red")

    def _on_fire_trigger(self):
        """触发火灾事故"""
        name = self._entry_fire_name.get().strip()
        if not name:
            messagebox.showwarning("提示", "请输入事故名称")
            return
        if not self._sender or not self._sender.is_connected:
            messagebox.showwarning("提示", "请先连接服务器")
            return
        try:
            x = float(self._entry_fire_x.get().strip())
            y = float(self._entry_fire_y.get().strip())
            w = float(self._entry_fire_w.get().strip())
            h = float(self._entry_fire_h.get().strip())
        except ValueError:
            messagebox.showwarning("提示", "坐标/宽高必须为数字")
            return

        frame = FrameBuilder.build_fire_accident_trigger(name, x, y, w, h)
        hex_str = frame.hex(' ').upper()

        ok = self._sender.send_once(frame)
        if ok:
            ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
            self._append_log(f"[{ts}] → 火灾事故(触发): {name} X={x} Y={y} W={w} H={h} | {hex_str}")
            self._lbl_fire_sent.configure(
                text=f"已触发: {name} ({x},{y}) {w}x{h}", foreground="#cc0000")
        else:
            self._lbl_fire_sent.configure(text="发送失败", foreground="red")

    def _on_fire_cancel(self):
        """取消火灾事故"""
        name = self._entry_fire_name.get().strip()
        if not name:
            messagebox.showwarning("提示", "请输入事故名称")
            return
        if not self._sender or not self._sender.is_connected:
            messagebox.showwarning("提示", "请先连接服务器")
            return

        frame = FrameBuilder.build_fire_accident_cancel(name)
        hex_str = frame.hex(' ').upper()

        ok = self._sender.send_once(frame)
        if ok:
            ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
            self._append_log(f"[{ts}] → 火灾事故(取消): {name} | {hex_str}")
            self._lbl_fire_sent.configure(
                text=f"已取消: {name}", foreground="#006600")
        else:
            self._lbl_fire_sent.configure(text="发送失败", foreground="red")

    def _clear_log(self):
        self._log.configure(state=tk.NORMAL)
        self._log.delete("1.0", tk.END)
        self._log.configure(state=tk.DISABLED)

    def _on_close(self):
        self._sender.disconnect()
        self._root.destroy()

    # ======================== 启动 ========================

    def run(self):
        self._root.mainloop()


if __name__ == "__main__":
    app = Application()
    app.run()

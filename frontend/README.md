# Fire 前端与Bridge

启动及安装见[根README](../README.md)，算法接入见[HANDOFF_README](../HANDOFF_README.md)。

frontend/bridge/server.py是网页Bridge，web/src是React前端。start-bridge.ps1与start-web.ps1分别启动8080和5173端口。Node≥22.12，Python默认项目.venv，可用FIRE_PYTHON覆盖。

已完成地图、415项POI解析、车辆/行人动画和逐批候选/历史/Top1展示。真实算法目前仅输出原始8个储罐候选；扩展住宅显示曾经通过模拟验证，扩展推理尚待算法侧实现。接口见[integration/FRONTEND_API_CONTRACT.md](../integration/FRONTEND_API_CONTRACT.md)。

本目录只保留正式代码和原项目已有测试；默认测试入口可能执行100条演示任务，启动检查时不要无意触发。不会自动调用Live模型。

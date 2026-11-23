# Fire 前端与Bridge

启动及安装见[根README](../README.md)，算法接入见[HANDOFF_README](../HANDOFF_README.md)。

`frontend/bridge/server.py` 是网页桥接，`web/src` 是 React 前端。用根目录的 `bash start.sh` 一起启动 SocialNet 帖子源（8000）、桥接（8080）和前端（5173）。Python 使用 Anaconda `agent`，Node.js 至少为 22.12。

已完成地图、415项POI解析、车辆/行人动画和逐批候选/历史/Top1展示。真实算法目前仅输出原始8个储罐候选；扩展住宅显示曾经通过模拟验证，扩展推理尚待算法侧实现。接口见[integration/FRONTEND_API_CONTRACT.md](../integration/FRONTEND_API_CONTRACT.md)。

主页面在确认启动后订阅 SocialNet 初筛火情帖，每三条发布一批定位。浏览器流式回归 `e2e/opinion.spec.ts` 使用模拟接口，可以设置 `FIRE_E2E_MOCK_ONLY=1` 仅启动前端进行验证。

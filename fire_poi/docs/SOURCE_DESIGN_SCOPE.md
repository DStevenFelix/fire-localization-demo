# 定位设计来源与采用范围

用户指定来源：[城市异常定位系统梳理](https://chatgpt.com/share/6adb3ae5-1700-83ea-a5bb-9d140475b8a8)。本轮已读取公开分享页面中的设计内容。

仅采用以下系统设计原则：

1. 舆情告警JSON → 输入校验 → Location Parser → Entity Normalizer → Spatial Search → Candidate Resolver → LocalizationResult。
2. LLM理解目标、参照物、方位、道路和区域提示；坐标只能由确定性程序从当前空间模型读取。
3. 明确名称优先，支持别名、相对位置；只有区域、多候选或缺参照时保留ambiguous，不强猜火点。
4. 输出located / ambiguous / not_found / invalid，携带event_id、证据和候选；event_id贯穿链路。
5. 上下游通过JSON/Socket解耦；具体TCP还是WebSocket需匹配已有fire代码。纯空间内核先验收，再接解析器、传输和前端。

**不采用该历史页面的任何旧POI数据、ID、对象用途推断、空间关系阈值、旧地图、旧路口连通或米制坐标声明。** 本轮全部实体几何只来自《沙盘模拟图(5).png》，单位为30×25局部仿真单位。

旧设计的distance_m、x_m、y_m在本包新契约中改为distance.value+unit、x、y。若已有fire接口使用旧字段，需在适配层明确转换字段并携带unit，不可假称仿真坐标是真实米数。尚未检查用户本地fire仓库，本包不声称已与其现有接口完成联调。

本包脚本仅实现确定性数据查询、有限结构化查询与按通行方式的抽象路径查询；未实现通用自然语言Parser、Socket服务、多帖聚类或生产级置信度校准。

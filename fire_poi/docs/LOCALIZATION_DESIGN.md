# 当前地图的定位流程设计

## 责任边界

Alert校验层核对事件字段；Location Parser只解析文本；Normalizer根据当前名称、别名、旧ID映射归一化；Spatial Search执行确定性几何与关系检索；Resolver决定located/ambiguous并给证据；Transport只收发业务JSON。目标实体与报告人/参照物必须分开。

## 查询策略

- 明确地址：正式名→别名→中文数字规范化→唯一POI→从规范数据读中心。
- 参照物+隔路：唯一reference、跨越当前有限道路几何的across_road候选、target_type过滤、道路提示；无“最近”等明确约束时保留多候选。
- 方位：目标中心相对参照中心的8扇区方向；方位可对区域中心定义，但这只是模型约定，不代表实际观察者朝向。
- 邻近：near与adjacent的阈值见config，使用对象边界距离；不能把全城未预计算关系解释为“绝不附近”。
- 只有区域：返回区域内候选与ambiguous；不输出区域形心当作精确火点。
- 信息缺失或冲突：missing reference→ambiguous；不存在的名称→not_found；格式非法→invalid。

## 当前辅助代码与后续实现

本包query只对结构化查询工作，直接匹配与关系筛选可复现。多来源证据融合、多帖子时间窗口聚类、语义消歧评分和LLM Parser仍需在fire项目中实现。当前启发式confidence不代表真实准确率。

定位输出坐标必须与POI.json及当前底图版本一致；解析器输入中的任意坐标字段均不接收。未来需要“建筑外某方向若干仿真单位”的连续点定位时，应新增明确几何结果类型和证据，不借用某个POI ID伪装该连续点。

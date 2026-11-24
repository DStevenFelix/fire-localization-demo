// 在此注册真实传输适配器。工作台切到真实联动时调用，离开时统一退订。
// 收到现场协议后，在这里调用 connectDashboardSource，传入订阅、字段映射、设备 ID 和标定。
export function connectPhysicalDashboardSource(): void {
  // 现场传输和消息格式待确认。当前部署无默认设备订阅。
}

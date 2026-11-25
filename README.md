# gpu-ecc-failure-drain-planner

离线 GPU drain 规划器：根据 ECC 历史增长速率、Xid 事件、任务 checkpoint、
剩余运行时间、备用 GPU 型号与故障域，计算 GPU drain 顺序、任务迁移方案、
风险窗口和不可恢复作业。

## 不访问真实 GPU

本工具是**纯离线规划器**：不访问真实 GPU，不调用 `nvidia-smi`、NVML、DCGM
或任何驱动接口，也不执行真实的 drain / 迁移 / 隔离动作。所有 ECC 计数、
Xid 事件、checkpoint 状态和备用设备信息都来自调用方提供的 JSON 输入，
输出仅为规划建议（JSON），由外部调度系统执行。

## 运行环境

- Node.js `24.16.0`（ESM，零第三方依赖，无需 `npm install`）

## 运行测试

```bash
node --test
```

或：

```bash
npm test
```

测试覆盖：

- 可纠正 ECC 错误增长速率排序与风险窗口长度
- 不可纠正 ECC / 严重 Xid 优先隔离
- 备用 GPU 不足时的按优先级分配与缺口报告
- checkpoint 缺失：可等待下一个 checkpoint、等待超上限、来不及 checkpoint
- 短任务在安全窗口内就地完成
- 迁移后故障 GPU 隔离且不可重新分配
- 备用 GPU 故障域偏好
- CLI 与示例集群端到端

## CLI 用法

```bash
node src/cli.js examples/cluster.json
cat examples/cluster.json | node src/cli.js
```

编程接口：

```js
import { planDrain, applyPlanToInventory, isGpuAssignable } from './src/drain-planner.js';

const plan = planDrain(input);
console.log(plan.drainOrder, plan.migrations, plan.unrecoverableJobs);

isGpuAssignable('gpu-0', plan); // false：已 drain 并隔离
applyPlanToInventory(input, plan);
```

## 输入格式

时间均为“距现在的分钟数”（`minutesAgo` / `remainingMinutes` /
`nextCheckpointEtaMinutes`）。ECC 计数为**累计计数器**快照。

```jsonc
{
  "config": { "maxUncheckpointedWaitMinutes": 30 }, // 可选，覆盖默认策略
  "gpus": [
    {
      "id": "gpu-0",
      "model": "A100-80GB",                 // 用于备用 GPU 型号兼容
      "faultDomain": "rack-a",             // 机架 / 交换机等故障域
      "eccHistory": [                      // 累计 ECC 计数快照
        { "minutesAgo": 60, "correctable": 0, "uncorrectable": 0 },
        { "minutesAgo": 0,  "correctable": 60, "uncorrectable": 0 }
      ],
      "xidEvents": [ { "code": 92, "minutesAgo": 9 } ]
    }
  ],
  "tasks": [
    {
      "id": "job-1",
      "gpuId": "gpu-0",
      "remainingMinutes": 240,             // 预计剩余运行时间
      "priority": 10,                      // 可选，备用争抢时优先
      "checkpoint": {
        "available": false,                // 是否存在可用 checkpoint
        "ageMinutes": 8,                   // 可选，checkpoint 年龄
        "nextCheckpointEtaMinutes": 12     // 下一次 checkpoint 预计时间
      }
    }
  ],
  "spareGpus": [
    { "id": "spare-1", "model": "A100-80GB", "faultDomain": "rack-b" }
  ]
}
```

## 规划规则

**严重度与 drain 顺序**

- `critical`：存在不可纠正 ECC（`uncorrectable > 0`）或严重 Xid
  （默认 `48`、`79`，可通过 `config.criticalXidCodes` 配置），
  `drainWithinMinutes = 0`，立即隔离，排在最前。
- 其余 GPU 只看可纠正错误增长速率：对累计计数做最小二乘回归得到
  每小时增长数；`>=40/h` 为 `high`，`>=10/h` 为 `elevated`，`>0` 为 `watch`。
- 安全窗口由增长速率外推：再累积 `correctableErrorBudget`（默认 50）
  个可纠正错误所需的时间，并夹在 15–480 分钟之间；增长越快窗口越短。
- 排序键：严重度 → 增长速率 → 不可纠正计数 → 同故障域待 drain 设备数
  → 任务数 → GPU ID。

**任务动作**

- `complete_in_place`：非 critical GPU 上，剩余时间不超过安全窗口，
  允许任务就地跑完，不占用备用 GPU。
- `migrate_checkpoint`：有可用 checkpoint，立即迁移恢复。
- `wait_for_checkpoint`：没有 checkpoint，但下一次 checkpoint 的 ETA
  同时满足 `ETA <= maxUncheckpointedWaitMinutes`（默认 30 分钟，
  **等待有上限，不会无限等待**）且 `ETA + 迁移开销 <= GPU 安全窗口`。
- `restart_no_checkpoint`：无 checkpoint 且在限制内等不到可用 checkpoint，
  既有进度不可恢复，进入 `unrecoverableJobs`；若有备用 GPU 则从空白重启，
  没有备用 GPU 时标记 `blocked_no_spare`。

**备用 GPU 分配**

- 型号必须兼容（同型号，或出现在 `compatibleModels` 中）。
- 按 GPU drain 顺序、任务 `priority`、可恢复优先的顺序分配，一卡一任务。
- 优先选择与源 GPU **不同故障域**、且目标故障域已分配数更少的备用卡。
- 备用不足时后续任务为 `blocked_no_spare`，`spares.shortfall`
  给出缺口数量；有 checkpoint 的阻塞任务仍可在备用到位后恢复，
  因此不计入“不可恢复作业”。

**迁移后状态**

- 所有进入 `drainOrder` 的 GPU 都进入 `quarantinedGpuIds`，
  `isGpuAssignable(id, plan)` 对其返回 `false`，即迁移后故障 GPU
  **不能重新分配**给新任务。
- 已被迁移任务占用的备用 GPU 同样不再参与新分配。

## 输出结构（摘要）

```jsonc
{
  "drainOrder": ["gpu-0", "gpu-1"],        // drain 先后顺序
  "gpuAssessments": [ /* 速率、严重度、原因码 */ ],
  "migrations": [
    {
      "taskId": "job-1",
      "gpuId": "gpu-0",
      "action": "migrate_checkpoint",      // 或 wait_for_checkpoint / restart_no_checkpoint
      "status": "planned",                 // 或 blocked_no_spare
      "targetGpuId": "spare-1",
      "waitMinutes": 0,
      "exposureEndMinutes": 5,
      "recoverable": true
    }
  ],
  "inPlaceCompletions": [ /* 安全窗口内可跑完的任务 */ ],
  "riskWindows": [
    {
      "gpuId": "gpu-0",
      "safeWindowMinutes": 0,
      "plannedClearMinute": 5,
      "withinSafeWindow": false,           // critical 上迁移存在残余风险
      "riskExceeded": true,
      "notes": ["ISOLATE_IMMEDIATELY_RESIDUAL_MIGRATION_RISK"]
    }
  ],
  "unrecoverableJobs": [
    { "taskId": "job-beta", "lostProgress": true, "reasons": ["CHECKPOINT_WAIT_EXCEEDS_LIMIT"] }
  ],
  "quarantinedGpuIds": ["gpu-0"],
  "spares": { "usedSpareIds": [], "availableSpareIds": [], "shortfall": 0 },
  "summary": { /* 各类计数 */ }
}
```

## 主要可配置项

见 `src/drain-planner.js` 中的 `DEFAULT_CONFIG`，均可通过输入的
`config` 字段覆盖：速率分级阈值、错误预算、窗口上下限、
未 checkpoint 任务最大等待时间、迁移开销、checkpoint 过期年龄、
是否允许窗口内就地完成、严重/警告 Xid 码表。

Xid 码表只是可配置的规划输入，不构成 NVIDIA 诊断结论；
实际处置请结合厂商工具与现场流程。

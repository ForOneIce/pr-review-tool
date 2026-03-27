# 开发视角流程图（简洁版）

```mermaid
flowchart TD
    CFG[读取周配置<br/>--week-config 或 week1Deadline推导] --> A[拉取 open PR 并按编号升序]
    A --> B{open PR 数量为 0?}
    B -- 是 --> END0[结束: 不输出报告, 不写日志]
    B -- 否 --> P[逐条 PR 检查并生成 actions/path]

    P --> S00{pre-0: 删除多个顶层目录?}
    S00 -- 是 --> O00[评论+Close]
    S00 -- 否 --> S0{0: 有新增 .sol?}
    S0 -- 否 --> O0[评论+Close]
    S0 -- 是 --> S05{0.5: 新增文件夹名含空格?}
    S05 -- 是 --> O05[评论+Close]
    S05 -- 否 --> S1{1: 命名检查}

    S1 -- 无 day --> O11[评论+Close]
    S1 -- 合规 --> S2{2: 标题合规?}
    S2 -- 否 --> O2[改标题]
    S2 -- 是 --> S3
    O2 --> S3{3: 路径归属合规?}

    S3 -- 根目录直提/触碰 bala/触碰他人目录 --> O3[评论+Close]
    S3 -- 是 --> S40{4-0: 新增sol全是空白改动?}
    S40 -- 是 --> O40[评论空白改动+Close]
    S40 -- 否 --> S4{4-1: solc 编译通过?}
    S4 -- 否 --> O4[评论具体失败文件+Close]
    S4 -- 是 --> OK[结论: 待人工审核]
    OK --> LATE{按最大day匹配week并判定超时?}
    LATE -- 是 --> OLT[追加超时评论<br/>当前仅评论, 未打label]
    LATE -- 否 --> RPT
    OLT --> RPT

    O00 --> RPT
    O0 --> RPT
    O05 --> RPT
    O11 --> RPT
    O2 --> RPT
    O3 --> RPT
    O40 --> RPT
    O4 --> RPT
    RPT[输出 Excel 报告(check_result + week_stats) + 执行摘要]

    RPT --> M{--apply ?}
    M -- 否 --> END1[预览模式结束]
    M -- 是 --> E0{命中动作数为 0?}
    E0 -- 是 --> END2[结束: 无需执行]
    E0 -- 否 --> C{--yes 或人工确认执行?}
    C -- 否 --> END3[取消执行]
    C -- 是 --> EX[执行 actions]

    EX --> MG{merge 成功且今天是 3/8?}
    MG -- 是 --> CM[追加评论: PR已成功提交！妇女节快乐~]
    MG -- 否 --> NX[继续]
    CM --> NX[继续]

    NX --> F{是否有失败项?}
    F -- 否 --> END4[结束: 输出成功/失败摘要]
    F -- 是 --> RY{--yes ?}
    RY -- 是 --> END5[结束: 保留失败项]
    RY -- 否 --> ASK{是否重试失败项?}
    ASK -- 是 --> EX
    ASK -- 否 --> END5
```


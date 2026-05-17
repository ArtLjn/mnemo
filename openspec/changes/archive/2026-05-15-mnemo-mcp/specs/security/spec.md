## ADDED Requirements

### Requirement: 提示注入检测
系统 SHALL 检测记忆内容中的提示注入尝试（伪造围栏标签、system-reminder 伪装、注入指令模式）。

#### Scenario: 检测到注入
- **WHEN** 添加的内容包含 `<memory-context>` 标签或 "ignore previous instructions" 模式
- **THEN** 返回结果中包含 warnings 字段标记风险

#### Scenario: 安全内容
- **WHEN** 添加的内容无注入特征
- **THEN** 正常存储，不附加 warnings

### Requirement: PII 检测
系统 SHALL 检测记忆内容中的个人信息（邮箱、API 密钥模式）。

#### Scenario: 检测到邮箱
- **WHEN** 添加的内容包含邮箱地址
- **THEN** 返回 warnings 字段提示"包含邮箱地址"，但不阻止存储

#### Scenario: 检测到 API 密钥
- **WHEN** 添加的内容匹配 API 密钥模式（sk-xxx、ghp_xxx 等）
- **THEN** 返回 warnings 字段提示"包含 API 密钥模式"

### Requirement: 不可见 Unicode 检测
系统 SHALL 检测记忆内容中的不可见 Unicode 字符（零宽字符、控制字符、BOM 等）。

#### Scenario: 零宽字符检测
- **WHEN** 添加的内容包含 U+200B~U+200F 范围的零宽字符
- **THEN** 返回 warnings 字段提示具体字符类型

### Requirement: 安全警告不阻止操作
系统 SHALL 将安全检测结果作为 warnings 返回，不阻止事实的存储或检索操作。

#### Scenario: 有警告但操作成功
- **WHEN** 添加的事实通过安全扫描发现 PII
- **THEN** 事实正常存储，响应中附加 `"warnings": ["包含邮箱地址"]` 字段

---
# type is an agent suggestion; wrong-answer entries use incident by default.
type: incident
date: YYYY-MM-DD
status: draft
sensitivity: internal
verification: unverified
applicability:
  - <适用场景>
non_applicable: []
source_refs:
  - <证据指针，例如 session:<id> 或 logs/...>
migrated_from: null
---

# 不要再用 <错误方案> 解决 <问题>

## 场景

描述问题背景、触发条件和约束。

## 错误做法

描述被证明无效或错误的方案、假设或路径。

## 失败结果

描述观察到的失败现象、错误输出或验证结果。

## 结论

提炼为什么该做法无效，以及硬证据是什么。

## 下次规则

未来遇到类似场景时禁止重复的事项，以及推荐的替代方向。

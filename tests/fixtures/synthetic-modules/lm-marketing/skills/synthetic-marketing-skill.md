---
id: synthetic-marketing-skill
kind: skill
synthetic: true
---

# Synthetic Marketing Skill (W0-A7 fixture)

This is a DATA-ONLY fixture skill. It exists so the Wave 2 resource resolver
and Wave 5 AgentLaunchSpec assembler can prove module-relative skill resolution
without depending on a global `skills/` lookup (plan §5.3, §13.17).

Do NOT execute this skill against a real worker. It carries no operative
instructions — it is a placeholder for contract shape.

What it deliberately omits:
- No real prompt engineering.
- No tracker / hook / MCP behavior.
- No reference to any production skill (saga-worker, saga-product, etc.).

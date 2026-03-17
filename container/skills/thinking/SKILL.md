---
name: thinking
description: Report recent Claude vs Ollama usage stats. Invoke when the user sends /thinking (or asks "how many times have you used Ollama/Claude").
allowed-tools: Bash(thinking:*)
---

# /thinking

When the user sends `/thinking`, run:

```bash
thinking
```

Relay the output verbatim. Do not add commentary, do not re-summarize, do not call any other tools. Just print the two lines from the script.

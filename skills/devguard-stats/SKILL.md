---
name: devguard:stats
description: Show DevGuard session and project statistics
---

Run the following command and show its output to the user:

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/cli/stats.js" --project "${CLAUDE_PROJECT_DIR}"
```

If the user asks for a session-scoped view ("this session", "last session", "session"):

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/cli/stats.js" --project "${CLAUDE_PROJECT_DIR}" --session
```

Show the output to the user as-is (markdown format).

---
name: devguard:dogfood
description: Classify DevGuard detection events and build an effectiveness report
---

Use this skill at the end of a session to evaluate DevGuard's warn decisions.

## Flow

### 1. List unclassified events

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/cli/dogfood.js" --project "${CLAUDE_PROJECT_DIR}" --list --session
```

### 2. Show each event to the user and ask for a classification

For each event, show the user:
- Decision (warn), file, level, message
- Ask: "Was this detection justified? (tp/fp)"

Based on the answer:

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/cli/dogfood.js" --project "${CLAUDE_PROJECT_DIR}" --classify <id> --as <tp|fp> --note "user note"
```

### 3. Ask about missed cycles

Ask the user: "Was there a repetition loop DevGuard missed?"

If so:

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/cli/dogfood.js" --project "${CLAUDE_PROJECT_DIR}" --add-fn --session --note "description"
```

### 4. Show the cumulative report

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/cli/dogfood.js" --project "${CLAUDE_PROJECT_DIR}" --report
```

Show the output to the user as-is (markdown format).

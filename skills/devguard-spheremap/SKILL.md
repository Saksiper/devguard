---
name: devguard:spheremap
description: Generate DevGuard's feature-sphere map as an interactive HTML file and show its path
---

Run the command below. It renders the current project's sphere (continent = domain,
country = feature node, edge = semantic neighbor, tooltip = layered note chain) as an
interactive HTML map. The embedding model is NOT loaded (edges are computed from stored
centroids), so it is fast.

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/dg-spheremap.js" "$(node -e "console.log(require('${CLAUDE_PLUGIN_ROOT}/src/engine/db').getDbPath())")" "${CLAUDE_PROJECT_DIR}/devguard-sphere-map.html" "${CLAUDE_PROJECT_DIR}" "$(basename "${CLAUDE_PROJECT_DIR}")"
```

After the command finishes, tell the user:
- The full path of the generated HTML file: `${CLAUDE_PROJECT_DIR}/devguard-sphere-map.html`
- That they can open it in a browser.
- That it is a reproducible artifact and can be added to `.gitignore` if desired.

If the command reports "0 nodes" / an empty map, explain that this project has no sphere
data (features/notes) yet — DevGuard needs to run in the project first.

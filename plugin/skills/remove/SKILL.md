---
name: remove
description: Take FindWright back out of this computer: the search hook, its registration with Claude Code and its helper, then the plugin. Each part on a yes.
---

# /findwright:remove

Takes FindWright out in the reverse order setup put it in, so no hook keeps sending searches to tools that are gone. Each step asks first. `<helper>` is `$HOME/.findwright/helper/node_modules/findwright`.

1. **The hook:** when `node "<helper>/src/cli.mjs" home status` shows `hook` true, ask, then run `node "<helper>/src/cli.mjs" home remove-hook`. It backs up the settings file first.
2. **The registration:** when `claude mcp get findwright` names `<helper>/src/server.mjs`, ask, then run `claude mcp remove findwright --scope user`. A registration that points at another copy, such as Bindwright's, belongs to that tool: leave it and say so.
3. **The helper:** ask, then delete the folder `$HOME/.findwright/helper`.
4. **Project indexes:** each indexed repo holds a `.findwright/` folder (the index, and `config.json` when the project has one). Say they stay, since `config.json` may be the project's own and the index rebuilds in seconds, and that deleting `.findwright/index.db*` in a repo frees its space.
5. **The plugin:** say to run `/plugin uninstall findwright` to finish.

End with one line per part: removed, or kept and why.

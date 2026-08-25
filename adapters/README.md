# REPL adapter

The default interaction surface is the local CLI REPL (`./helix.sh`). Additional
channel adapters (chat apps, web UIs) can plug in by appending user messages
through the same `runTurn` API and writing outbound replies from tool results or
post-turn hooks.

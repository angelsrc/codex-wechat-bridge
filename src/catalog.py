"""Read only Codex thread metadata; no histories, config changes or SQLite writes."""
import json, pathlib, sqlite3, sys
root = pathlib.Path(sys.argv[1])
found = {}
for path in (root / 'state_5.sqlite', root / 'sqlite' / 'state_5.sqlite'):
    if not path.exists():
        continue
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2) as db:
        db.execute('PRAGMA query_only=ON')
        for thread_id, updated in db.execute('SELECT id,updated_at FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 200'):
            key = ('local', thread_id)
            found[key] = max(updated, found.get(key, 0))
print(json.dumps([{'hostId': host, 'id': thread_id} for (host, thread_id), _ in sorted(found.items(), key=lambda pair: pair[1], reverse=True)[:200]]))

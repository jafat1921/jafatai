"""A small in-memory sliding window. The API runs as one process, so a dict is enough for now."""
import time
from collections import deque
from threading import Lock


class SlidingWindow:
    def __init__(self, limit: int, window_s: float):
        self.limit = limit
        self.window_s = window_s
        self._hits: dict[str, deque[float]] = {}
        self._lock = Lock()

    def _trim(self, key: str, now: float) -> deque[float]:
        q = self._hits.setdefault(key, deque())
        while q and now - q[0] >= self.window_s:
            q.popleft()
        return q

    def retry_after(self, key: str) -> int:
        """Seconds until `key` may try again; 0 when it isn't blocked."""
        now = time.monotonic()
        with self._lock:
            q = self._trim(key, now)
            if len(q) < self.limit:
                if not q:
                    self._hits.pop(key, None)
                return 0
            return max(1, int(self.window_s - (now - q[0])) + 1)

    def hit(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            self._trim(key, now).append(now)
            # forget idle keys now and then so a scan of many IPs can't grow this forever
            if len(self._hits) > 10_000:
                for k in [k for k, q in self._hits.items() if not q or now - q[-1] >= self.window_s]:
                    del self._hits[k]

    def clear(self, key: str | None = None) -> None:
        with self._lock:
            if key is None:
                self._hits.clear()
            else:
                self._hits.pop(key, None)

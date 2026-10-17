"""Origin check for cookie-authenticated writes (contract v38): the CSRF guard SameSite=Lax alone doesn't give.

A browser always sends Origin on a cross-site POST, so a write whose Origin (or, failing that, Referer) names
another site is refused. No Origin and no Referer means a script or curl, which can't carry the victim's
cookie anyway. Bearer tokens are never sent by a browser on its own, so token calls skip the check."""
from urllib.parse import urlsplit

from starlette.responses import JSONResponse

SAFE = {"GET", "HEAD", "OPTIONS"}


def _origin_of(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}".lower() if parts.scheme and parts.netloc else ""


class OriginCheck:
    def __init__(self, app, allowed: list[str]):
        self.app = app
        self.allowed = {_origin_of(o) for o in allowed if _origin_of(o)}

    def _ok(self, headers: dict[bytes, bytes]) -> bool:
        raw = headers.get(b"origin") or headers.get(b"referer")
        if raw is None:
            return True
        origin = _origin_of(raw.decode("latin-1"))
        if not origin:
            # "Origin: null" (sandboxed frame, file://) is never one of ours
            return False
        if origin in self.allowed:
            return True
        # same host as the request: the app served behind Caddy talking to itself
        host = headers.get(b"host", b"").decode("latin-1").lower()
        return bool(host) and urlsplit(origin).netloc == host

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] in SAFE:
            await self.app(scope, receive, send)
            return
        headers = dict(scope["headers"])
        if headers.get(b"authorization", b"").lower().startswith(b"bearer ") or self._ok(headers):
            await self.app(scope, receive, send)
            return
        await JSONResponse({"detail": "This request came from another site, so it was refused"},
                           403)(scope, receive, send)

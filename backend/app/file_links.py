"""Short-lived signed download links (MCP, Update 3): GET /api/files/{signed} serves one generation's file
without auth for ten minutes, so an agent can fetch a result without sending its token again.

The link names a generation and the workspace it belongs to; the route checks both again before serving.
"""
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from app.config import get_settings
from app.models import Generation

# its own salt, so a session cookie can never pass as a file link (or the other way round)
SALT = "mixai-file-link"
TTL_S = 600


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().app_secret, salt=SALT)


def sign(g: Generation) -> str:
    return _serializer().dumps({"g": g.id, "w": g.workspace_id})


def read(signed: str) -> tuple[str, str] | None:
    """(generation id, workspace id), or None when the link is forged, mangled or older than TTL_S."""
    try:
        data = _serializer().loads(signed, max_age=TTL_S)
    except (BadSignature, SignatureExpired):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("g"), str) or not isinstance(data.get("w"), str):
        return None
    return data["g"], data["w"]


def url_for(g: Generation, origin: str) -> str:
    return f"{origin.rstrip('/')}/api/files/{sign(g)}"

from app.drivers.base import GenerationDriver, ProgressCallback


def get_driver(name: str, lane: str | None = None) -> GenerationDriver:
    if name == "mock":
        from app.drivers.mock import MockDriver

        return MockDriver()
    if name == "comfy":
        from app.drivers.comfy import ComfyDriver

        return ComfyDriver(lane=lane)
    raise ValueError(f"Unknown GEN_DRIVER '{name}' (expected mock or comfy)")


__all__ = ["GenerationDriver", "ProgressCallback", "get_driver"]

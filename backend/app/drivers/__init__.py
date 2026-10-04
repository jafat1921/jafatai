from app.drivers.base import GenerationDriver, ProgressCallback


def get_driver(name: str) -> GenerationDriver:
    if name == "mock":
        from app.drivers.mock import MockDriver

        return MockDriver()
    if name == "comfy":
        from app.drivers.comfy import ComfyDriver

        return ComfyDriver()
    raise ValueError(f"Unknown GEN_DRIVER '{name}' (expected mock or comfy)")


__all__ = ["GenerationDriver", "ProgressCallback", "get_driver"]

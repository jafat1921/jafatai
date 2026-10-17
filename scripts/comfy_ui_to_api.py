#!/usr/bin/env python3
"""Turn a ComfyUI editor workflow (UI format: nodes + links) into the API-format graph our templates use.

    python scripts/comfy_ui_to_api.py UI.json -o app/workflows/NAME/workflow.json
        [--object-info object_info.json] [--output 322] [--inline-switches] [--title 122="Load Image" ...]
    python scripts/comfy_ui_to_api.py --manifest backend/app/workflows/NAME/manifest.json [--object-info ...]

With --manifest the recipe comes from the manifest's "source" block (ui, output, titles, inline_switches) and
workflow.json is written beside it, so a template can be regenerated from its UI export in one command.

What it does, in order:
  * preview, note and reroute nodes go; anything wired through them (newer frontends give PreviewImage a
    pass-through output) is wired to whatever fed them. Bypassed nodes (mode 4) pass through the same way,
    muted ones (mode 2) are dropped.
  * Primitive* nodes are inlined: their value lands in each input they fed.
  * ComfySwitchNode stays a node by default (the manifest can resolve it at build time); --inline-switches
    picks on_true / on_false by its value instead.
  * widgets come from widgets_values_named, else from widgets_values in /object_info's input order.
  * only nodes upstream of the output node(s) are kept.

Standard library only, so it runs anywhere the repo is checked out.
"""
import argparse
import json
import sys
from pathlib import Path

DROP = {"Note", "MarkdownNote", "PrimitiveNode"}
PASS_THROUGH = {"Reroute", "PreviewImage", "MaskPreview", "PreviewAny", "Preview3D", "Preview3DAdvanced",
                "PreviewAudio", "SaveImageWebsocket"}
PRIMITIVES = {"PrimitiveInt", "PrimitiveFloat", "PrimitiveBoolean", "PrimitiveString", "PrimitiveStringMultiline"}
SWITCH = "ComfySwitchNode"
# frontend-only widgets that never reach the API prompt
UI_WIDGETS = {"control_after_generate", "control_before_generate", "upload", "fixed"}
SEED_CONTROLS = {"fixed", "increment", "decrement", "randomize"}
WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}


class ConvertError(ValueError):
    pass


def _links(ui: dict) -> dict[int, tuple[int, int, int, int]]:
    out = {}
    for row in ui.get("links") or []:
        if isinstance(row, dict):
            out[row["id"]] = (row["origin_id"], row["origin_slot"], row["target_id"], row["target_slot"])
        else:
            out[row[0]] = (row[1], row[2], row[3], row[4])
    return out


def _is_widget_spec(spec) -> bool:
    if not isinstance(spec, list) or not spec:
        return False
    head = spec[0]
    return isinstance(head, list) or head in WIDGET_TYPES or str(head).startswith("COMFY_DYNAMICCOMBO")


def _widgets(node: dict, info: dict | None) -> dict:
    named = node.get("widgets_values_named")
    if isinstance(named, dict):
        return {k: v for k, v in named.items() if k not in UI_WIDGETS}
    values = node.get("widgets_values")
    if isinstance(values, dict):  # VHS nodes store a dict already
        return {k: v for k, v in values.items() if k not in UI_WIDGETS}
    if not values:
        return {}
    if info is None:
        raise ConvertError(f"node {node['id']} ({node['type']}) has unnamed widgets; pass --object-info")
    inputs = info.get("input", {})
    order = info.get("input_order") or {s: list((inputs.get(s) or {}).keys()) for s in ("required", "optional")}
    names = []
    for section in ("required", "optional"):
        for key in order.get(section, []):
            spec = (inputs.get(section) or {}).get(key)
            if _is_widget_spec(spec):
                names.append((key, spec))
    out, vals = {}, list(values)
    for key, spec in names:
        if not vals:
            break
        out[key] = vals.pop(0)
        # seeds carry a "control after generate" value right behind them
        if spec[0] == "INT" and vals and vals[0] in SEED_CONTROLS:
            vals.pop(0)
    return out


def _coerce(value, spec):
    # older frontends save some INT widgets as strings ("1536")
    if isinstance(spec, list) and spec and isinstance(value, str):
        try:
            if spec[0] == "INT":
                return int(value)
            if spec[0] == "FLOAT":
                return float(value)
        except ValueError:
            pass
    return value


def _spec(info: dict | None, key: str):
    if not info:
        return None
    inputs = info.get("input", {})
    return (inputs.get("required") or {}).get(key) or (inputs.get("optional") or {}).get(key)


def convert(ui: dict, object_info: dict | None = None, outputs: list[int] | None = None,
            inline_switches: bool = False, titles: dict[int, str] | None = None) -> dict:
    nodes = {n["id"]: n for n in ui.get("nodes") or []}
    links = _links(ui)
    titles = titles or {}
    object_info = object_info or {}

    def value_of(node: dict):
        return _first_widget(node, "value")

    def resolve(link_id, depth=0):
        """('link', node_id, slot), ('value', v) or None when nothing real feeds it."""
        if link_id is None or link_id not in links:
            return None
        if depth > 64:
            raise ConvertError("link loop")
        src_id, slot, _, _ = links[link_id]
        src = nodes.get(src_id)
        if src is None:
            return None
        kind, mode = src["type"], src.get("mode", 0)
        if mode == 2 or kind in DROP:
            return None
        if kind in PRIMITIVES:
            return ("value", value_of(src))
        ins = src.get("inputs") or []
        if kind in PASS_THROUGH or mode == 4:
            # pass-through keeps slot order; a bypassed node hands over its first input of the same type
            out_type = (src.get("outputs") or [{}])[slot].get("type") if slot < len(src.get("outputs") or []) else None
            same = [i for i in ins if i.get("link") is not None and (out_type is None or i.get("type") == out_type)]
            pick = ins[slot] if slot < len(ins) and ins[slot].get("link") is not None else (same[0] if same else None)
            return resolve(pick["link"], depth + 1) if pick else None
        if kind == SWITCH and inline_switches:
            sw = _switch_value(src, resolve, depth)
            branch = next((i for i in ins if i["name"] == ("on_true" if sw else "on_false")), None)
            return resolve(branch["link"], depth + 1) if branch else None
        return ("link", src_id, slot)

    graph: dict[str, dict] = {}
    for nid, node in nodes.items():
        kind = node["type"]
        if node.get("mode", 0) in (2, 4) or kind in DROP | PASS_THROUGH | PRIMITIVES:
            continue
        if kind == SWITCH and inline_switches:
            continue
        info = object_info.get(kind)
        inputs = {k: _coerce(v, _spec(info, k)) for k, v in _widgets(node, info).items()}
        for slot in node.get("inputs") or []:
            got = resolve(slot.get("link"))
            name = slot["name"]
            if got is None:
                continue  # unwired: the widget value (if any) stands
            if got[0] == "value":
                inputs[name] = _coerce(got[1], _spec(info, name))
            else:
                inputs[name] = [str(got[1]), got[2]]
        for key, spec in ((info or {}).get("input", {}).get("required") or {}).items():
            # a widget added to the node after the export was saved: the server's default, as the editor would
            if key not in inputs and _is_widget_spec(spec) and isinstance(spec[-1], dict) and "default" in spec[-1]:
                inputs[key] = spec[-1]["default"]
        graph[str(nid)] = {"class_type": kind, "_meta": {"title": titles.get(nid) or node.get("title") or kind},
                           "inputs": inputs}

    wanted = [str(o) for o in outputs] if outputs else [
        nid for nid, n in graph.items()
        if (object_info.get(n["class_type"]) or {}).get("output_node") or n["class_type"].startswith("Save")]
    missing = [o for o in wanted if o not in graph]
    if missing or not wanted:
        raise ConvertError(f"output node(s) not found: {missing or 'none'}")
    graph = prune(graph, wanted)
    _unique_titles(graph, titles)
    return graph


def _switch_value(node: dict, resolve, depth: int) -> bool:
    slot = next((i for i in node.get("inputs") or [] if i["name"] == "switch"), None)
    got = resolve(slot["link"], depth + 1) if slot and slot.get("link") is not None else None
    if got and got[0] == "value":
        return bool(got[1])
    if got:
        raise ConvertError(f"switch {node['id']} is driven by a node; can't inline it")
    return bool(_first_widget(node, "switch"))


def _first_widget(node: dict, name: str):
    # primitives and switches have one real widget, so an unnamed export is still unambiguous
    named = node.get("widgets_values_named")
    if isinstance(named, dict) and name in named:
        return named[name]
    values = node.get("widgets_values")
    if isinstance(values, list) and values:
        return values[0]
    raise ConvertError(f"node {node['id']} ({node['type']}) has no {name}")


def prune(graph: dict, outputs: list[str]) -> dict:
    keep: set[str] = set()
    stack = list(outputs)
    while stack:
        nid = stack.pop()
        if nid in keep or nid not in graph:
            continue
        keep.add(nid)
        for v in graph[nid]["inputs"].values():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                stack.append(v[0])
    return {nid: graph[nid] for nid in sorted(graph, key=int) if nid in keep}


def _unique_titles(graph: dict, given: dict[int, str]) -> None:
    # manifests address nodes by title, so two "KSampler"s become "KSampler 3" / "KSampler 12"
    seen: dict[str, list[str]] = {}
    for nid, n in graph.items():
        seen.setdefault(n["_meta"]["title"], []).append(nid)
    for title, ids in seen.items():
        if len(ids) < 2:
            continue
        clash = [i for i in ids if given.get(int(i)) == title]
        if clash:
            raise ConvertError(f"title {title!r} given to more than one node")
        for nid in ids:
            graph[nid]["_meta"]["title"] = f"{title} {nid}"


def _parse_titles(items: list[str]) -> dict[int, str]:
    out = {}
    for item in items or []:
        key, _, title = item.partition("=")
        if not title:
            raise SystemExit(f"--title wants ID=Title, got {item!r}")
        out[int(key)] = title.strip().strip('"')
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("ui", type=Path, nargs="?")
    ap.add_argument("--manifest", type=Path, help="read the recipe from this manifest's source block")
    ap.add_argument("-o", "--out", type=Path)
    ap.add_argument("--object-info", type=Path, action="append", default=[],
                    help="/object_info dump(s); later files win. Needed when a node has no widgets_values_named")
    ap.add_argument("--output", type=int, action="append", help="output node id (repeatable)")
    ap.add_argument("--inline-switches", action="store_true")
    ap.add_argument("--title", action="append", default=[], help='ID="Title" for nodes a manifest addresses')
    args = ap.parse_args(argv)

    info: dict = {}
    for f in args.object_info:
        info.update(json.loads(f.read_text(encoding="utf-8")))
    titles, outputs, inline = _parse_titles(args.title), args.output, args.inline_switches
    ui_path = args.ui
    if args.manifest:
        src = json.loads(args.manifest.read_text(encoding="utf-8")).get("source") or {}
        # source paths are relative to backend/, where the tests run
        ui_path = ui_path or args.manifest.parents[3] / src["ui"]
        titles = {**{int(k): v for k, v in (src.get("titles") or {}).items()}, **titles}
        outputs = outputs or src.get("output")
        inline = inline or bool(src.get("inline_switches"))
        args.out = args.out or args.manifest.with_name("workflow.json")
    if ui_path is None:
        ap.error("give a UI workflow or --manifest")
    ui = json.loads(ui_path.read_text(encoding="utf-8"))
    try:
        graph = convert(ui, info, outputs, inline, titles)
    except ConvertError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    text = json.dumps(graph, indent=2, ensure_ascii=False) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
        print(f"{len(graph)} nodes -> {args.out}", file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())

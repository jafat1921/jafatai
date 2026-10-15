"""Mark rows made through the token API before via_api existed (contract v34), so the studio app stops listing them.

    cd backend && uv run python ../scripts/mark-api-items.py --ids <id>[,<id>...] [--apply]
    cd backend && uv run python ../scripts/mark-api-items.py --since 2026-10-14T09:00 --until 2026-10-14T18:00 \\
        [--kinds media,job,generation] [--workspace <id>] [--apply]

Ids can be of any kind (a Library item, job, project, voice, poetry short...) and bring along what hangs off
them: an item's versions and their jobs, a project's films, cast and results, a job's children. --since /
--until are UTC and take every row of --kinds created in that window (all kinds when left out).

Dry run unless --apply: it prints what it would mark. Reads DATABASE_URL from .env like the app.
"""
import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app import visibility as vis  # noqa: E402
from app.db import SessionLocal  # noqa: E402


def utc(value: str) -> datetime:
    try:
        at = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        raise argparse.ArgumentTypeError(f"not an ISO date/time: {value}") from None
    return at.astimezone(timezone.utc).replace(tzinfo=None) if at.tzinfo else at


def csv(value: str) -> list[str]:
    return [x.strip() for x in value.split(",") if x.strip()]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="mark-api-items.py", description="Hide earlier API-made rows from the studio app")
    ap.add_argument("--ids", type=csv, default=[], help="comma list of row ids")
    ap.add_argument("--since", type=utc, help="UTC, inclusive (e.g. 2026-10-14T09:00)")
    ap.add_argument("--until", type=utc, help="UTC, exclusive")
    ap.add_argument("--kinds", type=csv, help=f"comma list of {', '.join(vis.KINDS)}")
    ap.add_argument("--workspace", help="only this workspace id")
    ap.add_argument("--no-follow", action="store_true", help="mark only the rows named, not what hangs off them")
    ap.add_argument("--apply", action="store_true", help="write the marks (default: dry run)")
    args = ap.parse_args(argv)
    if not args.ids and args.since is None and args.until is None:
        ap.error("give --ids and/or --since/--until")

    with SessionLocal() as db:
        try:
            res = vis.mark(db, workspace_id=args.workspace, ids=args.ids, since=args.since, until=args.until,
                           kinds=args.kinds, apply=args.apply, follow=not args.no_follow)
        except vis.MarkError as e:
            ap.error(str(e))

    verb = "Marked" if args.apply else "Would mark"
    total = sum(res["counts"].values())
    print(f"{verb} {total} row(s) as made through the API")
    for kind, n in sorted(res["counts"].items()):
        already = res["already"].get(kind, 0)
        print(f"  {kind:<16} {n:>6}" + (f"   ({already} already marked)" if already else ""))
        for i in res["sample"].get(kind, []):
            print(f"      {i}")
        if n > len(res["sample"].get(kind, [])):
            print(f"      ... and {n - len(res['sample'][kind])} more")
    if res.get("unknown_ids"):
        print("Not found: " + ", ".join(res["unknown_ids"]))
    if not args.apply and total:
        print("Dry run: nothing written. Run again with --apply to mark them.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

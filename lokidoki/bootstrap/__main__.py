"""``python -m lokidoki.bootstrap`` — stdlib entry point for Layer 1."""
from __future__ import annotations

import argparse
import logging
import os
import platform
import sys
import webbrowser
from pathlib import Path

from .context import StepContext
from .pipeline import Pipeline
from .server import make_server, start_pipeline_loop
from .steps import build_steps


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python -m lokidoki.bootstrap")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7861)
    parser.add_argument(
        "--profile",
        default=None,
        help="Override auto-detected profile (mac/windows/linux/pi_cpu/pi_hailo).",
    )
    parser.add_argument("--data-dir", default=".lokidoki", type=Path)
    parser.add_argument("--no-open", action="store_true")
    parser.add_argument("--log-file", default=None, type=Path)
    return parser.parse_args(argv)


def _resolve_profile(override: str | None) -> str:
    if override:
        return override
    try:
        from lokidoki.core.platform import detect_profile  # type: ignore
    except Exception:  # noqa: BLE001 — fall back to a pure-stdlib guess
        system = platform.system()
        if system == "Darwin":
            return "mac"
        if system == "Windows":
            return "windows"
        return "linux"
    return detect_profile()


def _configure_logging(log_file: Path | None) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]
    if log_file is not None:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(log_file, encoding="utf-8"))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        handlers=handlers,
    )


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(list(sys.argv[1:] if argv is None else argv))
    _configure_logging(args.log_file)

    profile = _resolve_profile(args.profile)
    data_dir = args.data_dir.resolve()
    data_dir.mkdir(parents=True, exist_ok=True)

    pipeline = Pipeline()
    ctx = StepContext(
        data_dir=data_dir,
        profile=profile,
        arch=platform.machine(),
        os_name=platform.system(),
        emit=pipeline.emit,
    )

    steps = build_steps(profile)
    loop, _thread = start_pipeline_loop(pipeline, steps, ctx)
    server = make_server(
        args.host,
        args.port,
        pipeline,
        ctx,
        loop,
        config_path=data_dir / "bootstrap_config.json",
    )

    url = f"http://{args.host}:{args.port}/bootstrap"
    logging.getLogger(__name__).info("bootstrap server listening on %s", url)
    if not args.no_open and not os.environ.get("LOKIDOKI_NO_BROWSER"):
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

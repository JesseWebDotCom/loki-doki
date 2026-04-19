"""``python -m lokidoki.bootstrap`` — stdlib entry point for Layer 1."""
from __future__ import annotations

import argparse
import logging
import os
import platform
import sys
import threading
import time
import webbrowser
from pathlib import Path

from .context import StepContext
from .offline import apply_bundle, discover_bundle, reset_data_dir
from .pipeline import Pipeline
from .run_app import app_host_for, app_port_for
from .server import make_server, start_pipeline_loop
from .steps import build_maps_tools_only_steps, build_steps


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python -m lokidoki.bootstrap")
    parser.add_argument(
        "--host",
        default=None,
        help="Override the wizard bind host (default: profile-derived).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="Override the wizard bind port (default: profile-derived).",
    )
    parser.add_argument(
        "--profile",
        default=None,
        help="Override auto-detected profile (mac/windows/linux/pi_cpu/pi_hailo).",
    )
    parser.add_argument("--data-dir", default=".lokidoki", type=Path)
    parser.add_argument(
        "--no-open",
        "--no-browser",
        dest="no_open",
        action="store_true",
        help="Don't auto-open the wizard URL in a browser.",
    )
    parser.add_argument("--log-file", default=None, type=Path)
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Delete .lokidoki/ before starting so the wizard installs fresh.",
    )
    parser.add_argument(
        "--skip-optional",
        action="store_true",
        help="Auto-skip every step flagged can_skip=True (low-bandwidth installs).",
    )
    parser.add_argument(
        "--offline-bundle",
        default=None,
        type=Path,
        help=(
            "Path to an offline bundle dir (built by scripts/build_offline_bundle.py). "
            "Seeds .lokidoki/cache + huggingface before the pipeline runs so the "
            "wizard can install with no network access. When omitted the wizard "
            "also auto-picks up a sibling 'lokidoki-offline-bundle/' directory."
        ),
    )
    parser.add_argument(
        "--maps-tools-only",
        action="store_true",
        help=(
            "Run ONLY the maps-tools preflights (tippecanoe + Valhalla CLIs). "
            "Skips the rest of the wizard; intended for CI and for developers "
            "validating the maps toolchain. Auto-shuts down the stdlib server "
            "once both preflights complete."
        ),
    )
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
    if args.reset:
        logging.getLogger(__name__).warning(
            "--reset: wiping %s for a clean install", data_dir
        )
        reset_data_dir(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)

    bundle = discover_bundle(args.offline_bundle)
    if bundle is not None:
        logging.getLogger(__name__).info("seeding from offline bundle: %s", bundle)
        apply_bundle(bundle, data_dir)

    # Wizard binds on the same (host, port) the FastAPI app will take
    # over after spawn-app. ``pi_hailo`` moves both to :7860 because
    # hailo-ollama owns :8000 — every other profile keeps the default.
    host = args.host if args.host is not None else app_host_for(profile)
    port = args.port if args.port is not None else app_port_for(profile)

    pipeline = Pipeline(app_url=f"http://{host}:{port}")
    ctx = StepContext(
        data_dir=data_dir,
        profile=profile,
        arch=platform.machine(),
        os_name=platform.system(),
        emit=pipeline.emit,
    )

    steps = (
        build_maps_tools_only_steps(profile)
        if args.maps_tools_only
        else build_steps(profile)
    )
    if args.skip_optional:
        for step in steps:
            if step.can_skip:
                pipeline.skip_requested.add(step.id)
    loop, pipeline_thread = start_pipeline_loop(pipeline, steps, ctx)
    server = make_server(
        host,
        port,
        pipeline,
        ctx,
        loop,
        config_path=data_dir / "bootstrap_config.json",
    )

    # Wire the stdlib → FastAPI handoff so ``spawn-app`` can release :8000
    # before uvicorn tries to bind the same port. ``server.shutdown`` exits
    # ``serve_forever`` on the main thread; ``server_close`` releases the
    # listening socket. Existing SSE handler threads keep writing until
    # their sockets close.
    def _release_listener() -> None:
        server.shutdown()
        try:
            server.server_close()
        except OSError:
            pass

    ctx.handoff = _release_listener

    # ``--maps-tools-only`` skips ``spawn-app`` entirely, so the usual
    # handoff that releases ``server.serve_forever()`` never fires. Watch
    # ``pipeline.done`` in a daemon thread and shut the server down the
    # instant the two maps-tools preflights finish.
    if args.maps_tools_only:

        def _autoshutdown_after_pipeline() -> None:
            while not pipeline.done:
                time.sleep(0.2)
            _release_listener()

        threading.Thread(
            target=_autoshutdown_after_pipeline,
            name="bootstrap-maps-tools-shutdown",
            daemon=True,
        ).start()

    # 0.0.0.0 is a valid listen address but not a valid URL to hand the
    # user's browser — rewrite to loopback for the auto-open link so
    # headless Pi installs still land on a working URL.
    browser_host = "127.0.0.1" if host == "0.0.0.0" else host
    url = f"http://{browser_host}:{port}/bootstrap"
    logging.getLogger(__name__).info("bootstrap server listening on %s", url)
    if (
        not args.no_open
        and not args.maps_tools_only
        and not os.environ.get("LOKIDOKI_NO_BROWSER")
    ):
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        # Wait for the pipeline to finish (handoff already called shutdown).
        deadline = time.time() + 60.0
        while not pipeline.done and time.time() < deadline:
            time.sleep(0.1)
        loop.call_soon_threadsafe(loop.stop)
        pipeline_thread.join(timeout=5)
        try:
            server.server_close()
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

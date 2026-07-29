"""`gemdex-web` entrypoint: resolve config, report posture, run uvicorn."""

from __future__ import annotations

import sys

import uvicorn

from .app import create_app
from .config import Config, ConfigError, load_config


def main() -> int:
    """Fails fast (non-zero) on bad configuration rather than booting broken."""
    try:
        config = load_config()
    except ConfigError as error:
        print(f"gemdex-web: {error}", file=sys.stderr)
        return 1

    _report(config)
    uvicorn.run(create_app(config), host=config.host, port=config.port, log_level="info")
    return 0


def _report(config: Config) -> None:
    """Announce the security posture at startup, where an operator will see it."""
    if config.auth_mode == "dev":
        print(
            "gemdex-web: WARNING — login is DISABLED (GEMDEX_WEB_AUTH=dev). "
            f"Anyone who can reach {config.host}:{config.port} has full memory access, "
            "including delete. Loopback development only.",
            file=sys.stderr,
        )
    else:
        print(
            f"gemdex-web: auth=google, single user {config.allowed_email}, {config.public_base_url}",
            file=sys.stderr,
        )
        print(f"gemdex-web: register this redirect URI with Google: {config.redirect_uri}", file=sys.stderr)

    ui = str(config.static_dir) if config.static_dir else "not built (API only)"
    print(f"gemdex-web: BYOI {config.byoi_url}/v1 → http://{config.host}:{config.port}  UI: {ui}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())

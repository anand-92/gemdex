"""Static-asset serving and the SPA fallback.

These tests need a *real* built frontend on disk, so they build a minimal fake
one in a tmpdir rather than depending on `pnpm build` having been run — the
pytest suite must pass on a clean checkout.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from gemdex_web.app import create_app
from gemdex_web.config import ConfigError, load_config

from .conftest import BYOI_TOKEN, NO_DOTENV, FakeByoi


@pytest.fixture
def built_ui(tmp_path: Path) -> Path:
    """A directory shaped like a Vite build output."""
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text('<!doctype html><div id="root"></div>', encoding="utf-8")
    (tmp_path / "assets" / "index-abc123.js").write_text("console.log(1)", encoding="utf-8")
    (tmp_path / "favicon.ico").write_bytes(b"\x00")
    # A file that must never be reachable, to prove the traversal guard works
    # against something real rather than a path that happens not to exist.
    (tmp_path.parent / "secret.txt").write_text("SUPER-SECRET", encoding="utf-8")
    return tmp_path


@pytest.fixture
def client(built_ui: Path, fake_byoi: FakeByoi) -> TestClient:
    config = load_config(
        env={"GEMDEX_SERVER_TOKEN": BYOI_TOKEN, "GEMDEX_WEB_STATIC_DIR": str(built_ui)},
        dotenv_path=NO_DOTENV,
    )
    with TestClient(create_app(config, byoi=fake_byoi)) as test_client:
        yield test_client


def test_root_serves_the_spa(client: TestClient) -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert 'id="root"' in response.text


def test_index_is_revalidated(client: TestClient) -> None:
    """Hashed assets can be cached forever; the entry point cannot, or a deploy
    would not be picked up without a hard refresh."""
    assert client.get("/").headers["cache-control"] == "no-cache"


def test_hashed_assets_are_served(client: TestClient) -> None:
    assert client.get("/assets/index-abc123.js").status_code == 200


def test_real_files_win_over_the_fallback(client: TestClient) -> None:
    assert client.get("/favicon.ico").content == b"\x00"


def test_client_routes_fall_back_to_index(client: TestClient) -> None:
    """A deep link must survive a reload rather than 404."""
    response = client.get("/memory/some-id")
    assert response.status_code == 200
    assert 'id="root"' in response.text


def test_unknown_api_paths_stay_json_404s(client: TestClient) -> None:
    """Falling back to HTML here would make a typo'd endpoint look like success
    to a `fetch` until JSON parsing failed."""
    response = client.get("/api/not-a-route")
    assert response.status_code == 404
    assert "text/html" not in response.headers["content-type"]


def test_unknown_auth_paths_are_not_swallowed(client: TestClient) -> None:
    assert client.get("/auth/not-a-route").status_code == 404


@pytest.mark.parametrize(
    "path",
    [
        "/../secret.txt",
        "/%2e%2e/secret.txt",
        "/../../etc/passwd",
        "/..%2f..%2fetc%2fpasswd",
        "/assets/../../secret.txt",
    ],
)
def test_path_traversal_cannot_escape_the_static_root(client: TestClient, path: str) -> None:
    """Serving arbitrary host files would leak `.env` and the BYOI token itself.

    The fallback returning `index.html` is the correct outcome; what must never
    happen is the file's contents coming back.
    """
    response = client.get(path)
    assert "SUPER-SECRET" not in response.text
    assert "root:x:" not in response.text


def test_missing_static_dir_is_a_startup_error() -> None:
    """A mistyped volume path should fail loudly, not 404 on every page load."""
    with pytest.raises(ConfigError):
        load_config(
            env={"GEMDEX_SERVER_TOKEN": BYOI_TOKEN, "GEMDEX_WEB_STATIC_DIR": "/nonexistent/ui"},
            dotenv_path=NO_DOTENV,
        )


def test_api_only_mode_reports_the_missing_ui(fake_byoi: FakeByoi, tmp_path: Path) -> None:
    """With no build present the API still works and `/` explains why."""
    config = load_config(env={"GEMDEX_SERVER_TOKEN": BYOI_TOKEN}, dotenv_path=NO_DOTENV)
    # Neutralize the bundled build, if the developer has run `pnpm build`.
    config = type(config)(**{**config.__dict__, "static_dir": None})
    with TestClient(create_app(config, byoi=fake_byoi)) as client:
        response = client.get("/")
        assert response.status_code == 200
        assert response.json()["ui"] == "not built"
        assert client.get("/api/memories").status_code == 200

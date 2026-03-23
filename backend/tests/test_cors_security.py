import os
import importlib
import pytest
from fastapi.testclient import TestClient


def _make_app_with_origins(origins_env: str = None):
    """Create a fresh app instance with the given BACKEND_CORS_ORIGINS."""
    old = os.environ.get("BACKEND_CORS_ORIGINS")
    try:
        if origins_env is not None:
            os.environ["BACKEND_CORS_ORIGINS"] = origins_env
        elif "BACKEND_CORS_ORIGINS" in os.environ:
            del os.environ["BACKEND_CORS_ORIGINS"]

        # Re-import main to pick up the new env
        import main as main_mod
        importlib.reload(main_mod)
        return main_mod.app
    finally:
        # Restore original env
        if old is not None:
            os.environ["BACKEND_CORS_ORIGINS"] = old
        elif "BACKEND_CORS_ORIGINS" in os.environ:
            del os.environ["BACKEND_CORS_ORIGINS"]


def test_cors_rejects_evil_origin():
    """Verify that requests from unauthorized origins do not receive permissive CORS headers
    when BACKEND_CORS_ORIGINS is set (production mode)."""
    app = _make_app_with_origins("http://localhost:3000")
    client = TestClient(app)

    origin = "http://evil.com"
    headers = {"Origin": origin}

    response = client.get("/groups", headers=headers)

    # ACAO should NOT be http://evil.com and definitely not * if credentials are true
    acao = response.headers.get("access-control-allow-origin")
    acac = response.headers.get("access-control-allow-credentials")

    print(f"\nEvil Origin Test ({origin}):")
    print(f"ACAO: {acao}")
    print(f"ACAC: {acac}")

    # Starlette CORSMiddleware behavior: if origin is not allowed, it doesn't send ACAO/ACAC
    assert acao != origin, "Vulnerability: Arbitrary origin reflected in Access-Control-Allow-Origin"
    assert acao != "*", "Vulnerability: Wildcard origin allowed with credentials"


def test_cors_allows_valid_origin():
    """Verify that requests from whitelisted origins receive correct CORS headers."""
    app = _make_app_with_origins("http://localhost:3000")
    client = TestClient(app)

    origin = "http://localhost:3000"
    headers = {"Origin": origin}

    response = client.get("/groups", headers=headers)

    acao = response.headers.get("access-control-allow-origin")
    acac = response.headers.get("access-control-allow-credentials")

    print(f"\nValid Origin Test ({origin}):")
    print(f"ACAO: {acao}")
    print(f"ACAC: {acac}")

    assert acao == origin, "Valid origin was not allowed"
    assert acac == "true", "Credentials not allowed for valid origin"


if __name__ == "__main__":
    test_cors_rejects_evil_origin()
    test_cors_allows_valid_origin()
    print("\n[+] All CORS security tests passed.")

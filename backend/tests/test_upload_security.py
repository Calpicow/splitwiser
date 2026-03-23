
import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock
import os
import io

# Import app and dependencies
from main import app
from routers.ocr import RECEIPT_DIR
from dependencies import get_current_user
from utils.rate_limiter import ocr_rate_limiter

# Create client
client = TestClient(app)

# Mock auth user
mock_user = MagicMock()
mock_user.id = 1


@pytest.fixture(autouse=True)
def setup_overrides():
    """Override auth and rate limiter for all tests."""
    app.dependency_overrides[get_current_user] = lambda: mock_user

    async def mock_rate_limit():
        return True
    app.dependency_overrides[ocr_rate_limiter] = mock_rate_limit

    yield
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(ocr_rate_limiter, None)


@pytest.fixture
def mock_llm():
    """Mock the LLM parse_receipt function."""
    with patch("routers.ocr.parse_receipt") as mock:
        mock.return_value = {
            "items": [],
            "tax_cents": None,
            "tip_cents": None,
            "total_cents": None,
        }
        yield mock


def test_upload_malicious_extension_fixed(mock_llm, tmp_path):
    # Create a valid minimal JPEG using PIL
    from PIL import Image
    img = Image.new("RGB", (1, 1), color="red")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    valid_jpeg = buf.getvalue()

    # Test uploading a valid image but with malicious extension (exploit.html)
    files = {
        "file": ("exploit.html", valid_jpeg, "image/jpeg")
    }

    response = client.post("/ocr/scan-receipt", files=files)

    # Should succeed (200 OK) because content is valid image
    assert response.status_code == 200, f"Upload failed: {response.text}"
    data = response.json()

    receipt_path = data["receipt_image_path"]

    # Verify fix: Should NOT end with .html, should be .jpg (detected from content)
    assert not receipt_path.endswith(".html"), "Vulnerability! File saved as .html"
    assert receipt_path.endswith(".jpg"), "File should be saved as .jpg based on content"

    # Cleanup created file
    filename = receipt_path.split("/")[-1]
    full_path = os.path.join(RECEIPT_DIR, filename)
    if os.path.exists(full_path):
        os.remove(full_path)


def test_upload_non_image_content_rejected(mock_llm):
    # Test uploading non-image content (HTML script) disguised as image
    files = {
        "file": ("exploit.html", b"<html><script>alert(1)</script></html>", "image/jpeg")
    }

    response = client.post("/ocr/scan-receipt", files=files)

    # Verify fix: Should be rejected as invalid image (400 Bad Request)
    assert response.status_code == 400
    assert "Invalid image file" in response.json()["detail"]


def test_large_file_upload_rejected(mock_llm):
    # Create a large file (10MB + 1 byte)
    large_content = b"a" * (10 * 1024 * 1024 + 1)

    files = {
        "file": ("large.jpg", large_content, "image/jpeg")
    }

    response = client.post("/ocr/scan-receipt", files=files)

    # Verify fix: Should be rejected as too large (413 Payload Too Large)
    assert response.status_code == 413
    assert "File size exceeds maximum allowed size" in response.json()["detail"]

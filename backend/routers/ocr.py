"""OCR router: LLM-based receipt scanning endpoint."""

from typing import Annotated
import os
import uuid
import io
from PIL import Image
from fastapi import APIRouter, Depends, HTTPException, File, UploadFile

import models
from dependencies import get_current_user
from ocr.llm_service import parse_receipt
from utils.rate_limiter import ocr_rate_limiter
from utils.files import read_upload_file_securely


# Receipt directory path
DATA_DIR = os.getenv("DATA_DIR", "data")
RECEIPT_DIR = os.path.join(DATA_DIR, "receipts")

# Map PIL format names to file extensions and MIME types
FORMAT_MAP = {
    "JPEG": {"ext": "jpg", "mime": "image/jpeg"},
    "PNG":  {"ext": "png", "mime": "image/png"},
    "WEBP": {"ext": "webp", "mime": "image/webp"},
}

router = APIRouter(tags=["ocr"])


@router.post("/ocr/scan-receipt", dependencies=[Depends(ocr_rate_limiter)])
async def scan_receipt(
    file: UploadFile = File(...),
    current_user: Annotated[models.User, Depends(get_current_user)] = None,
):
    """
    Scan a receipt image using an LLM (GPT-4o) and return extracted items.

    Accepts an image upload (JPEG, PNG, or WebP, max 10 MB).
    Returns structured item data with prices in cents.
    """
    MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB

    # Read and validate file
    image_content = await read_upload_file_securely(file, MAX_FILE_SIZE)

    try:
        image = Image.open(io.BytesIO(image_content))
        img_format = image.format
        image.verify()
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid image file.")

    if img_format not in FORMAT_MAP:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported image format: {img_format}. Only JPEG, PNG, and WebP are supported.",
        )

    fmt = FORMAT_MAP[img_format]

    # Save receipt image
    os.makedirs(RECEIPT_DIR, exist_ok=True)
    filename = f"{uuid.uuid4()}.{fmt['ext']}"
    file_path = os.path.join(RECEIPT_DIR, filename)
    with open(file_path, "wb") as f:
        f.write(image_content)

    # Call LLM
    try:
        result = parse_receipt(image_content, mime_type=fmt["mime"])
    except RuntimeError as exc:
        # Missing API key or config error
        raise HTTPException(status_code=500, detail=str(exc))
    except Exception as exc:
        print(f"LLM receipt parsing error: {exc}")
        raise HTTPException(
            status_code=502,
            detail="Receipt scanning service is temporarily unavailable. Please try again.",
        )

    # Build response
    items = [
        {
            "description": item["description"],
            "price": item["price_cents"],
            "quantity": item.get("quantity", 1),
        }
        for item in result.get("items", [])
    ]

    return {
        "items": items,
        "tax": result.get("tax_cents"),
        "tip": result.get("tip_cents"),
        "total": result.get("total_cents"),
        "receipt_image_path": f"/static/receipts/{filename}",
    }

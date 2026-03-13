"""Google Gemini receipt parsing provider."""

import json
import os

from google import genai
from google.genai import types

from ocr.llm_service import SYSTEM_PROMPT

# Gemini doesn't support ["integer", "null"] union types.
# Use nullable=True with a single type instead.
_GEMINI_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "description": {"type": "string"},
                    "price_cents": {"type": "integer"},
                    "quantity": {"type": "integer"},
                },
                "required": ["description", "price_cents", "quantity"],
            },
        },
        "tax_cents": {"type": "integer", "nullable": True},
        "tip_cents": {"type": "integer", "nullable": True},
        "total_cents": {"type": "integer", "nullable": True},
    },
    "required": ["items", "tax_cents", "tip_cents", "total_cents"],
}


def _get_client() -> genai.Client:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY environment variable is not set")
    return genai.Client(api_key=api_key)


def parse_receipt(image_bytes: bytes, mime_type: str = "image/jpeg") -> dict:
    """Parse a receipt image using Google Gemini vision."""
    client = _get_client()

    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
            "Extract all items from this receipt.",
        ],
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            temperature=0,
            response_mime_type="application/json",
            response_schema=_GEMINI_SCHEMA,
        ),
    )

    return json.loads(response.text)

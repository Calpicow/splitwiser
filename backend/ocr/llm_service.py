"""LLM-based receipt parsing — provider-agnostic entry point.

Set LLM_PROVIDER env var to choose the backend:
  - "openai"  (default) — requires OPENAI_API_KEY
  - "gemini"            — requires GEMINI_API_KEY
"""

import os

# ── Shared prompt and schema used by all providers ──────────────────────

SYSTEM_PROMPT = """You are a receipt parser. Given an image of a receipt, extract all purchased items.

Rules:
- Extract ONLY individual purchased items (food, drinks, goods, services).
- Do NOT include subtotal, total, tax, tip/gratuity, discounts, payment method, change, or balance lines as items.
- For each item, provide: description (item name as printed), price_cents (total line price in cents as an integer), and quantity (integer, default 1).
- If an item shows a quantity multiplier (e.g., "2x Burger $25.98" or "Burger 2 $25.98"), set quantity to that number and price_cents to the TOTAL line price (not per-unit).
- DISCOUNTS: Carefully look for discount lines BELOW each item (e.g., "Member Discount (15%) -$4.20", "Promo -$2.00"). These discounts MUST be subtracted from the item directly above them. Report the AFTER-DISCOUNT price for each item. Do NOT include discount lines as separate items. A discount line always applies to the nearest item above it.
- price_cents must always be a positive integer representing the final price for that line in cents. For example, if an item is $28.00 with a -$4.20 discount, report 2380.
- Extract tax, tip, and total amounts separately if visible on the receipt. Use the post-discount subtotal/total values.
- If the currency is not USD, still use cents (smallest unit). The user will handle currency separately.
- If you cannot read an item clearly, make your best guess and include it.
- Do NOT invent items that are not on the receipt.
- CRITICAL VALIDATION: The sum of all your item price_cents values MUST equal the receipt's Subtotal (after discounts, before tax/tip). If it does not match, you have missed a discount — go back and fix it."""

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "description": {
                        "type": "string",
                        "description": "Item name as printed on receipt",
                    },
                    "price_cents": {
                        "type": "integer",
                        "description": "Total line price in cents (e.g., $12.99 = 1299)",
                    },
                    "quantity": {
                        "type": "integer",
                        "description": "Quantity purchased, default 1",
                    },
                },
                "required": ["description", "price_cents", "quantity"],
                "additionalProperties": False,
            },
        },
        "tax_cents": {
            "type": ["integer", "null"],
            "description": "Tax amount in cents, or null if not visible",
        },
        "tip_cents": {
            "type": ["integer", "null"],
            "description": "Tip/gratuity in cents, or null if not visible",
        },
        "total_cents": {
            "type": ["integer", "null"],
            "description": "Total amount in cents, or null if not visible",
        },
    },
    "required": ["items", "tax_cents", "tip_cents", "total_cents"],
    "additionalProperties": False,
}


# ── Provider dispatch ───────────────────────────────────────────────────

def parse_receipt(image_bytes: bytes, mime_type: str = "image/jpeg") -> dict:
    """
    Parse a receipt image using the configured LLM provider.

    Returns dict with: items (list), tax_cents, tip_cents, total_cents.
    Each item has: description (str), price_cents (int), quantity (int).
    """
    provider = os.getenv("LLM_PROVIDER", "openai").lower()

    if provider == "openai":
        from ocr.providers.openai_provider import parse_receipt as _parse
    elif provider == "gemini":
        from ocr.providers.gemini_provider import parse_receipt as _parse
    else:
        raise RuntimeError(f"Unknown LLM_PROVIDER: {provider!r}. Use 'openai' or 'gemini'.")

    result = _parse(image_bytes, mime_type)

    # Validate / sanitize items regardless of provider
    for item in result.get("items", []):
        if not isinstance(item.get("price_cents"), int) or item["price_cents"] < 0:
            item["price_cents"] = 0
        if not isinstance(item.get("quantity"), int) or item["quantity"] < 1:
            item["quantity"] = 1
        if not item.get("description") or not isinstance(item["description"], str):
            item["description"] = "Unknown item"

    return result

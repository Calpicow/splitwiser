# LLM-Based Receipt Scanning

## Status: Implemented

All steps complete. Branch: `julo/llm-receipt-scanning`

## Overview

Replaced the multi-phase OCR system (Google Cloud Vision + bounding box editing) with a single-pass LLM vision approach. The user uploads a receipt image, the backend sends it to a configurable LLM provider, and gets back structured item data. The user reviews items in a simple list, then confirms.

## Architecture

### Flow

```
User uploads image
    → Frontend sends image to POST /ocr/scan-receipt
    → Backend delegates to configured LLM provider (OpenAI or Gemini)
    → LLM returns JSON: { items, tax_cents, tip_cents, total_cents }
    → Backend validates response, saves receipt image, returns items
    → Frontend shows editable item list with tax/tip/total summary
    → User reviews/edits, confirms → items + tax + tip + total flow into expense form
    → Expense form shows validation warning if items+tax+tip ≠ receipt total
```

### Multi-Provider Support

Switchable via `LLM_PROVIDER` env var:

| Provider | Env Var | Model |
|----------|---------|-------|
| `openai` (default) | `OPENAI_API_KEY` | GPT-4o with structured outputs |
| `gemini` | `GEMINI_API_KEY` | Gemini 2.0 Flash with JSON schema |

```
backend/ocr/
  llm_service.py              # Shared prompt, schema, dispatch, validation
  providers/
    openai_provider.py         # OpenAI GPT-4o implementation
    gemini_provider.py         # Google Gemini implementation
```

Adding a new provider: create `providers/new_provider.py` with a `parse_receipt(image_bytes, mime_type) -> dict` function, add an `elif` in `llm_service.py`.

### LLM Contract (Structured Output Schema)

```json
{
  "items": [
    { "description": "Margherita Pizza", "price_cents": 1499, "quantity": 1 }
  ],
  "tax_cents": 120,
  "tip_cents": 0,
  "total_cents": 1619
}
```

System prompt rules:
- Extract only purchased items (not subtotals, totals, payment lines)
- Apply discounts to the item above them (report after-discount prices)
- Prices in cents as integers
- Items should sum to the receipt's post-discount subtotal
- Tax, tip, total extracted separately for validation

### Backend

**Endpoint: `POST /ocr/scan-receipt`** (rate-limited, auth required)
- Input: multipart image upload (JPEG/PNG/WebP, max 10 MB)
- Validates image with PIL, saves to `data/receipts/`, calls LLM provider
- Returns: `{ items, tax, tip, total, receipt_image_path }`

**Files:**
- `backend/ocr/llm_service.py` — Shared prompt, schema, provider dispatch, response validation
- `backend/ocr/providers/openai_provider.py` — OpenAI GPT-4o with structured outputs
- `backend/ocr/providers/gemini_provider.py` — Gemini with JSON schema (uses `nullable: true` instead of union types)
- `backend/routers/ocr.py` — Single endpoint, delegates to `llm_service.parse_receipt()`
- `backend/schemas.py` — `ReceiptScanItem`, `ReceiptScanResponse`

### Frontend

**ReceiptScanner** (`frontend/src/ReceiptScanner.tsx`):
- Two phases: upload → review
- Upload: file picker, image preview, compression before upload
- Review: editable item list (tap to edit inline), tax/tip/total summary, collapsible receipt image
- Passes items + tax + tip + total to `AddExpenseModal` via `onItemsDetected` callback

**AddExpenseModal** (`frontend/src/AddExpenseModal.tsx`):
- `handleScannedItems` receives items, tax, tip, and total from scanner
- Sets itemized items, tax amount, tip amount, and total directly from receipt
- Uses receipt's `total_cents` as expense amount (avoids rounding errors from recomputing)
- Shows validation warning if items + tax + tip ≠ receipt total

### Removed Files

- `backend/ocr/parser.py`, `parser_v2.py`, `regions.py`, `service.py` — Old Google Vision OCR
- `backend/tests/test_ocr*.py` — Old OCR tests
- `frontend/src/components/expense/BoundingBoxEditor.tsx`
- `frontend/src/components/expense/ItemPreviewEditor.tsx` (+ example, README)
- `frontend/src/components/expense/ImageEditToolbar.tsx`
- `frontend/src/components/expense/ImageQualityIndicator.tsx`
- `frontend/src/components/expense/PerspectiveCorrectionModal.tsx`
- `frontend/src/hooks/useBoundingBoxes.ts`
- `frontend/src/utils/imagePreprocessing.ts`

## Deployment

Receipt scanning requires an LLM API key. Set via Fly.io secrets:

```bash
# OpenAI (default provider):
fly secrets set OPENAI_API_KEY=sk-your-key-here

# Or Gemini:
fly secrets set GEMINI_API_KEY=your-key-here LLM_PROVIDER=gemini
```

No code changes needed — the backend reads these from environment variables at runtime. Without a key set, the `/ocr/scan-receipt` endpoint will return an error when called.

## Known Limitations

- LLM accuracy: tax amounts can be off by a few cents, complex discount layouts may not always be parsed perfectly
- The review step exists for the user to catch and correct these — validation warning on the expense form flags mismatches
- Each scan costs one LLM API call (~$0.01-0.05 depending on image size and provider)

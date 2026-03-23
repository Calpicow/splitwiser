# Plan: Fix Itemized Expense Editing Bugs

## Working Protocol
- Retroactive plan — all work is completed
- Bugs discovered during comprehensive test coverage effort (see `2026-03-22-1600-comprehensive-test-coverage.md`)

## Overview
Editing an itemized expense with ad-hoc (expense) guests caused a 500 Internal Server Error. Investigation revealed six interrelated bugs across the frontend and backend that broke the load-edit-save round-trip for itemized expenses. The root cause was a JavaScript null-vs-undefined confusion that silently wiped assignment identities, but even after fixing that, four additional backend bugs and one schema gap prevented the edit flow from working correctly.

## Architecture

### How the Itemized Edit Flow Works

1. **GET /expenses/{id}** returns `ExpenseWithSplits`, which includes `items[]` with `assignments[]`. Each assignment carries `user_id`, `is_guest`, and `expense_guest_id` (set to the DB ID for ad-hoc guests, `null` otherwise).

2. **Frontend loads the expense** via `extractItemizedDataFromExpense()` in `expenseTransformations.ts`. This converts API `ExpenseItemDetail` shapes into editable `ExpenseItem` shapes, separating regular items from tax/tip.

3. **User edits** the expense in the form.

4. **Frontend saves** via `assembleItemizedPayload()` and `assembleSplitsPayload()`, which reconstruct the API payload. For expense guest assignments, the frontend must preserve the `expense_guest_id` so the backend can match assignments to existing DB records.

5. **PUT /expenses/{id}** receives the payload. For ITEMIZED expenses, the backend:
   - Deletes all old `ExpenseItem` and `ExpenseItemAssignment` rows
   - Calls `calculate_itemized_splits_with_expense_guests()` to derive per-person amounts from item assignments
   - Creates new items and assignments
   - Updates `ExpenseGuest.amount_owed` for each ad-hoc guest

## Current State (Before Fix)

Editing any itemized expense with expense guests crashed with a 500 error. The chain of failures:

### Bug 1 — Frontend: `null !== undefined` identity wipe (root cause of 500)
`extractItemizedDataFromExpense()` checked `a.expense_guest_id !== undefined` to decide whether an assignment was an expense guest. The API returns `null` (not `undefined`) for non-expense-guest assignments. Since `null !== undefined` is `true` in JavaScript, **every** assignment entered the expense guest branch, setting `user_id` to `null` (the value of `expense_guest_id`). This wiped every assignment's identity during the load/save round-trip. When the backend received `user_id: null` and tried `int("None")`, it crashed with a 500.

**Fix:** Changed `!== undefined` to `!= null` (which correctly handles both `null` and `undefined`).

**File:** `frontend/src/utils/expenseTransformations.ts` — `extractItemizedDataFromExpense()`

### Bug 2 — Backend: Wrong split calculation function on update
The update endpoint used `calculate_itemized_splits()` for expenses with expense guests instead of `calculate_itemized_splits_with_expense_guests()`. The non-guest-aware function doesn't understand `expense_guest_id` assignments, so it silently dropped all expense guest amounts.

**Fix:** Added detection of expense guest assignments and existing expense guests in the update path, dispatching to `calculate_itemized_splits_with_expense_guests()` when appropriate.

**File:** `backend/routers/expenses.py` — `update_expense()`, ITEMIZED branch

### Bug 3 — Backend: `ExpenseGuest.amount_owed` never updated on edit
The create endpoint correctly set `amount_owed` on `ExpenseGuest` records from the itemized calculation results. The update endpoint did not — it recalculated splits but never wrote the new amounts back to the `ExpenseGuest` rows.

**Fix:** Added a post-calculation loop in the update endpoint that writes `expense_guest_amounts` back to the corresponding `ExpenseGuest` DB records, using both the `temp_id_to_expense_guest` mapping and a fallback to DB ID lookup.

**File:** `backend/routers/expenses.py` — `update_expense()`, after split creation

### Bug 4 — Backend: Expense guest lookup by name instead of ID
When building the `temp_id_to_expense_guest` mapping during updates, the code matched expense guests by `name`. This is fragile — if two guests share a name, or if a name changes, assignments are silently dropped. The frontend sends `expense_guest_id` (the DB ID), which is the correct identifier to use.

**Fix:** The assignment processing now checks `assignment.expense_guest_id` first (direct DB ID from the edit flow), then falls back to `temp_guest_id` mapping, and finally to integer-parsed ID lookup. Name-based lookup is kept only as a last resort for backward compatibility.

**File:** `backend/routers/expenses.py` — item assignment storage in `update_expense()`

### Bug 5 — Backend schema: `ItemAssignment` missing `expense_guest_id` field
The `ItemAssignment` Pydantic schema only had `user_id`, `is_guest`, and `temp_guest_id`. There was no `expense_guest_id` field, so when the frontend sent `expense_guest_id` on edits, Pydantic silently dropped it. The backend could never receive a direct expense guest ID reference.

**Fix:** Added `expense_guest_id: Optional[int] = None` to `ItemAssignment`. Updated `get_assignment_key()` in `splits.py` to check `expense_guest_id` alongside `temp_guest_id`.

**Files:**
- `backend/schemas.py` — `ItemAssignment` class
- `backend/utils/splits.py` — `get_assignment_key()`

### Bug 6 — Frontend: `amountToCents('')` returned NaN
When tax or tip fields were empty strings, `parseFloat('')` returns `NaN`, which propagated through calculations. This caused `NaN` amounts in the payload.

**Fix:** Added `|| '0'` fallback: `parseFloat(amount || '0')`.

**File:** `frontend/src/utils/expenseTransformations.ts` — `amountToCents()`

## Proposed Changes

Fix all six bugs to make the itemized expense edit round-trip work correctly with expense guests, group guests, and regular users.

## Implementation Steps

### Step 1: Fix frontend null-vs-undefined check (Bug 1)
- [x] Change `a.expense_guest_id !== undefined` to `a.expense_guest_id != null` in `extractItemizedDataFromExpense()`

### Step 2: Fix backend split calculation dispatch (Bug 2)
- [x] Add detection of `expense_guest_id` and `temp_guest_id` in item assignments
- [x] Query for existing `ExpenseGuest` records on the expense
- [x] Dispatch to `calculate_itemized_splits_with_expense_guests()` when expense guests are present

### Step 3: Fix backend expense guest amount update (Bug 3)
- [x] After calculating itemized splits, iterate `expense_guest_amounts` and write amounts back to `ExpenseGuest` DB records
- [x] Use `temp_id_to_expense_guest` mapping first, fall back to DB ID lookup

### Step 4: Fix backend expense guest assignment lookup (Bug 4)
- [x] Check `assignment.expense_guest_id` first (direct DB ID from edit flow)
- [x] Fall back to `temp_guest_id` mapping, then integer ID parse, then name lookup

### Step 5: Add `expense_guest_id` to `ItemAssignment` schema (Bug 5)
- [x] Add `expense_guest_id: Optional[int] = None` field to `ItemAssignment` in `schemas.py`
- [x] Update `get_assignment_key()` in `splits.py` to handle `expense_guest_id`

### Step 6: Fix `amountToCents` NaN on empty string (Bug 6)
- [x] Add `|| '0'` fallback in `amountToCents()` so `parseFloat('')` becomes `parseFloat('0')`

### Step 7: Verify fixes with tests
- [x] Backend integration tests for itemized expense update with expense guests pass
- [x] Frontend unit tests for `extractItemizedDataFromExpense` with null `expense_guest_id` pass
- [x] Frontend unit tests for `amountToCents('')` returning 0 pass

## Acceptance Criteria
- [x] Editing an itemized expense with expense guests no longer returns 500
- [x] Assignment identities (user, group guest, expense guest) are preserved through the load/edit/save round-trip
- [x] `ExpenseGuest.amount_owed` is correctly recalculated on edit
- [x] Expense guest assignments are matched by ID, not name
- [x] Frontend can send `expense_guest_id` directly in item assignments on edits
- [x] Empty tax/tip fields do not produce NaN in the payload
- [x] All existing tests continue to pass

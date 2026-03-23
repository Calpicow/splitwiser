# Plan: Comprehensive Test Coverage for Expense Editing

## Working Protocol
- Use parallel subagents for independent tasks (BE tests vs FE tests can be written concurrently)
- Mark steps done as you complete them
- Run `pytest` after each backend step, `npm run test` after each frontend step
- If blocked, document the blocker here before stopping

## Overview
Add comprehensive test coverage focused on the expense editing flow — the area with the most bugs. Backend integration tests for the expense update endpoint (all split types, guests, edge cases). Frontend unit tests for split calculation utilities, itemized expense state management, and extracted data transformation functions for the edit round-trip.

## User Experience
No user-facing changes. This is a test-only effort to catch and prevent bugs in expense editing.

## Architecture

### How Expense Editing Works at Runtime

**Backend flow (PUT /expenses/{expense_id}):**
1. Client sends JSON payload with updated fields (amount, splits, items, etc.)
2. Backend validates participants exist and belong to the group
3. For non-ITEMIZED: backend uses provided split amounts directly
4. For ITEMIZED: backend deletes all old ExpenseItem + ExpenseItemAssignment rows, recreates from payload, then calls `calculate_itemized_splits()` to derive per-person amounts from item assignments
5. Exchange rate is re-fetched if date or currency changed
6. Single DB commit at end (except bug: currently commits per-item)

**Frontend flow (ExpenseDetailModal handleSave):**
1. `populateFormFromExpense()` loads API response → form state (cents→dollars, splits→splitDetails map, items separated from tax/tip)
2. User edits in the form
3. `handleSave()` reassembles form state → API payload (dollars→cents, splitDetails→splits array, tax/tip re-appended as synthetic items)
4. The round-trip conversion (API→form→API) is where data can be lost or corrupted

**Key risk:** The frontend and backend both do split calculations. The frontend calculates for display/validation, the backend recalculates authoritatively. But for ITEMIZED, the frontend assembles the items+assignments payload that the backend trusts — so frontend bugs directly cause backend data corruption.

## Current State

### Backend Tests
- 53 tests across 25 files in `backend/tests/`
- `test_expenses.py`: 4 tests — basic CRUD for EQUAL and EXACT splits only
- No tests for: updating itemized expenses, changing split types, expense guests on update, payer changes, currency changes
- `conftest.py`: good fixtures for db_session, client, test_user, auth_headers

### Frontend Tests
- Zero test files, zero test infrastructure
- Vitest not installed
- `expenseCalculations.ts`: 5 pure functions, fully testable as-is
- `useItemizedExpense.ts`: React hook, testable with `@testing-library/react` renderHook
- Data transformation logic in `ExpenseDetailModal.tsx` and `AddExpenseModal.tsx` is tightly coupled to React state — needs extraction to test

### Known Bugs in Update Endpoint
1. Uses `calculate_itemized_splits()` instead of `calculate_itemized_splits_with_expense_guests()` for expenses with expense guests
2. `amount_owed` for expense guests is never updated on edit
3. Expense guest lookup matches by `name` instead of ID — assignments silently lost

## Proposed Changes

### Strategy
Three parallel workstreams:

**1. Backend integration tests** — Write thorough tests for the expense update endpoint exercising every split type, split type transitions, guest scenarios, and the known bugs. These tests use the existing pytest + TestClient infrastructure. No mocking — hit the real (in-memory) database.

**2. Frontend unit tests for pure logic** — Install Vitest, write tests for `expenseCalculations.ts` (pure functions) and `useItemizedExpense.ts` (hook via renderHook). These are straightforward.

**3. Frontend unit tests for data transformations** — Extract the load/save transformation logic from `ExpenseDetailModal.tsx` and `AddExpenseModal.tsx` into pure utility functions in a new file (`frontend/src/utils/expenseTransformations.ts`). Then test those functions. This gives us coverage of the most bug-prone code path without needing component rendering or E2E.

### Why extract rather than test components?
- Component tests would require mocking API calls, auth context, router, etc.
- The bugs are in data transformation, not UI rendering
- Extracted functions are faster to test, easier to maintain, and clarify the code

### Complexity Assessment
**Medium-high.** ~8 files modified/created. Backend tests follow existing patterns (low risk). Frontend requires new infrastructure (Vitest setup) and refactoring (extraction of transformation logic). The extraction is the trickiest part — must ensure the components still work after pulling logic out. Risk of regressions is low since we're adding tests and extracting pure functions without changing behavior.

## Impact Analysis
- **New Files**:
  - `frontend/src/utils/expenseTransformations.ts` — extracted data transformation functions
  - `frontend/src/utils/__tests__/expenseCalculations.test.ts`
  - `frontend/src/utils/__tests__/expenseTransformations.test.ts`
  - `frontend/src/hooks/__tests__/useItemizedExpense.test.ts`
  - `backend/tests/test_expense_update.py`
  - `frontend/vitest.config.ts` (if needed separately from vite.config.ts)
- **Modified Files**:
  - `frontend/package.json` — add vitest + testing-library devDependencies
  - `frontend/vite.config.ts` — add test config (if using inline config)
  - `frontend/src/ExpenseDetailModal.tsx` — import extracted functions instead of inline logic
  - `frontend/src/AddExpenseModal.tsx` — import extracted functions instead of inline logic
- **Dependencies**: Vitest, @testing-library/react, @testing-library/react-hooks (or Vitest's built-in)
- **Similar Modules**: Follow patterns from `backend/tests/test_expenses.py` and `backend/tests/test_guest_claim_edge_cases.py`

## Key Decisions
- No E2E or browser-based tests — unit tests only
- Frontend tests use Vitest (natural fit with Vite)
- Extract transformation logic rather than test React components directly
- Backend tests are integration tests hitting real (in-memory) SQLite — no mocking

## Implementation Steps

### Step 1: Backend — Expense Update Integration Tests
- [x] Create `backend/tests/test_expense_update.py`
- [x] Test: Update expense with EQUAL split — change amount, verify splits recalculated
- [x] Test: Update expense with EXACT split — change individual amounts
- [x] Test: Update expense with PERCENTAGE split — change percentages
- [x] Test: Update expense with SHARES split — change share counts
- [x] Test: Update ITEMIZED expense — change items, verify splits recalculated from assignments
- [x] Test: Update ITEMIZED expense — add/remove items
- [x] Test: Update ITEMIZED expense with tax/tip items — verify proportional distribution
- [x] Test: Change split type (EQUAL → EXACT, EQUAL → ITEMIZED, ITEMIZED → EQUAL)
- [x] Test: Change payer on update
- [x] Test: Change payer to guest on update
- [x] Test: Change currency on update — verify exchange rate re-fetched
- [x] Test: Change date on update — verify exchange rate re-fetched
- [x] Test: Update expense with group guest participants
- [x] Test: Update ITEMIZED expense with group guest assignments
- [x] Test: Verify unauthorized user cannot update another user's expense
- [x] Test: Verify updating non-existent expense returns 404

### Step 2: Frontend — Install Vitest and Configure
- [x] Add vitest, @testing-library/react, @testing-library/react-hooks, jsdom to devDependencies in `frontend/package.json`
- [x] Add test config to `frontend/vite.config.ts` (or create `frontend/vitest.config.ts`)
- [x] Add `"test": "vitest"` script to `frontend/package.json`
- [x] Verify `npx vitest --run` works with an empty test

### Step 3: Frontend — Unit Tests for expenseCalculations.ts
- [x] Create `frontend/src/utils/__tests__/expenseCalculations.test.ts`
- [x] Test: calculateEqualSplit — even division (no remainder)
- [x] Test: calculateEqualSplit — uneven division (remainder assigned to first participant)
- [x] Test: calculateEqualSplit — single participant gets full amount
- [x] Test: calculateEqualSplit — with guest participants (isGuest flag preserved)
- [x] Test: calculateExactSplit — amounts sum to total (valid)
- [x] Test: calculateExactSplit — amounts don't sum to total (returns error)
- [x] Test: calculateExactSplit — tolerance of 1 cent
- [x] Test: calculateExactSplit — missing splitDetails key defaults to 0
- [x] Test: calculatePercentSplit — equal percentages
- [x] Test: calculatePercentSplit — percentages don't sum to 100 (returns error)
- [x] Test: calculatePercentSplit — last participant gets remainder (rounding)
- [x] Test: calculateSharesSplit — equal shares
- [x] Test: calculateSharesSplit — unequal shares
- [x] Test: calculateSharesSplit — zero total shares (returns error)
- [x] Test: calculateSharesSplit — last participant gets remainder
- [x] Test: calculateItemizedTotal — items + tax + tip
- [x] Test: calculateItemizedTotal — empty tax/tip strings treated as 0

### Step 4: Frontend — Extract Data Transformation Functions
- [x] Create `frontend/src/utils/expenseTransformations.ts`
- [x] Extract `parseParticipantKey(key: string) → { type: 'user' | 'guest' | 'expenseguest', id: number }`
- [x] Extract `buildParticipantKey(type, id) → string`
- [x] Extract `extractParticipantKeysFromExpense(expense: ExpenseWithSplits) → string[]`
- [x] Extract `extractSplitDetailsFromExpense(expense: ExpenseWithSplits) → Record<string, number>`
- [x] Extract `extractItemizedDataFromExpense(expense: ExpenseWithSplits) → { items: ExpenseItem[], taxAmount: string, tipAmount: string }`
- [x] Extract `assembleItemizedPayload(items: ExpenseItem[], taxAmount: string, tipAmount: string) → { items: ExpenseItem[], totalCents: number }`
- [x] Extract `assembleSplitsPayload(splitType, participants, splitDetails, totalAmountCents) → SplitResult[]`
- [x] Extract `amountToCents(amount: string) → number` and `centsToDisplayAmount(cents: number) → string`
- [x] Update `ExpenseDetailModal.tsx` to import and use extracted functions
- [x] Update `AddExpenseModal.tsx` to import and use extracted functions
- [x] Verify the app still works (manual smoke test or existing behavior unchanged)

### Step 5: Frontend — Unit Tests for expenseTransformations.ts
- [x] Create `frontend/src/utils/__tests__/expenseTransformations.test.ts`
- [x] Test: parseParticipantKey — "user_5" → { type: 'user', id: 5 }
- [x] Test: parseParticipantKey — "guest_3" → { type: 'guest', id: 3 }
- [x] Test: parseParticipantKey — "expenseguest_12" → { type: 'expenseguest', id: 12 }
- [x] Test: buildParticipantKey — round-trips with parseParticipantKey
- [x] Test: extractParticipantKeysFromExpense — with splits + expense guests
- [x] Test: extractSplitDetailsFromExpense — PERCENTAGE split → { "user_5": 60, "guest_3": 40 }
- [x] Test: extractSplitDetailsFromExpense — SHARES split
- [x] Test: extractSplitDetailsFromExpense — EXACT split (amount_owed in dollars)
- [x] Test: extractItemizedDataFromExpense — separates regular items from tax/tip
- [x] Test: extractItemizedDataFromExpense — handles combined "Tax/Tip" item
- [x] Test: extractItemizedDataFromExpense — no tax/tip items → empty strings
- [x] Test: extractItemizedDataFromExpense — preserves expense_guest_id in assignments
- [x] Test: assembleItemizedPayload — appends tax item when > 0
- [x] Test: assembleItemizedPayload — appends tip item when > 0
- [x] Test: assembleItemizedPayload — skips tax/tip when 0 or empty string
- [x] Test: assembleItemizedPayload — calculates correct totalCents
- [x] Test: assembleSplitsPayload — EQUAL split delegates to calculateEqualSplit
- [x] Test: assembleSplitsPayload — filters out expense guest participants
- [x] Test: amountToCents — "12.50" → 1250
- [x] Test: amountToCents — "0.01" → 1 (no floating point error)
- [x] Test: centsToDisplayAmount — 1250 → "12.50"
- [x] Test: Round-trip: load expense → extract data → reassemble payload → compare with original API shape (the critical integration test)
- [x] Test: Round-trip with itemized expense + tax + tip
- [x] Test: Round-trip with expense guests in itemized assignments

### Step 6: Frontend — Unit Tests for useItemizedExpense Hook
- [x] Create `frontend/src/hooks/__tests__/useItemizedExpense.test.ts`
- [x] Test: Initial state — empty items, empty tax/tip
- [x] Test: addManualItem — adds item with correct defaults (is_tax_tip: false, empty assignments, split_type: 'EQUAL')
- [x] Test: removeItem — removes by index, preserves others
- [x] Test: toggleItemAssignment — adds participant to item
- [x] Test: toggleItemAssignment — removes existing participant from item
- [x] Test: toggleItemAssignment — expense guest uses expense_guest_id matching
- [x] Test: toggleItemAssignment — regular guest uses user_id + is_guest matching
- [x] Test: changeSplitType — EQUAL to SHARES initializes shares: 1 for each assignee
- [x] Test: changeSplitType — EQUAL to PERCENT initializes equal percentages
- [x] Test: changeSplitType — EQUAL to EXACT initializes equal amounts
- [x] Test: changeSplitType — preserves existing split_details when switching
- [x] Test: updateSplitDetail — updates specific participant's detail
- [x] Test: setTipFromPercentage — 20% of $50 subtotal = $10.00
- [x] Test: getSubtotalCents — sums item prices correctly

## Acceptance Criteria
- [x] [test] All 5 split types tested for expense updates (EQUAL, EXACT, PERCENT, SHARES, ITEMIZED)
- [x] [test] Split type change on update tested (at least 3 transitions)
- [x] [test] Payer change on update tested (regular user and guest)
- [x] [test] Currency/date change triggers exchange rate update
- [x] [test] Itemized expense update with guest assignments tested
- [x] [test] All 5 frontend split calculation functions have full coverage (happy path + error cases + edge cases)
- [x] [test] Itemized expense hook state management tested (add, remove, toggle, split type change)
- [x] [test] Data transformation round-trip tested: API response → form state → API payload preserves data integrity
- [x] [test] Tax/tip extraction and reassembly tested
- [x] [test] Expense guest assignment preservation tested through load/save cycle
- [x] [test] `npm run test` passes in frontend, `pytest` passes in backend
- [ ] [test-manual] Edit an itemized expense with tax, tip, and guest assignments in the UI — verify amounts are correct after save

## Edge Cases
- Equal split with odd amounts (e.g., $10 split 3 ways → 334 + 333 + 333 cents)
- Percentage split where percentages sum to 100% but cent amounts have rounding errors
- Itemized expense with zero-assignment items (unassigned items)
- Expense guest with temp_id during creation vs actual id during edit
- Tax/tip items with $0.00 amount (should be excluded from payload)
- Changing from ITEMIZED to EQUAL should clear items
- Changing from EQUAL to ITEMIZED without providing items should error
- Amount conversion edge cases: "0.1" → 10 cents, "99.999" → 10000 cents

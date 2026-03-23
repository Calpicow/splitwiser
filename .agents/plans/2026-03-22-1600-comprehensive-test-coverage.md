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
- [ ] Create `backend/tests/test_expense_update.py`
- [ ] Test: Update expense with EQUAL split — change amount, verify splits recalculated
- [ ] Test: Update expense with EXACT split — change individual amounts
- [ ] Test: Update expense with PERCENTAGE split — change percentages
- [ ] Test: Update expense with SHARES split — change share counts
- [ ] Test: Update ITEMIZED expense — change items, verify splits recalculated from assignments
- [ ] Test: Update ITEMIZED expense — add/remove items
- [ ] Test: Update ITEMIZED expense with tax/tip items — verify proportional distribution
- [ ] Test: Change split type (EQUAL → EXACT, EQUAL → ITEMIZED, ITEMIZED → EQUAL)
- [ ] Test: Change payer on update
- [ ] Test: Change payer to guest on update
- [ ] Test: Change currency on update — verify exchange rate re-fetched
- [ ] Test: Change date on update — verify exchange rate re-fetched
- [ ] Test: Update expense with group guest participants
- [ ] Test: Update ITEMIZED expense with group guest assignments
- [ ] Test: Verify unauthorized user cannot update another user's expense
- [ ] Test: Verify updating non-existent expense returns 404

### Step 2: Frontend — Install Vitest and Configure
- [ ] Add vitest, @testing-library/react, @testing-library/react-hooks, jsdom to devDependencies in `frontend/package.json`
- [ ] Add test config to `frontend/vite.config.ts` (or create `frontend/vitest.config.ts`)
- [ ] Add `"test": "vitest"` script to `frontend/package.json`
- [ ] Verify `npx vitest --run` works with an empty test

### Step 3: Frontend — Unit Tests for expenseCalculations.ts
- [ ] Create `frontend/src/utils/__tests__/expenseCalculations.test.ts`
- [ ] Test: calculateEqualSplit — even division (no remainder)
- [ ] Test: calculateEqualSplit — uneven division (remainder assigned to first participant)
- [ ] Test: calculateEqualSplit — single participant gets full amount
- [ ] Test: calculateEqualSplit — with guest participants (isGuest flag preserved)
- [ ] Test: calculateExactSplit — amounts sum to total (valid)
- [ ] Test: calculateExactSplit — amounts don't sum to total (returns error)
- [ ] Test: calculateExactSplit — tolerance of 1 cent
- [ ] Test: calculateExactSplit — missing splitDetails key defaults to 0
- [ ] Test: calculatePercentSplit — equal percentages
- [ ] Test: calculatePercentSplit — percentages don't sum to 100 (returns error)
- [ ] Test: calculatePercentSplit — last participant gets remainder (rounding)
- [ ] Test: calculateSharesSplit — equal shares
- [ ] Test: calculateSharesSplit — unequal shares
- [ ] Test: calculateSharesSplit — zero total shares (returns error)
- [ ] Test: calculateSharesSplit — last participant gets remainder
- [ ] Test: calculateItemizedTotal — items + tax + tip
- [ ] Test: calculateItemizedTotal — empty tax/tip strings treated as 0

### Step 4: Frontend — Extract Data Transformation Functions
- [ ] Create `frontend/src/utils/expenseTransformations.ts`
- [ ] Extract `parseParticipantKey(key: string) → { type: 'user' | 'guest' | 'expenseguest', id: number }`
- [ ] Extract `buildParticipantKey(type, id) → string`
- [ ] Extract `extractParticipantKeysFromExpense(expense: ExpenseWithSplits) → string[]`
- [ ] Extract `extractSplitDetailsFromExpense(expense: ExpenseWithSplits) → Record<string, number>`
- [ ] Extract `extractItemizedDataFromExpense(expense: ExpenseWithSplits) → { items: ExpenseItem[], taxAmount: string, tipAmount: string }`
- [ ] Extract `assembleItemizedPayload(items: ExpenseItem[], taxAmount: string, tipAmount: string) → { items: ExpenseItem[], totalCents: number }`
- [ ] Extract `assembleSplitsPayload(splitType, participants, splitDetails, totalAmountCents) → SplitResult[]`
- [ ] Extract `amountToCents(amount: string) → number` and `centsToDisplayAmount(cents: number) → string`
- [ ] Update `ExpenseDetailModal.tsx` to import and use extracted functions
- [ ] Update `AddExpenseModal.tsx` to import and use extracted functions
- [ ] Verify the app still works (manual smoke test or existing behavior unchanged)

### Step 5: Frontend — Unit Tests for expenseTransformations.ts
- [ ] Create `frontend/src/utils/__tests__/expenseTransformations.test.ts`
- [ ] Test: parseParticipantKey — "user_5" → { type: 'user', id: 5 }
- [ ] Test: parseParticipantKey — "guest_3" → { type: 'guest', id: 3 }
- [ ] Test: parseParticipantKey — "expenseguest_12" → { type: 'expenseguest', id: 12 }
- [ ] Test: buildParticipantKey — round-trips with parseParticipantKey
- [ ] Test: extractParticipantKeysFromExpense — with splits + expense guests
- [ ] Test: extractSplitDetailsFromExpense — PERCENTAGE split → { "user_5": 60, "guest_3": 40 }
- [ ] Test: extractSplitDetailsFromExpense — SHARES split
- [ ] Test: extractSplitDetailsFromExpense — EXACT split (amount_owed in dollars)
- [ ] Test: extractItemizedDataFromExpense — separates regular items from tax/tip
- [ ] Test: extractItemizedDataFromExpense — handles combined "Tax/Tip" item
- [ ] Test: extractItemizedDataFromExpense — no tax/tip items → empty strings
- [ ] Test: extractItemizedDataFromExpense — preserves expense_guest_id in assignments
- [ ] Test: assembleItemizedPayload — appends tax item when > 0
- [ ] Test: assembleItemizedPayload — appends tip item when > 0
- [ ] Test: assembleItemizedPayload — skips tax/tip when 0 or empty string
- [ ] Test: assembleItemizedPayload — calculates correct totalCents
- [ ] Test: assembleSplitsPayload — EQUAL split delegates to calculateEqualSplit
- [ ] Test: assembleSplitsPayload — filters out expense guest participants
- [ ] Test: amountToCents — "12.50" → 1250
- [ ] Test: amountToCents — "0.01" → 1 (no floating point error)
- [ ] Test: centsToDisplayAmount — 1250 → "12.50"
- [ ] Test: Round-trip: load expense → extract data → reassemble payload → compare with original API shape (the critical integration test)
- [ ] Test: Round-trip with itemized expense + tax + tip
- [ ] Test: Round-trip with expense guests in itemized assignments

### Step 6: Frontend — Unit Tests for useItemizedExpense Hook
- [ ] Create `frontend/src/hooks/__tests__/useItemizedExpense.test.ts`
- [ ] Test: Initial state — empty items, empty tax/tip
- [ ] Test: addManualItem — adds item with correct defaults (is_tax_tip: false, empty assignments, split_type: 'EQUAL')
- [ ] Test: removeItem — removes by index, preserves others
- [ ] Test: toggleItemAssignment — adds participant to item
- [ ] Test: toggleItemAssignment — removes existing participant from item
- [ ] Test: toggleItemAssignment — expense guest uses expense_guest_id matching
- [ ] Test: toggleItemAssignment — regular guest uses user_id + is_guest matching
- [ ] Test: changeSplitType — EQUAL to SHARES initializes shares: 1 for each assignee
- [ ] Test: changeSplitType — EQUAL to PERCENT initializes equal percentages
- [ ] Test: changeSplitType — EQUAL to EXACT initializes equal amounts
- [ ] Test: changeSplitType — preserves existing split_details when switching
- [ ] Test: updateSplitDetail — updates specific participant's detail
- [ ] Test: setTipFromPercentage — 20% of $50 subtotal = $10.00
- [ ] Test: getSubtotalCents — sums item prices correctly

## Acceptance Criteria
- [ ] [test] All 5 split types tested for expense updates (EQUAL, EXACT, PERCENT, SHARES, ITEMIZED)
- [ ] [test] Split type change on update tested (at least 3 transitions)
- [ ] [test] Payer change on update tested (regular user and guest)
- [ ] [test] Currency/date change triggers exchange rate update
- [ ] [test] Itemized expense update with guest assignments tested
- [ ] [test] All 5 frontend split calculation functions have full coverage (happy path + error cases + edge cases)
- [ ] [test] Itemized expense hook state management tested (add, remove, toggle, split type change)
- [ ] [test] Data transformation round-trip tested: API response → form state → API payload preserves data integrity
- [ ] [test] Tax/tip extraction and reassembly tested
- [ ] [test] Expense guest assignment preservation tested through load/save cycle
- [ ] [test] `npm run test` passes in frontend, `pytest` passes in backend
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

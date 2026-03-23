// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type {
    Participant,
    ExpenseItem,
    ExpenseWithSplits,
    ExpenseItemDetail,
    ExpenseSplit,
    ExpenseGuest,
} from '../../types/expense';
import {
    parseParticipantKey,
    buildParticipantKey,
    extractParticipantKeysFromExpense,
    extractSplitDetailsFromExpense,
    extractItemizedDataFromExpense,
    assembleItemizedPayload,
    assembleSplitsPayload,
    amountToCents,
    centsToDisplayAmount,
} from '../expenseTransformations';

// ── Helpers ─────────────────────────────────────────────────────────

const makeSplit = (overrides: Partial<ExpenseSplit>): ExpenseSplit => ({
    id: 1,
    expense_id: 100,
    user_id: 1,
    is_guest: false,
    amount_owed: 0,
    percentage: null,
    shares: null,
    user_name: 'User',
    ...overrides,
});

const makeExpense = (overrides: Partial<ExpenseWithSplits>): ExpenseWithSplits => ({
    id: 100,
    description: 'Test',
    amount: 1000,
    currency: 'USD',
    date: '2026-01-01',
    payer_id: 1,
    payer_is_guest: false,
    group_id: 1,
    created_by_id: 1,
    splits: [],
    split_type: 'EQUAL',
    ...overrides,
});

const makeItemDetail = (overrides: Partial<ExpenseItemDetail>): ExpenseItemDetail => ({
    id: 1,
    expense_id: 100,
    description: 'Item',
    price: 500,
    is_tax_tip: false,
    assignments: [],
    ...overrides,
});

// ── parseParticipantKey ─────────────────────────────────────────────

describe('parseParticipantKey', () => {
    it('"user_5" → { type: "user", id: 5 }', () => {
        expect(parseParticipantKey('user_5')).toEqual({ type: 'user', id: 5 });
    });

    it('"guest_3" → { type: "guest", id: 3 }', () => {
        expect(parseParticipantKey('guest_3')).toEqual({ type: 'guest', id: 3 });
    });

    it('"expenseguest_12" → { type: "expenseguest", id: 12 }', () => {
        expect(parseParticipantKey('expenseguest_12')).toEqual({ type: 'expenseguest', id: 12 });
    });
});

// ── buildParticipantKey ─────────────────────────────────────────────

describe('buildParticipantKey', () => {
    it('round-trips with parseParticipantKey for user', () => {
        const key = buildParticipantKey('user', 5);
        expect(parseParticipantKey(key)).toEqual({ type: 'user', id: 5 });
    });

    it('round-trips with parseParticipantKey for guest', () => {
        const key = buildParticipantKey('guest', 3);
        expect(parseParticipantKey(key)).toEqual({ type: 'guest', id: 3 });
    });

    it('round-trips with parseParticipantKey for expenseguest', () => {
        const key = buildParticipantKey('expenseguest', 12);
        expect(parseParticipantKey(key)).toEqual({ type: 'expenseguest', id: 12 });
    });
});

// ── extractParticipantKeysFromExpense ────────────────────────────────

describe('extractParticipantKeysFromExpense', () => {
    it('with regular splits → user_X keys', () => {
        const expense = makeExpense({
            splits: [
                makeSplit({ user_id: 1, is_guest: false }),
                makeSplit({ user_id: 2, is_guest: false }),
            ],
        });
        expect(extractParticipantKeysFromExpense(expense)).toEqual(['user_1', 'user_2']);
    });

    it('with guest splits → guest_X keys', () => {
        const expense = makeExpense({
            splits: [
                makeSplit({ user_id: 10, is_guest: true }),
            ],
        });
        expect(extractParticipantKeysFromExpense(expense)).toEqual(['guest_10']);
    });

    it('with expense_guests → expenseguest_X keys added', () => {
        const expense = makeExpense({
            splits: [
                makeSplit({ user_id: 50, is_guest: false }),
            ],
            expense_guests: [
                { id: 50, expense_id: 100, name: 'Ad-hoc Guest', amount_owed: 500, paid: false, paid_at: null },
            ],
        });
        expect(extractParticipantKeysFromExpense(expense)).toEqual(['expenseguest_50']);
    });

    it('combined: splits + expense guests', () => {
        const expense = makeExpense({
            splits: [
                makeSplit({ user_id: 1, is_guest: false }),
                makeSplit({ user_id: 10, is_guest: true }),
                makeSplit({ user_id: 50, is_guest: false }),
            ],
            expense_guests: [
                { id: 50, expense_id: 100, name: 'Ad-hoc', amount_owed: 0, paid: false, paid_at: null },
            ],
        });
        const keys = extractParticipantKeysFromExpense(expense);
        expect(keys).toEqual(['user_1', 'guest_10', 'expenseguest_50']);
    });
});

// ── extractSplitDetailsFromExpense ──────────────────────────────────

describe('extractSplitDetailsFromExpense', () => {
    it('PERCENT split → percentage values keyed by participant', () => {
        const expense = makeExpense({
            split_type: 'PERCENT',
            splits: [
                makeSplit({ user_id: 5, is_guest: false, percentage: 60 }),
                makeSplit({ user_id: 3, is_guest: true, percentage: 40 }),
            ],
        });
        expect(extractSplitDetailsFromExpense(expense)).toEqual({
            user_5: 60,
            guest_3: 40,
        });
    });

    it('SHARES split → shares values keyed by participant', () => {
        const expense = makeExpense({
            split_type: 'SHARES',
            splits: [
                makeSplit({ user_id: 1, is_guest: false, shares: 2 }),
                makeSplit({ user_id: 2, is_guest: false, shares: 1 }),
            ],
        });
        expect(extractSplitDetailsFromExpense(expense)).toEqual({
            user_1: 2,
            user_2: 1,
        });
    });

    it('EXACT split → amount_owed in dollars (cents / 100)', () => {
        const expense = makeExpense({
            split_type: 'EXACT',
            splits: [
                makeSplit({ user_id: 1, is_guest: false, amount_owed: 600 }),
                makeSplit({ user_id: 2, is_guest: false, amount_owed: 400 }),
            ],
        });
        expect(extractSplitDetailsFromExpense(expense)).toEqual({
            user_1: 6,
            user_2: 4,
        });
    });

    it('EQUAL split → empty object', () => {
        const expense = makeExpense({
            split_type: 'EQUAL',
            splits: [
                makeSplit({ user_id: 1, amount_owed: 500 }),
                makeSplit({ user_id: 2, amount_owed: 500 }),
            ],
        });
        expect(extractSplitDetailsFromExpense(expense)).toEqual({});
    });

    it('ITEMIZED split → empty object', () => {
        const expense = makeExpense({
            split_type: 'ITEMIZED',
            splits: [
                makeSplit({ user_id: 1, amount_owed: 700 }),
            ],
        });
        expect(extractSplitDetailsFromExpense(expense)).toEqual({});
    });
});

// ── extractItemizedDataFromExpense ──────────────────────────────────

describe('extractItemizedDataFromExpense', () => {
    it('separates regular items from tax/tip items', () => {
        const items: ExpenseItemDetail[] = [
            makeItemDetail({ description: 'Burger', price: 1200, is_tax_tip: false }),
            makeItemDetail({ description: 'Tax', price: 100, is_tax_tip: true }),
        ];
        const result = extractItemizedDataFromExpense(items);
        expect(result.items).toHaveLength(1);
        expect(result.items[0].description).toBe('Burger');
    });

    it('handles "Tax" description → taxAmount only', () => {
        const items: ExpenseItemDetail[] = [
            makeItemDetail({ description: 'Pizza', price: 800, is_tax_tip: false }),
            makeItemDetail({ description: 'Tax', price: 150, is_tax_tip: true }),
        ];
        const result = extractItemizedDataFromExpense(items);
        expect(result.taxAmount).toBe('1.50');
        expect(result.tipAmount).toBe('');
    });

    it('handles "Tip" description → tipAmount only', () => {
        const items: ExpenseItemDetail[] = [
            makeItemDetail({ description: 'Pizza', price: 800, is_tax_tip: false }),
            makeItemDetail({ description: 'Tip', price: 200, is_tax_tip: true }),
        ];
        const result = extractItemizedDataFromExpense(items);
        expect(result.taxAmount).toBe('');
        expect(result.tipAmount).toBe('2.00');
    });

    it('handles both Tax and Tip items', () => {
        const items: ExpenseItemDetail[] = [
            makeItemDetail({ description: 'Salad', price: 900, is_tax_tip: false }),
            makeItemDetail({ description: 'Tax', price: 90, is_tax_tip: true }),
            makeItemDetail({ description: 'Tip', price: 180, is_tax_tip: true }),
        ];
        const result = extractItemizedDataFromExpense(items);
        expect(result.taxAmount).toBe('0.90');
        expect(result.tipAmount).toBe('1.80');
    });

    it('no tax/tip items → empty strings', () => {
        const items: ExpenseItemDetail[] = [
            makeItemDetail({ description: 'Coffee', price: 450, is_tax_tip: false }),
        ];
        const result = extractItemizedDataFromExpense(items);
        expect(result.taxAmount).toBe('');
        expect(result.tipAmount).toBe('');
    });

    it('preserves expense_guest_id in assignments', () => {
        const items: ExpenseItemDetail[] = [
            makeItemDetail({
                description: 'Steak',
                price: 2500,
                is_tax_tip: false,
                assignments: [
                    { user_id: 1, is_guest: false, user_name: 'Alice' },
                    { user_id: undefined, is_guest: false, user_name: 'Ad-hoc', expense_guest_id: 50 },
                ],
            }),
        ];
        const result = extractItemizedDataFromExpense(items);
        expect(result.items[0].assignments).toHaveLength(2);
        expect(result.items[0].assignments[0]).toEqual({ user_id: 1, is_guest: false });
        expect(result.items[0].assignments[1]).toEqual({ user_id: 50, is_guest: false, expense_guest_id: 50 });
    });

    it('preserves user_id when expense_guest_id is null', () => {
        const items: ExpenseItemDetail[] = [
            makeItemDetail({
                description: 'Pasta',
                price: 1400,
                is_tax_tip: false,
                assignments: [
                    { user_id: 7, is_guest: false, user_name: 'Charlie', expense_guest_id: null },
                ],
            }),
        ];
        const result = extractItemizedDataFromExpense(items);
        expect(result.items[0].assignments).toHaveLength(1);
        // expense_guest_id: null should NOT cause user_id to become null
        expect(result.items[0].assignments[0].user_id).toBe(7);
        expect(result.items[0].assignments[0].is_guest).toBe(false);
        expect(result.items[0].assignments[0]).not.toHaveProperty('expense_guest_id');
    });

    it('converts item prices from cents to cents (preserves)', () => {
        const items: ExpenseItemDetail[] = [
            makeItemDetail({ description: 'Wine', price: 1500, is_tax_tip: false }),
        ];
        const result = extractItemizedDataFromExpense(items);
        expect(result.items[0].price).toBe(1500);
    });
});

// ── assembleItemizedPayload ─────────────────────────────────────────

describe('assembleItemizedPayload', () => {
    const baseItems: ExpenseItem[] = [
        { description: 'Burger', price: 1200, is_tax_tip: false, assignments: [] },
        { description: 'Fries', price: 500, is_tax_tip: false, assignments: [] },
    ];

    it('appends Tax item when taxAmount > 0', () => {
        const result = assembleItemizedPayload(baseItems, '2.00', '0');
        const taxItem = result.items.find(i => i.description === 'Tax');
        expect(taxItem).toBeDefined();
        expect(taxItem!.price).toBe(200);
        expect(taxItem!.is_tax_tip).toBe(true);
        expect(taxItem!.assignments).toEqual([]);
    });

    it('appends Tip item when tipAmount > 0', () => {
        const result = assembleItemizedPayload(baseItems, '0', '3.00');
        const tipItem = result.items.find(i => i.description === 'Tip');
        expect(tipItem).toBeDefined();
        expect(tipItem!.price).toBe(300);
        expect(tipItem!.is_tax_tip).toBe(true);
    });

    it('skips Tax when taxAmount is "0"', () => {
        const result = assembleItemizedPayload(baseItems, '0', '1.00');
        expect(result.items.find(i => i.description === 'Tax')).toBeUndefined();
    });

    it('skips Tax when taxAmount is empty string', () => {
        const result = assembleItemizedPayload(baseItems, '', '1.00');
        expect(result.items.find(i => i.description === 'Tax')).toBeUndefined();
    });

    it('skips Tip when tipAmount is "0"', () => {
        const result = assembleItemizedPayload(baseItems, '1.00', '0');
        expect(result.items.find(i => i.description === 'Tip')).toBeUndefined();
    });

    it('skips Tip when tipAmount is empty string', () => {
        const result = assembleItemizedPayload(baseItems, '1.00', '');
        expect(result.items.find(i => i.description === 'Tip')).toBeUndefined();
    });

    it('calculates correct totalCents (items + tax + tip)', () => {
        const result = assembleItemizedPayload(baseItems, '2.00', '3.00');
        // 1200 + 500 + 200 + 300 = 2200
        expect(result.totalCents).toBe(2200);
    });

    it('Tax/Tip items have is_tax_tip: true and empty assignments', () => {
        const result = assembleItemizedPayload(baseItems, '1.00', '2.00');
        const taxTipItems = result.items.filter(i => i.is_tax_tip);
        expect(taxTipItems).toHaveLength(2);
        taxTipItems.forEach(item => {
            expect(item.is_tax_tip).toBe(true);
            expect(item.assignments).toEqual([]);
        });
    });
});

// ── assembleSplitsPayload ───────────────────────────────────────────

describe('assembleSplitsPayload', () => {
    const user1: Participant = { id: 1, name: 'Alice', isGuest: false };
    const user2: Participant = { id: 2, name: 'Bob', isGuest: false };
    const guest1: Participant = { id: 10, name: 'Guest', isGuest: true };
    const expenseGuest: Participant = { id: 50, name: 'Ad-hoc', isGuest: false, isExpenseGuest: true };

    it('EQUAL split delegates correctly', () => {
        const result = assembleSplitsPayload('EQUAL', [user1, user2], {}, 1000);
        expect(result.splits).toHaveLength(2);
        expect(result.splits[0].amount_owed).toBe(500);
        expect(result.splits[1].amount_owed).toBe(500);
    });

    it('EXACT split delegates correctly', () => {
        const splitDetails = { user_1: 6, user_2: 4 };
        const result = assembleSplitsPayload('EXACT', [user1, user2], splitDetails, 1000);
        expect(result.error).toBeUndefined();
        expect(result.splits[0].amount_owed).toBe(600);
        expect(result.splits[1].amount_owed).toBe(400);
    });

    it('PERCENT split delegates correctly', () => {
        const splitDetails = { user_1: 60, user_2: 40 };
        const result = assembleSplitsPayload('PERCENT', [user1, user2], splitDetails, 1000);
        expect(result.error).toBeUndefined();
        expect(result.splits[0].amount_owed).toBe(600);
        expect(result.splits[1].amount_owed).toBe(400);
    });

    it('SHARES split delegates correctly', () => {
        const splitDetails = { user_1: 2, user_2: 1 };
        const result = assembleSplitsPayload('SHARES', [user1, user2], splitDetails, 900);
        expect(result.error).toBeUndefined();
        expect(result.splits[0].amount_owed).toBe(600);
        expect(result.splits[1].amount_owed).toBe(300);
    });

    it('ITEMIZED returns all participants with amount_owed: 0', () => {
        const result = assembleSplitsPayload('ITEMIZED', [user1, user2, guest1], {}, 2000);
        expect(result.splits).toHaveLength(3);
        result.splits.forEach(s => {
            expect(s.amount_owed).toBe(0);
        });
        expect(result.splits[2].is_guest).toBe(true);
    });

    it('filters out expense guest participants (isExpenseGuest: true)', () => {
        const result = assembleSplitsPayload('EQUAL', [user1, user2, expenseGuest], {}, 1000);
        // Only user1 and user2 should be in splits
        expect(result.splits).toHaveLength(2);
        expect(result.splits.map(s => s.user_id)).toEqual([1, 2]);
    });
});

// ── amountToCents ───────────────────────────────────────────────────

describe('amountToCents', () => {
    it('"12.50" → 1250', () => {
        expect(amountToCents('12.50')).toBe(1250);
    });

    it('"0.01" → 1 (no floating point error)', () => {
        expect(amountToCents('0.01')).toBe(1);
    });

    it('"100" → 10000', () => {
        expect(amountToCents('100')).toBe(10000);
    });

    it('"0" → 0', () => {
        expect(amountToCents('0')).toBe(0);
    });

    it('"" → 0 (handles empty string)', () => {
        expect(amountToCents('')).toBe(0);
    });

    it('"99.999" → 10000 (rounds correctly)', () => {
        expect(amountToCents('99.999')).toBe(10000);
    });

    it('"0.1" → 10', () => {
        expect(amountToCents('0.1')).toBe(10);
    });
});

// ── centsToDisplayAmount ────────────────────────────────────────────

describe('centsToDisplayAmount', () => {
    it('1250 → "12.50"', () => {
        expect(centsToDisplayAmount(1250)).toBe('12.50');
    });

    it('1 → "0.01"', () => {
        expect(centsToDisplayAmount(1)).toBe('0.01');
    });

    it('0 → "0.00"', () => {
        expect(centsToDisplayAmount(0)).toBe('0.00');
    });

    it('10000 → "100.00"', () => {
        expect(centsToDisplayAmount(10000)).toBe('100.00');
    });
});

// ── Round-trip tests ────────────────────────────────────────────────

describe('Round-trip tests', () => {
    it('non-itemized EQUAL: extract → assemble preserves data', () => {
        const expense = makeExpense({
            split_type: 'EQUAL',
            amount: 1000,
            splits: [
                makeSplit({ user_id: 1, is_guest: false, amount_owed: 500, user_name: 'Alice' }),
                makeSplit({ user_id: 2, is_guest: false, amount_owed: 500, user_name: 'Bob' }),
            ],
        });

        const keys = extractParticipantKeysFromExpense(expense);
        const splitDetails = extractSplitDetailsFromExpense(expense);

        // Rebuild participants from keys
        const participants: Participant[] = keys.map(k => {
            const parsed = parseParticipantKey(k);
            return { id: parsed.id, name: `User${parsed.id}`, isGuest: parsed.type === 'guest', isExpenseGuest: parsed.type === 'expenseguest' };
        });

        const result = assembleSplitsPayload('EQUAL', participants, splitDetails, 1000);
        expect(result.splits).toHaveLength(2);
        const totalReassembled = result.splits.reduce((sum, s) => sum + s.amount_owed, 0);
        expect(totalReassembled).toBe(1000);
        expect(result.splits[0].amount_owed).toBe(500);
        expect(result.splits[1].amount_owed).toBe(500);
    });

    it('non-itemized PERCENTAGE: extract → assemble preserves data', () => {
        const expense = makeExpense({
            split_type: 'PERCENT',
            amount: 1000,
            splits: [
                makeSplit({ user_id: 1, is_guest: false, amount_owed: 600, percentage: 60, user_name: 'Alice' }),
                makeSplit({ user_id: 2, is_guest: false, amount_owed: 400, percentage: 40, user_name: 'Bob' }),
            ],
        });

        const keys = extractParticipantKeysFromExpense(expense);
        const splitDetails = extractSplitDetailsFromExpense(expense);

        expect(splitDetails).toEqual({ user_1: 60, user_2: 40 });

        const participants: Participant[] = keys.map(k => {
            const parsed = parseParticipantKey(k);
            return { id: parsed.id, name: `User${parsed.id}`, isGuest: parsed.type === 'guest' };
        });

        const result = assembleSplitsPayload('PERCENT', participants, splitDetails, 1000);
        expect(result.error).toBeUndefined();
        expect(result.splits[0].amount_owed).toBe(600);
        expect(result.splits[1].amount_owed).toBe(400);
    });

    it('itemized with tax and tip: extract → assemble round-trips', () => {
        const itemDetails: ExpenseItemDetail[] = [
            makeItemDetail({
                id: 1,
                description: 'Burger',
                price: 1200,
                is_tax_tip: false,
                assignments: [{ user_id: 1, is_guest: false, user_name: 'Alice' }],
            }),
            makeItemDetail({
                id: 2,
                description: 'Fries',
                price: 500,
                is_tax_tip: false,
                assignments: [{ user_id: 2, is_guest: false, user_name: 'Bob' }],
            }),
            makeItemDetail({
                id: 3,
                description: 'Tax',
                price: 150,
                is_tax_tip: true,
                assignments: [],
            }),
            makeItemDetail({
                id: 4,
                description: 'Tip',
                price: 300,
                is_tax_tip: true,
                assignments: [],
            }),
        ];

        // Extract
        const extracted = extractItemizedDataFromExpense(itemDetails);
        expect(extracted.items).toHaveLength(2);
        expect(extracted.taxAmount).toBe('1.50');
        expect(extracted.tipAmount).toBe('3.00');

        // Reassemble
        const assembled = assembleItemizedPayload(extracted.items, extracted.taxAmount, extracted.tipAmount);
        expect(assembled.items).toHaveLength(4); // 2 regular + Tax + Tip
        expect(assembled.totalCents).toBe(1200 + 500 + 150 + 300); // 2150

        const taxItem = assembled.items.find(i => i.description === 'Tax');
        const tipItem = assembled.items.find(i => i.description === 'Tip');
        expect(taxItem!.price).toBe(150);
        expect(tipItem!.price).toBe(300);
    });

    it('itemized with expense guests in assignments: extract → assemble preserves', () => {
        const itemDetails: ExpenseItemDetail[] = [
            makeItemDetail({
                id: 1,
                description: 'Steak',
                price: 2500,
                is_tax_tip: false,
                assignments: [
                    { user_id: 1, is_guest: false, user_name: 'Alice' },
                    { user_id: undefined, is_guest: false, user_name: 'Ad-hoc Guest', expense_guest_id: 50 },
                ],
            }),
            makeItemDetail({
                id: 2,
                description: 'Wine',
                price: 1500,
                is_tax_tip: false,
                assignments: [
                    { user_id: undefined, is_guest: false, user_name: 'Ad-hoc Guest', expense_guest_id: 50 },
                ],
            }),
        ];

        // Extract
        const extracted = extractItemizedDataFromExpense(itemDetails);
        expect(extracted.items).toHaveLength(2);

        // Verify expense_guest_id preserved
        const steakAssignments = extracted.items[0].assignments;
        expect(steakAssignments[1].expense_guest_id).toBe(50);

        const wineAssignments = extracted.items[1].assignments;
        expect(wineAssignments[0].expense_guest_id).toBe(50);

        // Reassemble
        const assembled = assembleItemizedPayload(extracted.items, extracted.taxAmount, extracted.tipAmount);
        expect(assembled.items).toHaveLength(2); // no tax/tip
        expect(assembled.totalCents).toBe(4000);

        // Structure preserved
        expect(assembled.items[0].assignments[1].expense_guest_id).toBe(50);
    });

    it('non-itemized EXACT: extract → assemble preserves data', () => {
        const expense = makeExpense({
            split_type: 'EXACT',
            amount: 1000,
            splits: [
                makeSplit({ user_id: 1, is_guest: false, amount_owed: 700, user_name: 'Alice' }),
                makeSplit({ user_id: 2, is_guest: false, amount_owed: 300, user_name: 'Bob' }),
            ],
        });

        const keys = extractParticipantKeysFromExpense(expense);
        const splitDetails = extractSplitDetailsFromExpense(expense);

        // EXACT stores amount in dollars
        expect(splitDetails).toEqual({ user_1: 7, user_2: 3 });

        const participants: Participant[] = keys.map(k => {
            const parsed = parseParticipantKey(k);
            return { id: parsed.id, name: `User${parsed.id}`, isGuest: parsed.type === 'guest' };
        });

        const result = assembleSplitsPayload('EXACT', participants, splitDetails, 1000);
        expect(result.error).toBeUndefined();
        expect(result.splits[0].amount_owed).toBe(700);
        expect(result.splits[1].amount_owed).toBe(300);
    });

    it('non-itemized SHARES: extract → assemble preserves data', () => {
        const expense = makeExpense({
            split_type: 'SHARES',
            amount: 900,
            splits: [
                makeSplit({ user_id: 1, is_guest: false, amount_owed: 600, shares: 2, user_name: 'Alice' }),
                makeSplit({ user_id: 2, is_guest: false, amount_owed: 300, shares: 1, user_name: 'Bob' }),
            ],
        });

        const keys = extractParticipantKeysFromExpense(expense);
        const splitDetails = extractSplitDetailsFromExpense(expense);

        expect(splitDetails).toEqual({ user_1: 2, user_2: 1 });

        const participants: Participant[] = keys.map(k => {
            const parsed = parseParticipantKey(k);
            return { id: parsed.id, name: `User${parsed.id}`, isGuest: parsed.type === 'guest' };
        });

        const result = assembleSplitsPayload('SHARES', participants, splitDetails, 900);
        expect(result.error).toBeUndefined();
        expect(result.splits[0].amount_owed).toBe(600);
        expect(result.splits[1].amount_owed).toBe(300);
    });
});

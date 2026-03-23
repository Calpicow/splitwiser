// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { Participant, ExpenseItem } from '../../types/expense';
import {
    calculateEqualSplit,
    calculateExactSplit,
    calculatePercentSplit,
    calculateSharesSplit,
    calculateItemizedTotal,
} from '../expenseCalculations';

const user1: Participant = { id: 1, name: 'Alice', isGuest: false };
const user2: Participant = { id: 2, name: 'Bob', isGuest: false };
const user3: Participant = { id: 3, name: 'Charlie', isGuest: false };
const guest1: Participant = { id: 10, name: 'Guest', isGuest: true };

describe('calculateEqualSplit', () => {
    it('divides evenly among two participants', () => {
        const result = calculateEqualSplit(1000, [user1, user2]);
        expect(result).toEqual([
            { user_id: 1, is_guest: false, amount_owed: 500 },
            { user_id: 2, is_guest: false, amount_owed: 500 },
        ]);
    });

    it('assigns remainder to first participant for uneven division', () => {
        const result = calculateEqualSplit(1000, [user1, user2, user3]);
        // 1000 / 3 = 333 each, remainder 1 goes to first
        expect(result[0].amount_owed).toBe(334);
        expect(result[1].amount_owed).toBe(333);
        expect(result[2].amount_owed).toBe(333);
        expect(result.reduce((sum, s) => sum + s.amount_owed, 0)).toBe(1000);
    });

    it('gives full amount to a single participant', () => {
        const result = calculateEqualSplit(1000, [user1]);
        expect(result).toHaveLength(1);
        expect(result[0].amount_owed).toBe(1000);
    });

    it('preserves isGuest flag for guest participants', () => {
        const result = calculateEqualSplit(1000, [user1, guest1]);
        expect(result[0].is_guest).toBe(false);
        expect(result[1].is_guest).toBe(true);
        expect(result[0].amount_owed).toBe(500);
        expect(result[1].amount_owed).toBe(500);
    });
});

describe('calculateExactSplit', () => {
    it('returns no error when amounts sum to total', () => {
        const splitDetails = { user_1: 6, user_2: 4 }; // dollars
        const result = calculateExactSplit(1000, [user1, user2], splitDetails);
        expect(result.error).toBeUndefined();
        expect(result.splits[0].amount_owed).toBe(600);
        expect(result.splits[1].amount_owed).toBe(400);
    });

    it('returns error when amounts do not sum to total', () => {
        const splitDetails = { user_1: 3, user_2: 4 };
        const result = calculateExactSplit(1000, [user1, user2], splitDetails);
        expect(result.error).toBeDefined();
        expect(result.error).toContain('do not sum to total');
    });

    it('tolerates a 1-cent discrepancy', () => {
        // Total is 999 cents. Split details: 5.00 + 4.99 = 9.99 = 999 cents.
        // But let's test the tolerance edge: total 1000, sum 999 => diff = 1, within tolerance
        const splitDetails = { user_1: 5, user_2: 4.99 };
        const result = calculateExactSplit(1000, [user1, user2], splitDetails);
        // 500 + 499 = 999, diff from 1000 is 1, which is <= 1
        expect(result.error).toBeUndefined();
    });

    it('defaults missing splitDetails keys to 0', () => {
        const splitDetails = { user_1: 7 }; // user_2 missing, defaults to 0
        const result = calculateExactSplit(1000, [user1, user2], splitDetails);
        expect(result.splits[1].amount_owed).toBe(0);
        // 700 != 1000, so error expected
        expect(result.error).toBeDefined();
    });

    it('handles missing key defaulting to 0 with correct total', () => {
        const splitDetails = { user_1: 10 }; // 10 dollars = 1000 cents, user_2 defaults to 0
        const result = calculateExactSplit(1000, [user1, user2], splitDetails);
        expect(result.splits[0].amount_owed).toBe(1000);
        expect(result.splits[1].amount_owed).toBe(0);
        // sum = 1000, total = 1000 => no error
        expect(result.error).toBeUndefined();
    });
});

describe('calculatePercentSplit', () => {
    it('splits 50/50 correctly', () => {
        const splitDetails = { user_1: 50, user_2: 50 };
        const result = calculatePercentSplit(1000, [user1, user2], splitDetails);
        expect(result.error).toBeUndefined();
        expect(result.splits[0].amount_owed).toBe(500);
        expect(result.splits[1].amount_owed).toBe(500);
    });

    it('returns error when percentages do not sum to 100', () => {
        const splitDetails = { user_1: 40, user_2: 40 };
        const result = calculatePercentSplit(1000, [user1, user2], splitDetails);
        expect(result.error).toBeDefined();
        expect(result.error).toContain('100%');
    });

    it('gives remainder to last participant when rounding causes discrepancy', () => {
        // 33.33 + 33.33 + 33.34 = 100
        const splitDetails = { user_1: 33.33, user_2: 33.33, user_3: 33.34 };
        const result = calculatePercentSplit(1000, [user1, user2, user3], splitDetails);
        expect(result.error).toBeUndefined();
        const total = result.splits.reduce((sum, s) => sum + s.amount_owed, 0);
        expect(total).toBe(1000);
        // Last participant gets the remainder
        expect(result.splits[2].amount_owed).toBe(1000 - result.splits[0].amount_owed - result.splits[1].amount_owed);
    });
});

describe('calculateSharesSplit', () => {
    it('splits equal shares (1:1)', () => {
        const splitDetails = { user_1: 1, user_2: 1 };
        const result = calculateSharesSplit(1000, [user1, user2], splitDetails);
        expect(result.error).toBeUndefined();
        expect(result.splits[0].amount_owed).toBe(500);
        expect(result.splits[1].amount_owed).toBe(500);
    });

    it('splits unequal shares (2:1)', () => {
        const splitDetails = { user_1: 2, user_2: 1 };
        const result = calculateSharesSplit(900, [user1, user2], splitDetails);
        expect(result.error).toBeUndefined();
        expect(result.splits[0].amount_owed).toBe(600);
        expect(result.splits[1].amount_owed).toBe(300);
    });

    it('returns error when total shares is zero', () => {
        const splitDetails = { user_1: 0, user_2: 0 };
        const result = calculateSharesSplit(1000, [user1, user2], splitDetails);
        expect(result.error).toBeDefined();
        expect(result.error).toContain('zero');
    });

    it('gives remainder to last participant when rounding causes discrepancy', () => {
        // 1000 cents split 1:1:1 = 333 + 333 + remainder(334)
        const splitDetails = { user_1: 1, user_2: 1, user_3: 1 };
        const result = calculateSharesSplit(1000, [user1, user2, user3], splitDetails);
        expect(result.error).toBeUndefined();
        const total = result.splits.reduce((sum, s) => sum + s.amount_owed, 0);
        expect(total).toBe(1000);
        // Last participant gets remainder
        expect(result.splits[2].amount_owed).toBe(1000 - result.splits[0].amount_owed - result.splits[1].amount_owed);
    });
});

describe('calculateItemizedTotal', () => {
    it('sums items plus tax and tip', () => {
        const items: ExpenseItem[] = [
            { description: 'Burger', price: 1200, is_tax_tip: false, assignments: [] },
            { description: 'Fries', price: 500, is_tax_tip: false, assignments: [] },
        ];
        // tax = $2.00, tip = $3.00
        const result = calculateItemizedTotal(items, '2.00', '3.00');
        // items: 1700 cents, tax: 200 cents, tip: 300 cents = 2200 cents = $22.00
        expect(result).toBe('22.00');
    });

    it('treats empty tax/tip strings as 0', () => {
        const items: ExpenseItem[] = [
            { description: 'Coffee', price: 450, is_tax_tip: false, assignments: [] },
        ];
        const result = calculateItemizedTotal(items, '', '');
        expect(result).toBe('4.50');
    });

    it('handles zero items with tax/tip only', () => {
        const items: ExpenseItem[] = [];
        const result = calculateItemizedTotal(items, '1.50', '2.50');
        // 0 + 150 + 250 = 400 cents = $4.00
        expect(result).toBe('4.00');
    });
});

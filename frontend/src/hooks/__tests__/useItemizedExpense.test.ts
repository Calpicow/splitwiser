// @vitest-environment happy-dom
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useItemizedExpense } from '../useItemizedExpense';
import type { Participant } from '../../types/expense';

const alice: Participant = { id: 1, name: 'Alice', isGuest: false };
const bob: Participant = { id: 2, name: 'Bob', isGuest: false };
const groupGuest: Participant = { id: 10, name: 'GroupGuest', isGuest: true };
const expenseGuest: Participant = { id: 5, name: 'ExpGuest', isGuest: false, isExpenseGuest: true };

describe('useItemizedExpense', () => {
    it('initial state — empty items, empty tax/tip', () => {
        const { result } = renderHook(() => useItemizedExpense());
        expect(result.current.itemizedItems).toEqual([]);
        expect(result.current.taxAmount).toBe('');
        expect(result.current.tipAmount).toBe('');
    });

    it('addManualItem — adds item with correct defaults', () => {
        const { result } = renderHook(() => useItemizedExpense());

        act(() => {
            result.current.addManualItem('Burger', 1500);
        });

        expect(result.current.itemizedItems).toHaveLength(1);
        const item = result.current.itemizedItems[0];
        expect(item.description).toBe('Burger');
        expect(item.price).toBe(1500);
        expect(item.is_tax_tip).toBe(false);
        expect(item.assignments).toEqual([]);
        expect(item.split_type).toBe('EQUAL');
    });

    it('removeItem — removes by index, preserves others', () => {
        const { result } = renderHook(() => useItemizedExpense());

        act(() => {
            result.current.addManualItem('A', 100);
            result.current.addManualItem('B', 200);
            result.current.addManualItem('C', 300);
        });

        act(() => {
            result.current.removeItem(1);
        });

        expect(result.current.itemizedItems).toHaveLength(2);
        expect(result.current.itemizedItems[0].description).toBe('A');
        expect(result.current.itemizedItems[1].description).toBe('C');
    });

    it('toggleItemAssignment — adds participant to item', () => {
        const { result } = renderHook(() => useItemizedExpense());

        act(() => {
            result.current.addManualItem('Burger', 1500);
        });

        act(() => {
            result.current.toggleItemAssignment(0, alice);
        });

        const assignments = result.current.itemizedItems[0].assignments;
        expect(assignments).toHaveLength(1);
        expect(assignments[0].user_id).toBe(1);
        expect(assignments[0].is_guest).toBe(false);
    });

    it('toggleItemAssignment — removes existing participant', () => {
        const { result } = renderHook(() => useItemizedExpense());

        act(() => {
            result.current.addManualItem('Burger', 1500);
        });

        act(() => {
            result.current.toggleItemAssignment(0, alice);
        });

        act(() => {
            result.current.toggleItemAssignment(0, alice);
        });

        expect(result.current.itemizedItems[0].assignments).toHaveLength(0);
    });

    it('toggleItemAssignment — expense guest uses expense_guest_id matching', () => {
        const { result } = renderHook(() => useItemizedExpense());

        act(() => {
            result.current.addManualItem('Salad', 800);
        });

        act(() => {
            result.current.toggleItemAssignment(0, expenseGuest);
        });

        const assignments = result.current.itemizedItems[0].assignments;
        expect(assignments).toHaveLength(1);
        expect(assignments[0].expense_guest_id).toBe(5);
        expect(assignments[0].user_id).toBe(5);
        expect(assignments[0].is_guest).toBe(false);

        // Toggle again to remove
        act(() => {
            result.current.toggleItemAssignment(0, expenseGuest);
        });

        expect(result.current.itemizedItems[0].assignments).toHaveLength(0);
    });

    it('toggleItemAssignment — regular guest uses user_id + is_guest matching', () => {
        const { result } = renderHook(() => useItemizedExpense());

        act(() => {
            result.current.addManualItem('Soup', 600);
        });

        act(() => {
            result.current.toggleItemAssignment(0, groupGuest);
        });

        const assignments = result.current.itemizedItems[0].assignments;
        expect(assignments).toHaveLength(1);
        expect(assignments[0].user_id).toBe(10);
        expect(assignments[0].is_guest).toBe(true);
    });

    it('changeSplitType — EQUAL to SHARES initializes shares: 1', () => {
        const { result } = renderHook(() => useItemizedExpense());

        act(() => {
            result.current.addManualItem('Pizza', 2000);
        });

        act(() => {
            result.current.toggleItemAssignment(0, alice);
            result.current.toggleItemAssignment(0, bob);
        });

        act(() => {
            result.current.changeSplitType(0, 'SHARES');
        });

        const item = result.current.itemizedItems[0];
        expect(item.split_type).toBe('SHARES');
        expect(item.split_details).toBeDefined();
        expect(item.split_details!['user_1']).toEqual({ shares: 1 });
        expect(item.split_details!['user_2']).toEqual({ shares: 1 });
    });

    it('changeSplitType — EQUAL to PERCENT initializes equal percentages', () => {
        const { result } = renderHook(() => useItemizedExpense());

        act(() => {
            result.current.addManualItem('Pizza', 2000);
        });

        act(() => {
            result.current.toggleItemAssignment(0, alice);
            result.current.toggleItemAssignment(0, bob);
        });

        act(() => {
            result.current.changeSplitType(0, 'PERCENT');
        });

        const item = result.current.itemizedItems[0];
        expect(item.split_type).toBe('PERCENT');
        expect(item.split_details!['user_1']).toEqual({ percentage: 50 });
        expect(item.split_details!['user_2']).toEqual({ percentage: 50 });
    });

    it('changeSplitType — EQUAL to EXACT initializes equal amounts', () => {
        const { result } = renderHook(() => useItemizedExpense());

        act(() => {
            result.current.addManualItem('Pizza', 1000);
        });

        act(() => {
            result.current.toggleItemAssignment(0, alice);
            result.current.toggleItemAssignment(0, bob);
        });

        act(() => {
            result.current.changeSplitType(0, 'EXACT');
        });

        const item = result.current.itemizedItems[0];
        expect(item.split_type).toBe('EXACT');
        expect(item.split_details!['user_1']).toEqual({ amount: 500 });
        expect(item.split_details!['user_2']).toEqual({ amount: 500 });
    });

    it('changeSplitType — preserves existing split_details', () => {
        const { result } = renderHook(() => useItemizedExpense());

        act(() => {
            result.current.addManualItem('Pizza', 2000);
        });

        act(() => {
            result.current.toggleItemAssignment(0, alice);
            result.current.toggleItemAssignment(0, bob);
        });

        // Switch to SHARES and set custom values
        act(() => {
            result.current.changeSplitType(0, 'SHARES');
        });

        act(() => {
            result.current.updateSplitDetail(0, 'user_1', { shares: 3 });
            result.current.updateSplitDetail(0, 'user_2', { shares: 7 });
        });

        // Switch to PERCENT (split_details for SHARES still stored)
        act(() => {
            result.current.changeSplitType(0, 'PERCENT');
        });

        // Switch back to SHARES — existing shares values should be preserved
        act(() => {
            result.current.changeSplitType(0, 'SHARES');
        });

        const item = result.current.itemizedItems[0];
        expect(item.split_details!['user_1'].shares).toBe(3);
        expect(item.split_details!['user_2'].shares).toBe(7);
    });

    it('updateSplitDetail — updates specific participant detail', () => {
        const { result } = renderHook(() => useItemizedExpense());

        act(() => {
            result.current.addManualItem('Pizza', 2000);
        });

        act(() => {
            result.current.toggleItemAssignment(0, alice);
            result.current.toggleItemAssignment(0, bob);
        });

        act(() => {
            result.current.changeSplitType(0, 'SHARES');
        });

        act(() => {
            result.current.updateSplitDetail(0, 'user_1', { shares: 5 });
        });

        const item = result.current.itemizedItems[0];
        expect(item.split_details!['user_1'].shares).toBe(5);
        // Bob's shares should remain at default
        expect(item.split_details!['user_2'].shares).toBe(1);
    });

    it('setTipFromPercentage — 20% of $50 subtotal = $10.00', () => {
        const { result } = renderHook(() => useItemizedExpense());

        act(() => {
            result.current.addManualItem('Item A', 3000);
            result.current.addManualItem('Item B', 2000);
        });

        act(() => {
            result.current.setTipFromPercentage(20);
        });

        expect(result.current.tipAmount).toBe('10.00');
    });

    it('getSubtotalCents — sums item prices', () => {
        const { result } = renderHook(() => useItemizedExpense());

        act(() => {
            result.current.addManualItem('A', 1000);
            result.current.addManualItem('B', 2000);
            result.current.addManualItem('C', 500);
        });

        expect(result.current.getSubtotalCents()).toBe(3500);
    });
});

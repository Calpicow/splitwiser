import type { Participant, ExpenseItem } from '../types/expense';

export interface SplitResult {
    user_id: number;
    is_guest: boolean;
    amount_owed: number;
    percentage?: number;
    shares?: number;
}

/**
 * Calculate equal splits
 */
export const calculateEqualSplit = (
    totalAmountCents: number,
    participants: Participant[]
): SplitResult[] => {
    const splitAmount = Math.floor(totalAmountCents / participants.length);
    const remainder = totalAmountCents - (splitAmount * participants.length);

    return participants.map((p, index) => ({
        user_id: p.id,
        is_guest: p.isGuest,
        amount_owed: splitAmount + (index === 0 ? remainder : 0)
    }));
};

/**
 * Calculate exact amount splits
 */
export const calculateExactSplit = (
    totalAmountCents: number,
    participants: Participant[],
    splitDetails: { [key: string]: string | number }
): { splits: SplitResult[]; error?: string } => {
    const splits = participants.map(p => {
        const key = p.isGuest ? `guest_${p.id}` : `user_${p.id}`;
        return {
            user_id: p.id,
            is_guest: p.isGuest,
            amount_owed: Math.round(parseFloat(splitDetails[key]?.toString() || '0') * 100)
        };
    });

    const sum = splits.reduce((acc, s) => acc + s.amount_owed, 0);
    if (Math.abs(sum - totalAmountCents) > 1) {
        return {
            splits,
            error: `Amounts do not sum to total. Total: ${totalAmountCents / 100}, Sum: ${sum / 100}`
        };
    }

    return { splits };
};

/**
 * Calculate percentage-based splits
 */
export const calculatePercentSplit = (
    totalAmountCents: number,
    participants: Participant[],
    splitDetails: { [key: string]: string | number }
): { splits: SplitResult[]; error?: string } => {
    const shares = participants.map(p => {
        const key = p.isGuest ? `guest_${p.id}` : `user_${p.id}`;
        return {
            participant: p,
            percent: parseFloat(splitDetails[key]?.toString() || '0')
        };
    });

    const percentSum = shares.reduce((acc, s) => acc + s.percent, 0);
    if (Math.abs(percentSum - 100) > 0.1) {
        return {
            splits: [],
            error: `Percentages must sum to 100%. Current: ${percentSum}%`
        };
    }

    let runningTotal = 0;
    const splits = shares.map((s, index) => {
        if (index === shares.length - 1) {
            return {
                user_id: s.participant.id,
                is_guest: s.participant.isGuest,
                amount_owed: totalAmountCents - runningTotal,
                percentage: Math.round(s.percent)
            };
        }
        const share = Math.round(totalAmountCents * (s.percent / 100));
        runningTotal += share;
        return {
            user_id: s.participant.id,
            is_guest: s.participant.isGuest,
            amount_owed: share,
            percentage: Math.round(s.percent)
        };
    });

    return { splits };
};

/**
 * Calculate shares-based splits
 */
export const calculateSharesSplit = (
    totalAmountCents: number,
    participants: Participant[],
    splitDetails: { [key: string]: string | number }
): { splits: SplitResult[]; error?: string } => {
    const sharesMap = participants.map(p => {
        const key = p.isGuest ? `guest_${p.id}` : `user_${p.id}`;
        return {
            participant: p,
            shares: parseFloat(splitDetails[key]?.toString() || '0')
        };
    });

    const totalShares = sharesMap.reduce((acc, s) => acc + s.shares, 0);
    if (totalShares === 0) {
        return {
            splits: [],
            error: "Total shares cannot be zero"
        };
    }

    let runningTotal = 0;
    const splits = sharesMap.map((s, index) => {
        if (index === sharesMap.length - 1) {
            return {
                user_id: s.participant.id,
                is_guest: s.participant.isGuest,
                amount_owed: totalAmountCents - runningTotal,
                shares: s.shares
            };
        }
        const shareAmount = Math.round(totalAmountCents * (s.shares / totalShares));
        runningTotal += shareAmount;
        return {
            user_id: s.participant.id,
            is_guest: s.participant.isGuest,
            amount_owed: shareAmount,
            shares: s.shares
        };
    });

    return { splits };
};

/**
 * Calculate total for itemized expenses
 */
export const calculateItemizedTotal = (
    items: ExpenseItem[],
    taxAmount: string,
    tipAmount: string
): string => {
    const itemsTotal = items.reduce((sum, item) => sum + item.price, 0);
    const tax = Math.round(parseFloat(taxAmount || '0') * 100);
    const tip = Math.round(parseFloat(tipAmount || '0') * 100);
    return ((itemsTotal + tax + tip) / 100).toFixed(2);
};

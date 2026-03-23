import React, { useState, useEffect } from 'react';
import ParticipantSelector from './ParticipantSelector';
import ExpenseSplitTypeSelector from './components/expense/ExpenseSplitTypeSelector';
import ExpenseItemList from './components/expense/ExpenseItemList';
import SplitDetailsInput from './components/expense/SplitDetailsInput';
import IconSelector from './components/expense/IconSelector';
import AddItemModal from './components/AddItemModal';
import AlertDialog from './components/AlertDialog';
import { useItemizedExpense } from './hooks/useItemizedExpense';
import { useSplitDetails } from './hooks/useSplitDetails';
import type {
    ExpenseWithSplits,
    GroupMember,
    GuestMember,
    Participant,
    SplitType
} from './types/expense';
import {
    getParticipantName as getParticipantNameUtil
} from './utils/participantHelpers';
import {
    calculateItemizedTotal
} from './utils/expenseCalculations';
import {
    extractParticipantKeysFromExpense,
    extractSplitDetailsFromExpense,
    extractItemizedDataFromExpense,
    assembleItemizedPayload,
    assembleSplitsPayload,
    amountToCents,
    centsToDisplayAmount,
} from './utils/expenseTransformations';
import { formatMoney, formatDate } from './utils/formatters';
import { CURRENCIES } from './utils/currencyHelpers';
import { expensesApi } from './services/api';
import { offlineExpensesApi } from './services/offlineApi';
import { useSync } from './contexts/SyncContext';
import { getApiUrl } from './api';

interface ExpenseDetailModalProps {
    isOpen: boolean;
    onClose: () => void;
    expenseId: number | null;
    onExpenseUpdated: () => void;
    onExpenseDeleted: () => void;
    groupMembers: GroupMember[];
    groupGuests: GuestMember[];
    currentUserId: number;
    shareLinkId?: string;
    readOnly?: boolean;
    groupDefaultCurrency?: string;
}

const ExpenseDetailModal: React.FC<ExpenseDetailModalProps> = ({
    isOpen,
    onClose,
    expenseId,
    onExpenseUpdated,
    onExpenseDeleted,
    groupMembers,
    groupGuests,
    currentUserId,
    shareLinkId,
    readOnly = false,
    groupDefaultCurrency
}) => {
    const { isOnline: _isOnline } = useSync();
    const [expense, setExpense] = useState<ExpenseWithSplits | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isEditing, setIsEditing] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    // Edit form state
    const [description, setDescription] = useState('');
    const [amount, setAmount] = useState('');
    const [currency, setCurrency] = useState('USD');
    const [notes, setNotes] = useState('');
    const [isSettlement, setIsSettlement] = useState(false);
    const [expenseDate, setExpenseDate] = useState('');
    const [payerId, setPayerId] = useState<number>(0);
    const [payerIsGuest, setPayerIsGuest] = useState(false);
    const [splitType, setSplitType] = useState<SplitType>('EQUAL');
    const [selectedParticipantKeys, setSelectedParticipantKeys] = useState<string[]>([]);
    const [showParticipantSelector, setShowParticipantSelector] = useState(false);
    const [selectedIcon, setSelectedIcon] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [showExchangeRateInfo, setShowExchangeRateInfo] = useState(false);
    const [alertDialog, setAlertDialog] = useState<{
        isOpen: boolean;
        title: string;
        message: string;
        type: 'alert' | 'confirm' | 'success' | 'error';
        onConfirm?: () => void;
    }>({
        isOpen: false,
        title: '',
        message: '',
        type: 'alert'
    });

    // Quick settle state
    const [settlingGuestId, setSettlingGuestId] = useState<number | null>(null);

    // Use custom hooks
    const itemizedExpense = useItemizedExpense();
    const { splitDetails, setSplitDetails, handleSplitDetailChange } = useSplitDetails();

    // Toggle expense guest paid status
    const toggleExpenseGuestPaid = async (guestId: number, paid: boolean) => {
        if (!expense || settlingGuestId !== null) return;

        setSettlingGuestId(guestId);
        try {
            const updatedGuest = await expensesApi.toggleExpenseGuestPaid(expense.id, guestId, paid);
            // Update the expense state with the new guest data
            setExpense(prev => {
                if (!prev || !prev.expense_guests) return prev;
                return {
                    ...prev,
                    expense_guests: prev.expense_guests.map(g =>
                        g.id === guestId ? { ...g, paid: updatedGuest.paid, paid_at: updatedGuest.paid_at } : g
                    )
                };
            });
        } catch (err) {
            console.error('Failed to update guest paid status:', err);
            setAlertDialog({
                isOpen: true,
                title: 'Error',
                message: 'Failed to update payment status',
                type: 'error'
            });
        } finally {
            setSettlingGuestId(null);
        }
    };

    useEffect(() => {
        if (isOpen && expenseId) {
            fetchExpense();
        }
    }, [isOpen, expenseId]);

    useEffect(() => {
        if (expense) {
            populateFormFromExpense(expense);
        }
    }, [expense]);

    const fetchExpense = async () => {
        setIsLoading(true);
        setError(null);

        try {
            let data;
            if (shareLinkId) {
                data = await expensesApi.getPublicById(shareLinkId, expenseId!);
            } else {
                data = await expensesApi.getById(expenseId!);
            }
            setExpense(data);
        } catch (err) {
            setError('Failed to load expense details');
        } finally {
            setIsLoading(false);
        }
    };

    const populateFormFromExpense = (exp: ExpenseWithSplits) => {
        setDescription(exp.description);
        setAmount(centsToDisplayAmount(exp.amount));
        setCurrency(exp.currency);
        setExpenseDate(exp.date.split('T')[0]);
        setPayerId(exp.payer_id);
        setPayerIsGuest(exp.payer_is_guest);
        setSplitType(exp.split_type as SplitType || 'EQUAL');
        setSelectedIcon(exp.icon || null);
        setNotes(exp.notes || '');
        setIsSettlement(exp.is_settlement || false);

        // Set selected participants from splits
        setSelectedParticipantKeys(extractParticipantKeysFromExpense(exp));

        // Set split details for non-EQUAL types
        const details = extractSplitDetailsFromExpense(exp);
        if (Object.keys(details).length > 0) {
            setSplitDetails(details);
        } else {
            setSplitDetails({});
        }

        // Handle ITEMIZED expenses
        if (exp.split_type === 'ITEMIZED' && exp.items) {
            const itemizedData = extractItemizedDataFromExpense(exp.items);
            itemizedExpense.setItems(itemizedData.items);
            itemizedExpense.setTaxAmount(itemizedData.taxAmount);
            itemizedExpense.setTipAmount(itemizedData.tipAmount);
        } else {
            itemizedExpense.setItems([]);
            itemizedExpense.setTaxAmount('');
            itemizedExpense.setTipAmount('');
        }
    };

    // Formatters now imported from utils

    const getPayerName = () => {
        if (!expense) return '';
        if (expense.payer_is_guest) {
            const guest = groupGuests.find(g => g.id === expense.payer_id);
            return guest?.name || 'Unknown Guest';
        }
        if (expense.payer_id === currentUserId) return 'You';
        const member = groupMembers.find(m => m.user_id === expense.payer_id);
        return member?.full_name || 'Unknown';
    };

    const getAllParticipants = (): Participant[] => {
        const participants: Participant[] = [];

        selectedParticipantKeys.forEach(key => {
            const [type, idStr] = key.split('_');
            const id = parseInt(idStr);

            if (type === 'guest') {
                const guest = groupGuests.find(g => g.id === id);
                if (guest) {
                    participants.push({ id: guest.id, name: guest.name, isGuest: true });
                }
            } else if (type === 'expenseguest') {
                // For expense guests (non-group expenses)
                const expenseGuest = expense?.expense_guests?.find(eg => eg.id === id);
                if (expenseGuest) {
                    participants.push({ id: expenseGuest.id, name: expenseGuest.name, isGuest: false, isExpenseGuest: true });
                }
            } else {
                const member = groupMembers.find(m => m.user_id === id);
                if (member) {
                    participants.push({
                        id: member.user_id,
                        name: member.user_id === currentUserId ? 'You' : member.full_name,
                        isGuest: false
                    });
                }
            }
        });

        return participants;
    };

    const getPotentialPayers = (): Participant[] => {
        // If we have group members, return all available participants (sorted)
        if (groupMembers.length > 0 || groupGuests.length > 0) {
            return getAvailableParticipants();
        }

        // Otherwise (friend expense), only return selected participants
        // (Though in this app version, maybe we only have group expenses or friend expenses behave effectively as groups of 2. 
        //  The logic in AddExpenseModal was stricter for friends, so let's stick to valid logic.)
        return getAllParticipants().sort((a, b) => {
            if (a.name === 'You') return -1;
            if (b.name === 'You') return 1;
            return a.name.localeCompare(b.name);
        });
    };

    const getParticipantName = (p: Participant): string => {
        return getParticipantNameUtil(p, currentUserId);
    };

    const toggleParticipant = (key: string) => {
        if (selectedParticipantKeys.includes(key)) {
            setSelectedParticipantKeys(selectedParticipantKeys.filter(k => k !== key));
        } else {
            setSelectedParticipantKeys([...selectedParticipantKeys, key]);
        }
    };

    const getAvailableParticipants = (): Participant[] => {
        const participants: Participant[] = [];

        groupMembers.forEach(m => {
            participants.push({
                id: m.user_id,
                name: m.user_id === currentUserId ? 'You' : m.full_name,
                isGuest: false
            });
        });

        groupGuests.forEach(g => {
            participants.push({
                id: g.id,
                name: g.name,
                isGuest: true
            });
        });

        // Include expense guests for non-group expenses
        if (expense?.expense_guests) {
            expense.expense_guests.forEach(eg => {
                participants.push({
                    id: eg.id,
                    name: eg.name,
                    isGuest: false,
                    isExpenseGuest: true
                });
            });
        }

        // Sort: "You" first, then alphabetically
        return participants.sort((a, b) => {
            if (a.name === 'You') return -1;
            if (b.name === 'You') return 1;
            return a.name.localeCompare(b.name);
        });
    };

    const handleMainParticipantSelectorConfirm = (selectedParticipants: Participant[]) => {
        const keys = selectedParticipants.map(p => {
            if (p.isExpenseGuest) {
                return `expenseguest_${p.id}`;
            }
            return p.isGuest ? `guest_${p.id}` : `user_${p.id}`;
        });
        setSelectedParticipantKeys(keys);
        setShowParticipantSelector(false);
    };

    const handleParticipantSelectorConfirm = (itemIdx: number, selectedParticipants: Participant[]) => {
        itemizedExpense.updateItemAssignments(itemIdx, selectedParticipants.map(p => {
            if (p.isExpenseGuest) {
                return {
                    user_id: p.id,
                    is_guest: false,
                    expense_guest_id: p.id
                };
            }
            return {
                user_id: p.id,
                is_guest: p.isGuest
            };
        }));
        itemizedExpense.setEditingItemIndex(null);
    };

    const getSelectedParticipantsDisplay = (): string => {
        const total = selectedParticipantKeys.length;
        if (total === 0) return 'Select people';
        const participants = getAllParticipants();
        if (total === 1) {
            const p = participants[0];
            return p?.name || 'Unknown';
        }
        return `${total} people selected`;
    };

    const handleSave = async () => {
        const totalAmountCents = amountToCents(amount);
        const allParticipants = getAllParticipants();

        // Calculate splits (assembleSplitsPayload filters out expense guests internally)
        const splitResult = assembleSplitsPayload(splitType, allParticipants, splitDetails, totalAmountCents);
        if (splitResult.error) {
            setAlertDialog({
                isOpen: true,
                title: 'Invalid Split',
                message: splitResult.error,
                type: 'error'
            });
            return;
        }

        const payload: any = {
            description,
            amount: totalAmountCents,
            currency,
            date: expenseDate,
            payer_id: payerId,
            payer_is_guest: payerIsGuest,
            splits: splitResult.splits,
            split_type: splitType,
            icon: selectedIcon,
            notes,
            is_settlement: isSettlement
        };

        if (splitType === 'ITEMIZED') {
            setIsSubmitting(true);
            try {
                const { items: allItems, totalCents: itemsTotal } = assembleItemizedPayload(
                    itemizedExpense.itemizedItems,
                    itemizedExpense.taxAmount,
                    itemizedExpense.tipAmount,
                );

                const itemizedPayload: any = {
                    description,
                    amount: itemsTotal,
                    currency,
                    date: expenseDate,
                    payer_id: payerId,
                    payer_is_guest: payerIsGuest,
                    split_type: 'ITEMIZED',
                    items: allItems,
                    splits: splitResult.splits,
                    icon: selectedIcon,
                    notes,
                    is_settlement: isSettlement
                };

                const result = await offlineExpensesApi.update(expenseId!, itemizedPayload);

                if (result.success) {
                    if (result.offline) {
                        console.log('Expense updated offline and queued for sync');
                    }
                    setIsEditing(false);
                    onExpenseUpdated();
                    onClose();
                } else {
                    setAlertDialog({
                        isOpen: true,
                        title: 'Error',
                        message: 'Failed to update expense',
                        type: 'error'
                    });
                }
            } finally {
                setIsSubmitting(false);
            }
            return;
        }

        setIsSubmitting(true);
        try {
            const result = await offlineExpensesApi.update(expenseId!, payload);

            if (result.success) {
                if (result.offline) {
                    console.log('Expense updated offline and queued for sync');
                }
                setIsEditing(false);
                onExpenseUpdated();
                onClose();
            } else {
                setAlertDialog({
                    isOpen: true,
                    title: 'Error',
                    message: 'Failed to update expense',
                    type: 'error'
                });
            }
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDelete = async () => {
        const result = await offlineExpensesApi.delete(expenseId!);

        if (result.success) {
            if (result.offline) {
                console.log('Expense deleted offline and queued for sync');
            }
            onExpenseDeleted();
            onClose();
        } else {
            setAlertDialog({
                isOpen: true,
                title: 'Error',
                message: 'Failed to delete expense',
                type: 'error'
            });
        }
    };

    const handleClose = () => {
        setIsEditing(false);
        setShowDeleteConfirm(false);
        setError(null);
        onClose();
    };

    const handleBackdropClick = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            handleClose();
        }
    };

    if (!isOpen) return null;

    // All group members can edit/delete expenses (not just the creator)
    const canEdit = !readOnly;

    return (
        <div
            className="fixed inset-0 bg-gray-600 dark:bg-gray-900/75 bg-opacity-50 z-40 flex items-end md:items-center justify-center"
            onClick={handleBackdropClick}
        >
            {showParticipantSelector && (
                <ParticipantSelector
                    isOpen={true}
                    onClose={() => setShowParticipantSelector(false)}
                    participants={getAvailableParticipants()}
                    selectedParticipants={getAllParticipants()}
                    onConfirm={handleMainParticipantSelectorConfirm}
                    itemDescription="Select participants for this expense"
                />
            )}
            {itemizedExpense.editingItemIndex !== null && (
                <ParticipantSelector
                    isOpen={true}
                    onClose={() => itemizedExpense.setEditingItemIndex(null)}
                    participants={getAllParticipants()}
                    selectedParticipants={getAllParticipants().filter(p => {
                        const item = itemizedExpense.itemizedItems[itemizedExpense.editingItemIndex!];
                        return item?.assignments.some(a => {
                            if (p.isExpenseGuest) {
                                return a.expense_guest_id === p.id;
                            }
                            return a.user_id === p.id && a.is_guest === p.isGuest;
                        });
                    })}
                    onConfirm={(selected) => handleParticipantSelectorConfirm(itemizedExpense.editingItemIndex!, selected)}
                    itemDescription={itemizedExpense.itemizedItems[itemizedExpense.editingItemIndex]?.description || ''}
                />
            )}
            <div className="bg-white dark:bg-gray-800 w-full md:w-[448px] max-h-[90vh] rounded-t-2xl md:rounded-2xl shadow-xl dark:shadow-gray-900/50 overflow-y-auto flex flex-col">
                {isLoading ? (
                    <div className="text-center py-8 text-gray-500 dark:text-gray-400">Loading...</div>
                ) : error ? (
                    <div className="text-center py-8">
                        <div className="text-red-500 dark:text-red-400 mb-4">{error}</div>
                        <button onClick={handleClose} className="text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300">Close</button>
                    </div>
                ) : expense ? (
                    <>
                        {/* Header */}
                        <div className="sticky top-0 bg-white dark:bg-gray-800 z-10 p-4 sm:p-5 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
                            <h2 className="text-xl font-bold dark:text-gray-100">
                                {isEditing ? 'Edit Expense' : 'Expense Details'}
                            </h2>
                            {canEdit && !isEditing && !showDeleteConfirm && (
                                <div className="flex space-x-2">
                                    <button
                                        onClick={() => setIsEditing(true)}
                                        className="text-sm bg-teal-100 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300 px-3 py-2 rounded hover:bg-teal-200 dark:hover:bg-teal-900/50 min-h-[44px]"
                                    >
                                        Edit
                                    </button>
                                    <button
                                        onClick={() => setShowDeleteConfirm(true)}
                                        className="text-sm bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 px-3 py-2 rounded hover:bg-red-200 dark:hover:bg-red-900/50 min-h-[44px]"
                                    >
                                        Delete
                                    </button>
                                </div>
                            )}
                        </div>

                        {/* Delete Confirmation */}
                        {showDeleteConfirm && (
                            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded p-4 m-4 sm:m-5">
                                <p className="text-sm text-red-800 dark:text-red-300 mb-3">
                                    Are you sure you want to delete this expense? This cannot be undone.
                                </p>
                                <div className="flex space-x-2">
                                    <button
                                        onClick={handleDelete}
                                        className="px-4 py-2 bg-red-500 text-white text-sm rounded hover:bg-red-600 min-h-[44px]"
                                    >
                                        Delete
                                    </button>
                                    <button
                                        onClick={() => setShowDeleteConfirm(false)}
                                        className="px-4 py-2 bg-gray-200 text-gray-700 text-sm rounded hover:bg-gray-300 min-h-[44px]"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        )}

                        {isEditing ? (
                            /* Edit Mode */
                            <div className="flex-1 flex flex-col">
                                <div className="flex-1 overflow-y-auto p-4 sm:p-5">
                                    <div className="mb-4">
                                        <label className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-2">Description:</label>
                                        <div className="flex items-center gap-2">
                                            <IconSelector
                                                selectedIcon={selectedIcon}
                                                onIconSelect={setSelectedIcon}
                                            />
                                            <input
                                                type="text"
                                                className="flex-1 border-b border-gray-300 dark:border-gray-600 py-2 focus:outline-none focus:border-teal-500 dark:bg-gray-800 dark:text-gray-100"
                                                value={description}
                                                onChange={e => setDescription(e.target.value)}
                                                required
                                            />
                                        </div>
                                    </div>

                                    <div className="mb-4 flex items-center space-x-2">
                                        <select
                                            value={currency}
                                            onChange={(e) => setCurrency(e.target.value)}
                                            className="border-b border-gray-300 dark:border-gray-600 py-2 focus:outline-none focus:border-teal-500 bg-transparent dark:bg-gray-700 dark:text-gray-200"
                                        >
                                            {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
                                        </select>
                                        <input
                                            type="text"
                                            inputMode="decimal"
                                            placeholder="0.00"
                                            className={`w-full border-b border-gray-300 dark:border-gray-600 py-2 focus:outline-none focus:border-teal-500 text-lg dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400 ${splitType === 'ITEMIZED' ? 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400' : ''}`}
                                            value={splitType === 'ITEMIZED' ? calculateItemizedTotal(itemizedExpense.itemizedItems, itemizedExpense.taxAmount, itemizedExpense.tipAmount) : amount}
                                            onChange={e => setAmount(e.target.value)}
                                            disabled={splitType === 'ITEMIZED'}
                                            required={splitType !== 'ITEMIZED'}
                                        />
                                    </div>

                                    <div className="mb-4">
                                        <label className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-2">Date:</label>
                                        <input
                                            type="date"
                                            className="w-full border-b border-gray-300 dark:border-gray-600 py-2 focus:outline-none focus:border-teal-500 dark:bg-gray-800 dark:text-gray-100"
                                            value={expenseDate}
                                            onChange={(e) => setExpenseDate(e.target.value)}
                                            required
                                        />
                                    </div>

                                    <div className="mb-4">
                                        <label className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-2">Notes:</label>
                                        <textarea
                                            className="w-full border rounded-lg p-2 text-sm focus:outline-none focus:border-teal-500 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-400"
                                            placeholder="Add notes (optional)"
                                            rows={2}
                                            value={notes}
                                            onChange={(e) => setNotes(e.target.value)}
                                        />
                                    </div>

                                    <div className="mb-4">
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={isSettlement}
                                                onChange={(e) => setIsSettlement(e.target.checked)}
                                                className="w-4 h-4 text-teal-600 bg-gray-100 border-gray-300 rounded focus:ring-teal-500 dark:bg-gray-700 dark:border-gray-600"
                                            />
                                            <span className="text-sm text-gray-700 dark:text-gray-300">This is a settlement (payment)</span>
                                        </label>
                                    </div>

                                    <div className="mb-4">
                                        <label className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-2">Participants:</label>
                                        {getAvailableParticipants().length > 6 ? (
                                            <button
                                                type="button"
                                                onClick={() => setShowParticipantSelector(true)}
                                                className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-600 text-left flex items-center justify-between min-h-[44px]"
                                            >
                                                <span className="text-sm">{getSelectedParticipantsDisplay()}</span>
                                                <svg className="w-5 h-5 text-gray-400 dark:text-gray-500" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" stroke="currentColor">
                                                    <path d="M9 5l7 7-7 7"></path>
                                                </svg>
                                            </button>
                                        ) : (
                                            <div className="flex flex-wrap gap-2">
                                                {groupMembers.map(member => {
                                                    const key = `user_${member.user_id}`;
                                                    return (
                                                        <button
                                                            key={key}
                                                            type="button"
                                                            onClick={() => toggleParticipant(key)}
                                                            className={`px-4 py-2 rounded-full text-sm border min-h-[44px] ${selectedParticipantKeys.includes(key) ? 'bg-teal-100 dark:bg-teal-900/30 border-teal-500 dark:border-teal-600 text-teal-700 dark:text-teal-300' : 'bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600 dark:text-gray-200'}`}
                                                        >
                                                            {member.user_id === currentUserId ? 'You' : member.full_name}
                                                        </button>
                                                    );
                                                })}
                                                {groupGuests.map(guest => {
                                                    const key = `guest_${guest.id}`;
                                                    return (
                                                        <button
                                                            key={key}
                                                            type="button"
                                                            onClick={() => toggleParticipant(key)}
                                                            className={`px-4 py-2 rounded-full text-sm border min-h-[44px] ${selectedParticipantKeys.includes(key) ? 'bg-orange-100 dark:bg-orange-900/30 border-orange-500 dark:border-orange-600 text-orange-700 dark:text-orange-300' : 'bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600 dark:text-gray-200'}`}
                                                        >
                                                            {guest.name}
                                                        </button>
                                                    );
                                                })}
                                                {expense?.expense_guests?.map(expenseGuest => {
                                                    const key = `expenseguest_${expenseGuest.id}`;
                                                    return (
                                                        <button
                                                            key={key}
                                                            type="button"
                                                            onClick={() => toggleParticipant(key)}
                                                            className={`px-4 py-2 rounded-full text-sm border min-h-[44px] ${selectedParticipantKeys.includes(key) ? 'bg-purple-100 dark:bg-purple-900/30 border-purple-500 dark:border-purple-600 text-purple-700 dark:text-purple-300' : 'bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600 dark:text-gray-200'}`}
                                                        >
                                                            {expenseGuest.name}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>

                                    {getPotentialPayers().length > 1 && (
                                        <div className="mb-4">
                                            <label className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-2">Paid by:</label>
                                            <select
                                                value={payerIsGuest ? `guest_${payerId}` : `user_${payerId}`}
                                                onChange={(e) => {
                                                    const [type, id] = e.target.value.split('_');
                                                    setPayerId(parseInt(id));
                                                    setPayerIsGuest(type === 'guest');
                                                }}
                                                className="w-full border-b border-gray-300 dark:border-gray-600 py-2 focus:outline-none focus:border-teal-500 bg-white dark:bg-gray-700 dark:text-gray-100"
                                            >
                                                {getPotentialPayers().map(p => (
                                                    <option key={p.isGuest ? `guest_${p.id}` : `user_${p.id}`} value={p.isGuest ? `guest_${p.id}` : `user_${p.id}`}>
                                                        {p.name}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                    )}

                                    <div className="mb-4">
                                        <label className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-2">Split by:</label>
                                        <ExpenseSplitTypeSelector value={splitType} onChange={setSplitType} />

                                        {splitType === 'ITEMIZED' && (
                                            <div className="bg-gray-50 dark:bg-gray-700 p-3 rounded">
                                                <div className="flex justify-between items-center mb-3">
                                                    <p className="font-semibold text-sm dark:text-gray-100">Assign Items</p>
                                                    <button
                                                        type="button"
                                                        onClick={itemizedExpense.openAddItemModal}
                                                        className="text-sm text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 px-3 py-2 min-h-[44px]"
                                                    >
                                                        + Add Item
                                                    </button>
                                                </div>

                                                <ExpenseItemList
                                                    items={itemizedExpense.itemizedItems}
                                                    participants={getAllParticipants()}
                                                    onToggleAssignment={itemizedExpense.toggleItemAssignment}
                                                    onRemoveItem={itemizedExpense.removeItem}
                                                    onOpenSelector={itemizedExpense.setEditingItemIndex}
                                                    getParticipantName={getParticipantName}
                                                    currentUserId={currentUserId}
                                                />

                                                <div className="mt-3 pt-3 border-t dark:border-gray-600 space-y-3">
                                                    {/* Tax Input */}
                                                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                                                        <span className="text-sm text-gray-600 dark:text-gray-400">Tax (split proportionally)</span>
                                                        <div className="flex items-center">
                                                            <span className="text-sm mr-2 dark:text-gray-300">{currency}</span>
                                                            <input
                                                                type="text"
                                                                inputMode="decimal"
                                                                placeholder="0.00"
                                                                step="0.01"
                                                                className="w-28 sm:w-24 border dark:border-gray-600 rounded p-2 text-sm text-right min-h-[44px] dark:bg-gray-800 dark:text-gray-100"
                                                                value={itemizedExpense.taxAmount}
                                                                onChange={(e) => itemizedExpense.setTaxAmount(e.target.value)}
                                                            />
                                                        </div>
                                                    </div>

                                                    {/* Tip Input with percentage buttons */}
                                                    <div className="flex flex-col gap-2">
                                                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                                                            <span className="text-sm text-gray-600 dark:text-gray-400">Tip (split proportionally)</span>
                                                            <div className="flex items-center">
                                                                <span className="text-sm mr-2 dark:text-gray-300">{currency}</span>
                                                                <input
                                                                    type="text"
                                                                    inputMode="decimal"
                                                                    placeholder="0.00"
                                                                    step="0.01"
                                                                    className="w-28 sm:w-24 border dark:border-gray-600 rounded p-2 text-sm text-right min-h-[44px] dark:bg-gray-800 dark:text-gray-100"
                                                                    value={itemizedExpense.tipAmount}
                                                                    onChange={(e) => itemizedExpense.setTipAmount(e.target.value)}
                                                                />
                                                            </div>
                                                        </div>
                                                        <div className="flex gap-2 justify-end">
                                                            {[15, 18, 20].map(percent => (
                                                                <button
                                                                    key={percent}
                                                                    type="button"
                                                                    onClick={() => itemizedExpense.setTipFromPercentage(percent)}
                                                                    className="px-3 py-1 text-xs bg-teal-100 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300 rounded hover:bg-teal-200 dark:hover:bg-teal-900/50 transition-colors"
                                                                >
                                                                    {percent}%
                                                                </button>
                                                            ))}
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="mt-3 text-right text-base font-semibold dark:text-white">
                                                    Total: {currency} {calculateItemizedTotal(itemizedExpense.itemizedItems, itemizedExpense.taxAmount, itemizedExpense.tipAmount)}
                                                </div>
                                            </div>
                                        )}

                                        {splitType !== 'EQUAL' && splitType !== 'ITEMIZED' && (
                                            <SplitDetailsInput
                                                splitType={splitType}
                                                participants={getAllParticipants()}
                                                splitDetails={splitDetails}
                                                onChange={handleSplitDetailChange}
                                                currency={currency}
                                                getParticipantName={getParticipantName}
                                            />
                                        )}
                                    </div>
                                </div>

                                <div className="sticky bottom-0 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 p-4 sm:p-5 flex justify-end space-x-3">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setIsEditing(false);
                                            if (expense) populateFormFromExpense(expense);
                                        }}
                                        className="px-4 py-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded min-h-[44px]"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleSave}
                                        disabled={isSubmitting}
                                        className="px-4 py-2 bg-teal-500 text-white rounded hover:bg-teal-600 min-h-[44px] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                                    >
                                        {isSubmitting ? (
                                            <>
                                                <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                                </svg>
                                                Saving...
                                            </>
                                        ) : 'Save'}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            /* View Mode */
                            <div className="flex-1 flex flex-col">
                                <div className="flex-1 overflow-y-auto p-4 sm:p-5">
                                    <div className="mb-6">
                                        <div className="flex items-center gap-3 mb-1">
                                            {expense.icon && (
                                                <span className="text-3xl">{expense.icon}</span>
                                            )}
                                            <h3 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{expense.description}</h3>
                                        </div>
                                        <p className="text-3xl font-bold text-gray-900 dark:text-gray-100">
                                            {formatMoney(expense.amount, expense.currency)}
                                        </p>
                                    </div>

                                    <div className="space-y-3 mb-6">
                                        <div className="flex justify-between text-sm">
                                            <span className="text-gray-500 dark:text-gray-400">Date</span>
                                            <span className="text-gray-900 dark:text-gray-100">{formatDate(expense.date)}</span>
                                        </div>
                                        <div className="flex justify-between text-sm">
                                            <span className="text-gray-500 dark:text-gray-400">Paid by</span>
                                            <span className="text-gray-900 dark:text-gray-100">{getPayerName()}</span>
                                        </div>
                                        <div className="flex justify-between text-sm">
                                            <span className="text-gray-500 dark:text-gray-400">Split type</span>
                                            <span className="text-gray-900 dark:text-gray-100">{expense.split_type}</span>
                                        </div>
                                        {groupDefaultCurrency && expense.currency !== groupDefaultCurrency && expense.exchange_rate && (
                                            <div className="flex justify-between text-sm">
                                                <div className="flex items-center gap-1">
                                                    <span className="text-gray-500 dark:text-gray-400">Exchange Rate</span>
                                                    <button
                                                        onClick={() => setShowExchangeRateInfo(true)}
                                                        className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                                                    >
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                        </svg>
                                                    </button>

                                                    {/* Exchange Rate Info Modal */}
                                                    {showExchangeRateInfo && (
                                                        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowExchangeRateInfo(false)}>
                                                            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl max-w-sm w-full p-6" onClick={e => e.stopPropagation()}>
                                                                <div className="flex items-center gap-3 mb-4">
                                                                    <div className="w-10 h-10 rounded-full bg-teal-100 dark:bg-teal-900/30 flex items-center justify-center">
                                                                        <svg className="w-5 h-5 text-teal-600 dark:text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                                        </svg>
                                                                    </div>
                                                                    <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Exchange Rate</h3>
                                                                </div>
                                                                <p className="text-gray-600 dark:text-gray-300 text-sm leading-relaxed mb-6">
                                                                    This exchange rate was captured at the time of the expense and is used to normalize amounts when calculating balances and simplifying debts between different currencies.
                                                                </p>
                                                                <button
                                                                    onClick={() => setShowExchangeRateInfo(false)}
                                                                    className="w-full py-3 bg-teal-500 hover:bg-teal-600 text-white font-medium rounded-xl transition-colors"
                                                                >
                                                                    Got it
                                                                </button>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                                <span className="text-gray-900 dark:text-gray-100">1 {expense.currency} = {expense.exchange_rate} {expense.exchange_rate_target_currency || 'USD'}</span>
                                            </div>
                                        )}
                                    </div>

                                    {expense.notes && (
                                        <div className="mb-6 bg-gray-50 dark:bg-gray-700/50 p-3 rounded-lg">
                                            <h4 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Notes</h4>
                                            <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{expense.notes}</p>
                                        </div>
                                    )}

                                    {/* Itemized breakdown for ITEMIZED expenses */}
                                    {expense.split_type === 'ITEMIZED' && expense.items && expense.items.length > 0 && (
                                        <div className="border-t dark:border-gray-700 pt-4 mb-4">
                                            <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">Items</h4>
                                            <div className="space-y-2">
                                                {expense.items.filter(i => !i.is_tax_tip).map(item => (
                                                    <div key={item.id} className="flex justify-between items-start text-sm">
                                                        <div>
                                                            <span className="text-gray-700 dark:text-gray-300">{item.description}</span>
                                                            <div className={`text-xs ${item.assignments.length === 0 ? 'text-orange-600 dark:text-orange-400 font-medium' : 'text-gray-500 dark:text-gray-400'}`}>
                                                                {item.assignments.length === 0
                                                                    ? '⚠️ Unclaimed'
                                                                    : item.assignments.map(a => a.user_name).join(', ')
                                                                }
                                                            </div>
                                                        </div>
                                                        <span className="text-gray-600 dark:text-gray-400">
                                                            {formatMoney(item.price, expense.currency)}
                                                        </span>
                                                    </div>
                                                ))}
                                                {expense.items.filter(i => i.is_tax_tip).map(item => (
                                                    <div key={item.id} className="flex justify-between text-sm text-gray-500 dark:text-gray-400 italic">
                                                        <span>{item.description}</span>
                                                        <span>{formatMoney(item.price, expense.currency)}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}


                                    {/* Receipt Image */}
                                    {expense.receipt_image_path && (
                                        <div className="border-t dark:border-gray-700 pt-4 mb-4">
                                            <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">Receipt</h4>
                                            <a
                                                href={getApiUrl(expense.receipt_image_path.replace(/^\//, ''))}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center text-sm text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300"
                                            >
                                                <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                                </svg>
                                                View Receipt Image
                                            </a>
                                        </div>
                                    )}

                                    <div className="border-t dark:border-gray-700 pt-4">
                                        <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">Split Breakdown</h4>
                                        <div className="space-y-4">
                                            {[...expense.splits].sort((a, b) => {
                                                const aName = a.user_id === currentUserId && !a.is_guest ? 'You' : a.user_name;
                                                const bName = b.user_id === currentUserId && !b.is_guest ? 'You' : b.user_name;
                                                if (aName === 'You') return -1;
                                                if (bName === 'You') return 1;
                                                return aName.localeCompare(bName);
                                            }).map(split => {
                                                const displayName = split.user_id === currentUserId && !split.is_guest ? 'You' : split.user_name;

                                                // For itemized expenses, calculate the breakdown
                                                if (expense.split_type === 'ITEMIZED' && expense.items && expense.items.length > 0) {
                                                    // Get regular items assigned to this person
                                                    const regularItems = expense.items.filter(i => !i.is_tax_tip);
                                                    const taxItems = expense.items.filter(i => i.is_tax_tip && i.description.toLowerCase().includes('tax') && !i.description.toLowerCase().includes('tip'));
                                                    const tipItems = expense.items.filter(i => i.is_tax_tip && i.description.toLowerCase().includes('tip') && !i.description.toLowerCase().includes('tax'));
                                                    const combinedItems = expense.items.filter(i => i.is_tax_tip && i.description.toLowerCase() === 'tax/tip');

                                                    // Calculate subtotal for this person's items
                                                    let personSubtotal = 0;
                                                    regularItems.forEach(item => {
                                                        const isAssigned = item.assignments.some(
                                                            a => a.user_id === split.user_id && a.is_guest === split.is_guest
                                                        );
                                                        if (isAssigned) {
                                                            // Check if item has custom split type
                                                            const itemSplitType = (item as any).split_type || 'EQUAL';
                                                            const itemSplitDetails = (item as any).split_details || {};
                                                            const personKey = split.is_guest ? `guest_${split.user_id}` : `user_${split.user_id}`;

                                                            if (itemSplitType === 'EQUAL' || item.assignments.length === 1) {
                                                                // Equal split or single assignee
                                                                const shareCount = item.assignments.length;
                                                                personSubtotal += Math.floor(item.price / shareCount);
                                                            } else if (itemSplitType === 'EXACT') {
                                                                // Use exact amount
                                                                const detail = itemSplitDetails[personKey];
                                                                const amount = detail?.amount || 0;
                                                                personSubtotal += amount;
                                                            } else if (itemSplitType === 'PERCENT') {
                                                                // Use percentage
                                                                const detail = itemSplitDetails[personKey];
                                                                const percentage = detail?.percentage || 0;
                                                                personSubtotal += Math.floor(item.price * (percentage / 100));
                                                            } else if (itemSplitType === 'SHARES') {
                                                                // Calculate based on shares
                                                                let totalShares = 0;
                                                                item.assignments.forEach((a: any) => {
                                                                    const key = a.is_guest ? `guest_${a.user_id}` : `user_${a.user_id}`;
                                                                    const detail = itemSplitDetails[key];
                                                                    totalShares += detail?.shares || 1;
                                                                });

                                                                const personShares = itemSplitDetails[personKey]?.shares || 1;
                                                                if (totalShares > 0) {
                                                                    personSubtotal += Math.floor((item.price * personShares) / totalShares);
                                                                }
                                                            }
                                                        }
                                                    });

                                                    // Calculate total subtotal of all regular items
                                                    const totalSubtotal = regularItems.reduce((sum, item) => sum + item.price, 0);

                                                    // Calculate person's share percentage of the total
                                                    const sharePercent = totalSubtotal > 0 ? (personSubtotal / totalSubtotal) * 100 : 0;

                                                    // Calculate tax and tip amounts
                                                    const totalTax = taxItems.reduce((sum, i) => sum + i.price, 0) + combinedItems.reduce((sum, i) => sum + i.price, 0);
                                                    const totalTip = tipItems.reduce((sum, i) => sum + i.price, 0);

                                                    const personTax = totalSubtotal > 0 ? Math.round(totalTax * (personSubtotal / totalSubtotal)) : 0;
                                                    const personTip = totalSubtotal > 0 ? Math.round(totalTip * (personSubtotal / totalSubtotal)) : 0;

                                                    return (
                                                        <div key={split.id} className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                                                            <div className="flex justify-between items-center mb-2">
                                                                <span className="font-medium text-gray-900 dark:text-gray-100">
                                                                    {displayName}
                                                                </span>
                                                                <span className="text-gray-900 dark:text-gray-100 font-bold">
                                                                    {formatMoney(split.amount_owed, expense.currency)}
                                                                </span>
                                                            </div>
                                                            <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1 pl-2 border-l-2 border-gray-200 dark:border-gray-600">
                                                                <div className="flex justify-between">
                                                                    <span>Items subtotal</span>
                                                                    <span>{formatMoney(personSubtotal, expense.currency)}</span>
                                                                </div>
                                                                {totalTax > 0 && (
                                                                    <div className="flex justify-between">
                                                                        <span>+ Tax ({sharePercent.toFixed(1)}% share)</span>
                                                                        <span>{formatMoney(personTax, expense.currency)}</span>
                                                                    </div>
                                                                )}
                                                                {totalTip > 0 && (
                                                                    <div className="flex justify-between">
                                                                        <span>+ Tip ({sharePercent.toFixed(1)}% share)</span>
                                                                        <span>{formatMoney(personTip, expense.currency)}</span>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                    );
                                                }

                                                // For non-itemized expenses, show simple display
                                                return (
                                                    <div key={split.id} className="flex justify-between items-center text-sm">
                                                        <span className="text-gray-700 dark:text-gray-300">
                                                            {displayName}
                                                        </span>
                                                        <span className="text-gray-900 dark:text-gray-100 font-medium">
                                                            {formatMoney(split.amount_owed, expense.currency)}
                                                        </span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>

                                    {/* Quick Settle Section - Only for non-group expenses with expense guests */}
                                    {expense.expense_guests && expense.expense_guests.length > 0 && (
                                        <div className="border-t dark:border-gray-700 pt-4 mt-4">
                                            <div className="flex justify-between items-center mb-3">
                                                <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300">Quick Settle</h4>
                                                <span className={`text-xs px-2 py-1 rounded-full ${
                                                    expense.expense_guests.filter(g => g.paid).length === expense.expense_guests.length
                                                        ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                                                        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                                                }`}>
                                                    {expense.expense_guests.filter(g => g.paid).length}/{expense.expense_guests.length} paid
                                                </span>
                                            </div>
                                            <div className="space-y-2">
                                                {expense.expense_guests.map(guest => (
                                                    <div
                                                        key={guest.id}
                                                        className={`flex items-center justify-between p-3 rounded-lg transition-colors ${
                                                            guest.paid
                                                                ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
                                                                : 'bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600'
                                                        }`}
                                                    >
                                                        <label className="flex items-center gap-3 cursor-pointer flex-1">
                                                            <input
                                                                type="checkbox"
                                                                checked={guest.paid}
                                                                disabled={settlingGuestId === guest.id || readOnly}
                                                                onChange={() => toggleExpenseGuestPaid(guest.id, !guest.paid)}
                                                                className="w-5 h-5 text-green-600 bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 rounded focus:ring-green-500 disabled:opacity-50"
                                                            />
                                                            <span className={`font-medium ${
                                                                guest.paid
                                                                    ? 'text-green-700 dark:text-green-300'
                                                                    : 'text-gray-900 dark:text-gray-100'
                                                            }`}>
                                                                {guest.name}
                                                            </span>
                                                        </label>
                                                        <div className="flex items-center gap-2">
                                                            <span className={`font-medium ${
                                                                guest.paid
                                                                    ? 'text-green-600 dark:text-green-400'
                                                                    : 'text-gray-900 dark:text-gray-100'
                                                            }`}>
                                                                {formatMoney(guest.amount_owed, expense.currency)}
                                                            </span>
                                                            {guest.paid && (
                                                                <svg className="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                                                </svg>
                                                            )}
                                                            {settlingGuestId === guest.id && (
                                                                <svg className="w-5 h-5 text-gray-400 animate-spin" fill="none" viewBox="0 0 24 24">
                                                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                                                </svg>
                                                            )}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div className="sticky bottom-0 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 p-4 sm:p-5 flex justify-end">
                                    <button
                                        type="button"
                                        onClick={handleClose}
                                        className="px-4 py-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded min-h-[44px]"
                                    >
                                        Close
                                    </button>
                                </div>
                            </div>
                        )}
                    </>
                ) : null}

                {/* Add Item Modal */}
                <AddItemModal
                    isOpen={itemizedExpense.showAddItemModal}
                    onClose={itemizedExpense.closeAddItemModal}
                    onAdd={itemizedExpense.addManualItem}
                />

                {/* Alert Dialog */}
                <AlertDialog
                    isOpen={alertDialog.isOpen}
                    onClose={() => setAlertDialog({ ...alertDialog, isOpen: false })}
                    onConfirm={alertDialog.onConfirm}
                    title={alertDialog.title}
                    message={alertDialog.message}
                    type={alertDialog.type}
                />
            </div>
        </div>
    );
};

export default ExpenseDetailModal;

import React, { useState, useEffect } from 'react';
import { useAuth } from './AuthContext';
import ReceiptScanner from './ReceiptScanner';
import ParticipantSelector from './ParticipantSelector';
import ExpenseSplitTypeSelector from './components/expense/ExpenseSplitTypeSelector';
import ExpenseItemList from './components/expense/ExpenseItemList';
import SplitDetailsInput from './components/expense/SplitDetailsInput';
import IconSelector from './components/expense/IconSelector';
import AddItemModal from './components/AddItemModal';
import AlertDialog from './components/AlertDialog';
import { useItemizedExpense } from './hooks/useItemizedExpense';
import { useSplitDetails } from './hooks/useSplitDetails';
import { useCurrencyPreferences } from './hooks/useCurrencyPreferences';
import type {
    Friend,
    Group,
    Participant,
    SplitType,
    ExpenseGuestCreate
} from './types/expense';
import {
    getParticipantName as getParticipantNameUtil
} from './utils/participantHelpers';
import {
    calculateEqualSplit,
    calculateExactSplit,
    calculatePercentSplit,
    calculateSharesSplit,
    calculateItemizedTotal
} from './utils/expenseCalculations';
import { formatDateForInput } from './utils/formatters';
import { formatCurrencyDisplay } from './utils/currencyHelpers';
import { offlineExpensesApi } from './services/offlineApi';
import { useSync } from './contexts/SyncContext';

interface AddExpenseModalProps {
    isOpen: boolean;
    onClose: () => void;
    onExpenseAdded: () => void;
    friends: Friend[];
    groups?: Group[];
    preselectedGroupId?: number | null;
    preselectedFriendId?: number | null;
}

const AddExpenseModal: React.FC<AddExpenseModalProps> = ({
    isOpen,
    onClose,
    onExpenseAdded,
    friends,
    groups = [],
    preselectedGroupId = null,
    preselectedFriendId = null
}) => {
    const { user } = useAuth();
    const { isOnline: _isOnline } = useSync();
    const { sortedCurrencies, recordCurrencyUsage } = useCurrencyPreferences();
    const [description, setDescription] = useState('');
    const [amount, setAmount] = useState('');
    const [currency, setCurrency] = useState('USD');
    const [selectedFriendIds, setSelectedFriendIds] = useState<number[]>([]);
    const [selectedGuestIds, setSelectedGuestIds] = useState<number[]>([]);
    const [currentUserSelected, setCurrentUserSelected] = useState<boolean>(true);
    const [selectedGroupId, setSelectedGroupId] = useState<number | null>(preselectedGroupId);
    const [splitType, setSplitType] = useState<SplitType>('EQUAL');
    const [showScanner, setShowScanner] = useState(false);
    const [scannedItems, setScannedItems] = useState<{ description: string, price: number }[]>([]);
    const [ocrValidationWarning, setOcrValidationWarning] = useState<string | null>(null);
    const [expenseDate, setExpenseDate] = useState<string>(formatDateForInput());
    const [showParticipantSelector, setShowParticipantSelector] = useState(false);
    const [receiptImagePath, setReceiptImagePath] = useState<string | null>(null);
    const [payerId, setPayerId] = useState<number>(user?.id || 0);
    const [payerIsGuest, setPayerIsGuest] = useState<boolean>(false);
    const [selectedIcon, setSelectedIcon] = useState<string | null>(null);
    const [notes, setNotes] = useState('');
    const [isSettlement, setIsSettlement] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
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

    // Expense guests state (for non-group expenses only)
    const [expenseGuests, setExpenseGuests] = useState<ExpenseGuestCreate[]>([]);
    const [newGuestName, setNewGuestName] = useState('');
    const [payerIsExpenseGuest, setPayerIsExpenseGuest] = useState(false);
    const [payerTempGuestId, setPayerTempGuestId] = useState<string | null>(null);

    // Generate unique temp ID for expense guests
    const generateTempId = () => {
        return `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    };

    // Add expense guest
    const addExpenseGuest = () => {
        if (!newGuestName.trim()) return;
        const tempId = generateTempId();
        setExpenseGuests([...expenseGuests, { temp_id: tempId, name: newGuestName.trim() }]);
        setNewGuestName('');
    };

    // Remove expense guest
    const removeExpenseGuest = (tempId: string) => {
        setExpenseGuests(expenseGuests.filter(g => g.temp_id !== tempId));
        // Also remove from item assignments if itemized
        if (splitType === 'ITEMIZED') {
            itemizedExpense.setItemizedItems(prev =>
                prev.map(item => ({
                    ...item,
                    assignments: item.assignments.filter(a => a.temp_guest_id !== tempId)
                }))
            );
        }
        // Reset payer if they were this guest
        if (payerIsExpenseGuest && payerTempGuestId === tempId) {
            setPayerId(user?.id || 0);
            setPayerIsGuest(false);
            setPayerIsExpenseGuest(false);
            setPayerTempGuestId(null);
        }
        // Remove split details for this guest
        removeSplitDetail(`expense_guest_${tempId}`);
    };

    // Use custom hooks
    const itemizedExpense = useItemizedExpense();
    const { splitDetails, handleSplitDetailChange, removeSplitDetail, setSplitDetails } = useSplitDetails();

    const selectedGroup = groups.find(g => g.id === selectedGroupId);
    const groupGuests = selectedGroup?.guests || [];

    useEffect(() => {
        if (selectedGroup?.default_currency) {
            setCurrency(selectedGroup.default_currency);
        }
    }, [selectedGroup]);

    const resetForm = () => {
        setDescription('');
        setAmount('');
        setSelectedFriendIds(preselectedFriendId ? [preselectedFriendId] : []);
        setSelectedGuestIds([]);
        setCurrentUserSelected(true);
        setSelectedGroupId(preselectedGroupId);

        // Reset currency to preselected group's default or USD
        const defaultGroup = groups.find(g => g.id === preselectedGroupId);
        setCurrency(defaultGroup?.default_currency || 'USD');

        setPayerId(user?.id || 0);
        setPayerIsGuest(false);
        setPayerIsExpenseGuest(false);
        setPayerTempGuestId(null);
        setExpenseDate(formatDateForInput());
        setSplitType('EQUAL');
        setScannedItems([]);
        setOcrValidationWarning(null);
        setSelectedIcon(null);
        setReceiptImagePath(null);
        setNotes('');
        setIsSettlement(false);
        setExpenseGuests([]);
        setNewGuestName('');
        itemizedExpense.setItemizedItems([]);
        itemizedExpense.setTaxAmount('');
        itemizedExpense.setTipAmount('');
        setSplitDetails({});
    };

    // Reset form when modal opens
    useEffect(() => {
        if (isOpen) {
            resetForm();
        }
    }, [isOpen, preselectedGroupId, preselectedFriendId, user?.id]);

    const handleScannedItems = (items: { description: string, price: number }[], receiptPath?: string, validationWarning?: string | null, taxCents?: number | null, tipCents?: number | null, totalCents?: number | null) => {
        setScannedItems(items);
        if (receiptPath) setReceiptImagePath(receiptPath);
        setOcrValidationWarning(validationWarning || null);
        setShowScanner(false);

        const newItems = items.map(item => ({
            description: item.description,
            price: item.price,
            is_tax_tip: false,
            assignments: []
        }));

        itemizedExpense.setItemizedItems(newItems);
        itemizedExpense.setTaxAmount(taxCents != null && taxCents > 0 ? (taxCents / 100).toFixed(2) : '');
        itemizedExpense.setTipAmount(tipCents != null && tipCents > 0 ? (tipCents / 100).toFixed(2) : '');

        setSplitType('ITEMIZED');

        if (totalCents != null && totalCents > 0) {
            setAmount((totalCents / 100).toFixed(2));
        } else {
            const itemTotal = newItems.reduce((acc, item) => acc + item.price, 0);
            setAmount(((itemTotal + (taxCents ?? 0) + (tipCents ?? 0)) / 100).toFixed(2));
        }
        setDescription("Receipt Scan");
    };

    const handleBackdropClick = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            onClose();
        }
    };

    if (!isOpen) return null;

    const getAllParticipants = (): Participant[] => {
        const participants: Participant[] = [];

        // Only include current user if selected
        if (currentUserSelected) {
            participants.push({ id: user!.id, name: 'You', isGuest: false });
        }

        selectedFriendIds.forEach(fid => {
            const friend = friends.find(f => f.id === fid);
            if (friend) {
                participants.push({ id: friend.id, name: friend.full_name, isGuest: false });
            } else if (selectedGroup) {
                // Group members may not be in the friends list
                const member = selectedGroup.members?.find(m => m.user_id === fid);
                if (member) {
                    participants.push({ id: member.user_id, name: member.full_name, isGuest: false });
                }
            }
        });

        selectedGuestIds.forEach(gid => {
            const guest = groupGuests.find(g => g.id === gid);
            if (guest) {
                participants.push({ id: guest.id, name: guest.name, isGuest: true });
            }
        });

        // Include expense guests (for non-group expenses)
        if (!selectedGroupId) {
            expenseGuests.forEach(eg => {
                participants.push({
                    id: 0, // Temporary ID, will use tempId for identification
                    name: eg.name,
                    isGuest: false,
                    isExpenseGuest: true,
                    tempId: eg.temp_id
                });
            });
        }

        return participants;
    };

    const getParticipantName = (p: Participant): string => {
        return getParticipantNameUtil(p, user?.id);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        const totalAmountCents = Math.round(parseFloat(amount) * 100);
        const participants = getAllParticipants();
        let splits: any[] = [];

        // Calculate splits based on type
        if (splitType === 'EQUAL') {
            splits = calculateEqualSplit(totalAmountCents, participants);
        } else if (splitType === 'EXACT') {
            const result = calculateExactSplit(totalAmountCents, participants, splitDetails);
            if (result.error) {
                setAlertDialog({
                    isOpen: true,
                    title: 'Invalid Split',
                    message: result.error,
                    type: 'error'
                });
                return;
            }
            splits = result.splits;
        } else if (splitType === 'PERCENT') {
            const result = calculatePercentSplit(totalAmountCents, participants, splitDetails);
            if (result.error) {
                setAlertDialog({
                    isOpen: true,
                    title: 'Invalid Split',
                    message: result.error,
                    type: 'error'
                });
                return;
            }
            splits = result.splits;
        } else if (splitType === 'SHARES') {
            const result = calculateSharesSplit(totalAmountCents, participants, splitDetails);
            if (result.error) {
                setAlertDialog({
                    isOpen: true,
                    title: 'Invalid Split',
                    message: result.error,
                    type: 'error'
                });
                return;
            }
            splits = result.splits;
        }

        // Filter out expense guests from splits (they're handled separately)
        const regularSplits = splits.filter((s: any) => !s.isExpenseGuest);

        const payload: any = {
            description,
            amount: totalAmountCents,
            currency,
            date: expenseDate,
            payer_id: payerIsExpenseGuest ? 0 : payerId,
            payer_is_guest: payerIsGuest,
            payer_is_expense_guest: payerIsExpenseGuest,
            payer_temp_guest_id: payerTempGuestId,
            group_id: selectedGroupId,
            split_type: splitType,
            splits: regularSplits,
            icon: selectedIcon,
            receipt_image_path: receiptImagePath,
            notes: notes,
            is_settlement: isSettlement
        };

        // Add expense guests for non-group expenses
        if (!selectedGroupId && expenseGuests.length > 0) {
            payload.expense_guests = expenseGuests;
        }

        if (splitType === 'ITEMIZED') {
            // Build items array with tax and tip
            const allItems = [...itemizedExpense.itemizedItems];
            const tax = Math.round(parseFloat(itemizedExpense.taxAmount || '0') * 100);
            const tip = Math.round(parseFloat(itemizedExpense.tipAmount || '0') * 100);

            // Add Tax as a separate item if present
            if (tax > 0) {
                allItems.push({
                    description: 'Tax',
                    price: tax,
                    is_tax_tip: true,
                    assignments: [],
                    split_type: 'EQUAL',
                    split_details: undefined
                });
            }

            // Add Tip as a separate item if present
            if (tip > 0) {
                allItems.push({
                    description: 'Tip',
                    price: tip,
                    is_tax_tip: true,
                    assignments: [],
                    split_type: 'EQUAL',
                    split_details: undefined
                });
            }

            const itemsTotal = allItems.reduce((sum, item) => sum + item.price, 0);

            // Include all selected participants as splits (excluding expense guests - they're handled separately)
            const participantSplits = getAllParticipants()
                .filter(p => !p.isExpenseGuest)
                .map(p => ({
                    user_id: p.id,
                    is_guest: p.isGuest,
                    amount_owed: 0
                }));

            const itemizedPayload: any = {
                description,
                amount: itemsTotal,
                currency,
                date: expenseDate,
                payer_id: payerIsExpenseGuest ? 0 : payerId,
                payer_is_guest: payerIsGuest,
                payer_is_expense_guest: payerIsExpenseGuest,
                payer_temp_guest_id: payerTempGuestId,
                group_id: selectedGroupId,
                split_type: 'ITEMIZED',
                items: allItems,
                splits: participantSplits,
                icon: selectedIcon,
                receipt_image_path: receiptImagePath,
                notes: notes,
                is_settlement: isSettlement
            };

            // Add expense guests for non-group expenses
            if (!selectedGroupId && expenseGuests.length > 0) {
                itemizedPayload.expense_guests = expenseGuests;
            }

            setIsSubmitting(true);
            try {
                const result = await offlineExpensesApi.create(itemizedPayload);

                if (result.success) {
                    recordCurrencyUsage(currency);
                    if (result.offline) {
                        console.log('Expense created offline and queued for sync');
                    }
                    onExpenseAdded();
                    onClose();
                    resetForm();
                } else {
                    setAlertDialog({
                        isOpen: true,
                        title: 'Error',
                        message: 'Failed to add expense',
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
            const result = await offlineExpensesApi.create(payload);

            if (result.success) {
                // Record currency usage for sorting
                recordCurrencyUsage(currency);

                // Show feedback if created offline
                if (result.offline) {
                    console.log('Expense created offline and queued for sync');
                }

                onExpenseAdded();
                onClose();
                // Reset state
                resetForm();
            } else {
                setAlertDialog({
                    isOpen: true,
                    title: 'Error',
                    message: 'Failed to add expense',
                    type: 'error'
                });
            }
        } finally {
            setIsSubmitting(false);
        }
    };

    const toggleFriend = (id: number) => {
        if (selectedFriendIds.includes(id)) {
            setSelectedFriendIds(selectedFriendIds.filter(fid => fid !== id));
            removeSplitDetail(`user_${id}`);
        } else {
            setSelectedFriendIds([...selectedFriendIds, id]);
        }
    };

    const toggleGuest = (id: number) => {
        if (selectedGuestIds.includes(id)) {
            setSelectedGuestIds(selectedGuestIds.filter(gid => gid !== id));
            removeSplitDetail(`guest_${id}`);
        } else {
            setSelectedGuestIds([...selectedGuestIds, id]);
        }
    };

    const getAvailableParticipants = (): Participant[] => {
        const participants: Participant[] = [];
        participants.push({ id: user!.id, name: 'You', isGuest: false });

        // If a group is selected, only show group members and guests
        if (selectedGroup) {
            // Add group members (excluding current user)
            selectedGroup.members?.forEach(m => {
                if (m.user_id !== user!.id) {
                    participants.push({ id: m.user_id, name: m.full_name, isGuest: false });
                }
            });
            // Add group guests
            groupGuests.forEach(g => {
                participants.push({ id: g.id, name: g.name, isGuest: true });
            });
        } else {
            // If no group selected, show all friends
            friends.forEach(f => {
                participants.push({ id: f.id, name: f.full_name, isGuest: false });
            });
            // Also include expense guests (for non-group expenses)
            expenseGuests.forEach(eg => {
                participants.push({
                    id: 0,
                    name: eg.name,
                    isGuest: false,
                    isExpenseGuest: true,
                    tempId: eg.temp_id
                });
            });
        }

        return participants;
    };

    const getCurrentlySelectedParticipants = (): Participant[] => {
        const selected: Participant[] = [];

        // Only include current user if selected
        if (currentUserSelected) {
            selected.push({ id: user!.id, name: 'You', isGuest: false });
        }

        selectedFriendIds.forEach(fid => {
            const friend = friends.find(f => f.id === fid);
            if (friend) {
                selected.push({ id: friend.id, name: friend.full_name, isGuest: false });
            } else if (selectedGroup) {
                // Group members may not be in the friends list
                const member = selectedGroup.members?.find(m => m.user_id === fid);
                if (member) {
                    selected.push({ id: member.user_id, name: member.full_name, isGuest: false });
                }
            }
        });
        selectedGuestIds.forEach(gid => {
            const guest = groupGuests.find(g => g.id === gid);
            if (guest) {
                selected.push({ id: guest.id, name: guest.name, isGuest: true });
            }
        });
        // Include expense guests (for non-group expenses) - they're always selected when added
        if (!selectedGroupId) {
            expenseGuests.forEach(eg => {
                selected.push({
                    id: 0,
                    name: eg.name,
                    isGuest: false,
                    isExpenseGuest: true,
                    tempId: eg.temp_id
                });
            });
        }
        return selected;
    };

    const handleMainParticipantSelectorConfirm = (selectedParticipants: Participant[]) => {
        setSelectedFriendIds([]);
        setSelectedGuestIds([]);
        setCurrentUserSelected(false);

        selectedParticipants.forEach(p => {
            if (p.isGuest) {
                setSelectedGuestIds(prev => [...prev, p.id]);
            } else if (p.id === user?.id) {
                setCurrentUserSelected(true);
            } else {
                setSelectedFriendIds(prev => [...prev, p.id]);
            }
        });
        setShowParticipantSelector(false);
    };

    const handleParticipantSelectorConfirm = (itemIdx: number, selectedParticipants: Participant[]) => {
        itemizedExpense.updateItemAssignments(itemIdx, selectedParticipants.map(p => {
            if (p.isExpenseGuest && p.tempId) {
                // Expense guest - use temp_guest_id
                return {
                    user_id: undefined,
                    is_guest: false,
                    temp_guest_id: p.tempId
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
        const expenseGuestCount = selectedGroupId ? 0 : expenseGuests.length;
        const total = selectedFriendIds.length + selectedGuestIds.length + expenseGuestCount;
        const totalWithCurrentUser = total + (currentUserSelected ? 1 : 0);

        if (totalWithCurrentUser === 0) return 'Select people';

        // If only current user selected
        if (totalWithCurrentUser === 1 && currentUserSelected) return 'You';

        // If current user not selected
        if (!currentUserSelected) {
            if (total === 1) {
                const friend = friends.find(f => selectedFriendIds.includes(f.id));
                if (friend) return friend.full_name;
                const guest = groupGuests.find(g => selectedGuestIds.includes(g.id));
                if (guest) return guest.name;
                if (expenseGuests.length === 1) return expenseGuests[0].name;
            }
            return `${total} people selected`;
        }

        // If current user is selected plus others
        if (total === 1) {
            const friend = friends.find(f => selectedFriendIds.includes(f.id));
            if (friend) return `You and ${friend.full_name}`;
            const guest = groupGuests.find(g => selectedGuestIds.includes(g.id));
            if (guest) return `You and ${guest.name}`;
            if (expenseGuests.length === 1) return `You and ${expenseGuests[0].name}`;
        }
        return `You and ${total} other${total === 1 ? '' : 's'}`;
    };

    const getPotentialPayers = (): Participant[] => {
        // If a group is selected, any member/guest of the group can be the payer
        if (selectedGroup) {
            const participants = getAvailableParticipants();
            // Sort: "You" first, then alphabetically
            return participants.sort((a, b) => {
                if (a.id === user!.id && !a.isGuest) return -1;
                if (b.id === user!.id && !b.isGuest) return 1;
                return a.name.localeCompare(b.name);
            });
        }

        // For non-group expenses, include current user, friends, and expense guests
        const payers: Participant[] = [];
        payers.push({ id: user!.id, name: 'You', isGuest: false });

        const friendPayers: Participant[] = [];
        selectedFriendIds.forEach(fid => {
            const friend = friends.find(f => f.id === fid);
            if (friend) {
                friendPayers.push({ id: friend.id, name: friend.full_name, isGuest: false });
            }
        });

        // Sort friends alphabetically
        friendPayers.sort((a, b) => a.name.localeCompare(b.name));

        // Add expense guests as potential payers
        const expenseGuestPayers: Participant[] = expenseGuests.map(eg => ({
            id: 0,
            name: eg.name,
            isGuest: false,
            isExpenseGuest: true,
            tempId: eg.temp_id
        }));
        expenseGuestPayers.sort((a, b) => a.name.localeCompare(b.name));

        return [...payers, ...friendPayers, ...expenseGuestPayers];
    };

    return (
        <div
            className="fixed inset-0 bg-gray-600 dark:bg-gray-900/75 bg-opacity-50 z-40 flex items-end md:items-center justify-center"
            onClick={handleBackdropClick}
        >
            {showScanner && (
                <ReceiptScanner
                    onItemsDetected={handleScannedItems}
                    onClose={() => setShowScanner(false)}
                />
            )}
            {showParticipantSelector && (
                <ParticipantSelector
                    isOpen={true}
                    onClose={() => setShowParticipantSelector(false)}
                    participants={getAvailableParticipants()}
                    selectedParticipants={getCurrentlySelectedParticipants()}
                    onConfirm={handleMainParticipantSelectorConfirm}
                    itemDescription="Select people for this expense"
                />
            )}
            {itemizedExpense.editingItemIndex !== null && (
                <ParticipantSelector
                    isOpen={true}
                    onClose={() => itemizedExpense.setEditingItemIndex(null)}
                    participants={getAllParticipants()}
                    selectedParticipants={getAllParticipants().filter(p => {
                        const item = itemizedExpense.itemizedItems[itemizedExpense.editingItemIndex!];
                        if (!item) return false;
                        // Check for expense guest by tempId
                        if (p.isExpenseGuest && p.tempId) {
                            return item.assignments.some(a => a.temp_guest_id === p.tempId);
                        }
                        // Check for regular user or group guest
                        return item.assignments.some(a => a.user_id === p.id && a.is_guest === p.isGuest);
                    })}
                    onConfirm={(selected) => handleParticipantSelectorConfirm(itemizedExpense.editingItemIndex!, selected)}
                    itemDescription={itemizedExpense.itemizedItems[itemizedExpense.editingItemIndex]?.description || ''}
                />
            )}
            <div className="bg-white dark:bg-gray-800 w-full md:w-[448px] max-h-[90vh] rounded-t-2xl md:rounded-2xl shadow-xl dark:shadow-gray-900/50 overflow-y-auto flex flex-col">
                <div className="sticky top-0 bg-white dark:bg-gray-800 z-10 p-4 sm:p-5 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
                    <h2 className="text-xl font-bold dark:text-gray-100">Add an expense</h2>
                    <button
                        type="button"
                        onClick={() => setShowScanner(true)}
                        className="text-sm bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 px-3 py-2 rounded hover:bg-indigo-200 dark:hover:bg-indigo-900/50 min-h-[44px] flex items-center gap-2"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        Scan Receipt
                    </button>
                </div>
                <form onSubmit={handleSubmit} className="flex-1 flex flex-col">
                    <div className="flex-1 overflow-y-auto p-4 sm:p-5">
                        {scannedItems.length > 0 && (
                            <div className="mb-4 bg-gray-50 dark:bg-gray-700 p-3 rounded text-sm">
                                <p className="font-semibold mb-1 dark:text-gray-100">Scanned Items:</p>
                                <ul className="list-disc pl-4 text-gray-600 dark:text-gray-300">
                                    {scannedItems.map((item, idx) => (
                                        <li key={idx}>{item.description}: ${(item.price / 100).toFixed(2)}</li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {groups.length > 0 && (
                            <div className="mb-4">
                                <label htmlFor="group-select" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-2">Group (optional):</label>
                                <select
                                    id="group-select"
                                    value={selectedGroupId || ''}
                                    onChange={(e) => setSelectedGroupId(e.target.value ? parseInt(e.target.value) : null)}
                                    className="w-full border-b border-gray-300 dark:border-gray-600 py-2 focus:outline-none focus:border-teal-500 bg-white dark:bg-gray-700 dark:text-gray-100"
                                >
                                    <option value="">No group</option>
                                    {groups.map(g => (
                                        <option key={g.id} value={g.id}>{g.name}</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        <div className="mb-4">
                            <label htmlFor="description-input" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-2">Description:</label>
                            <div className="flex items-center gap-2">
                                <IconSelector
                                    selectedIcon={selectedIcon}
                                    onIconSelect={setSelectedIcon}
                                />
                                <input
                                    id="description-input"
                                    type="text"
                                    placeholder="Enter a description"
                                    className="flex-1 border-b border-gray-300 dark:border-gray-600 py-2 focus:outline-none focus:border-teal-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400"
                                    value={description}
                                    onChange={e => setDescription(e.target.value)}
                                    required
                                />
                            </div>
                        </div>

                        <div className="mb-4 flex items-center space-x-2">
                            <select
                                aria-label="Currency"
                                value={currency}
                                onChange={(e) => setCurrency(e.target.value)}
                                className="border-b border-gray-300 dark:border-gray-600 py-2 focus:outline-none focus:border-teal-500 bg-transparent text-gray-700 dark:text-gray-200 dark:bg-gray-700"
                            >
                                {sortedCurrencies.map(c => (
                                    <option key={c.code} value={c.code}>
                                        {formatCurrencyDisplay(c.code)}
                                    </option>
                                ))}
                            </select>
                            <input
                                aria-label="Amount"
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
                            <label htmlFor="date-input" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-2">Date:</label>
                            <input
                                id="date-input"
                                type="date"
                                className="w-full border-b border-gray-300 dark:border-gray-600 py-2 focus:outline-none focus:border-teal-500 dark:bg-gray-800 dark:text-gray-100"
                                value={expenseDate}
                                onChange={(e) => setExpenseDate(e.target.value)}
                                required
                            />
                        </div>

                        <div className="mb-4">
                            <label htmlFor="notes-input" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-2">Notes:</label>
                            <textarea
                                id="notes-input"
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
                            {getAvailableParticipants().length === 1 ? (
                                <div className="text-sm text-gray-500 dark:text-gray-400 italic py-2">
                                    {selectedGroup ? 'No other members in this group' : 'Add friends or select a group with members to split expenses'}
                                </div>
                            ) : getAvailableParticipants().length > 6 ? (
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
                                    {getAvailableParticipants()
                                        .filter(p => !p.isExpenseGuest) // Expense guests shown separately
                                        .sort((a, b) => {
                                            // "You" always first
                                            if (a.name === 'You') return -1;
                                            if (b.name === 'You') return 1;
                                            return a.name.localeCompare(b.name);
                                        })
                                        .map(participant => {
                                            const key = participant.isGuest ? `guest-${participant.id}` : `friend-${participant.id}`;
                                            const isCurrentUser = participant.id === user?.id && !participant.isGuest;
                                            const isSelected = isCurrentUser
                                                ? currentUserSelected
                                                : participant.isGuest
                                                    ? selectedGuestIds.includes(participant.id)
                                                    : selectedFriendIds.includes(participant.id);
                                            const toggleFn = isCurrentUser
                                                ? () => setCurrentUserSelected(!currentUserSelected)
                                                : participant.isGuest
                                                    ? () => toggleGuest(participant.id)
                                                    : () => toggleFriend(participant.id);

                                            return (
                                                <button
                                                    key={key}
                                                    type="button"
                                                    onClick={toggleFn}
                                                    aria-pressed={isSelected}
                                                    className={`px-4 py-2 rounded-full text-sm border min-h-[44px] transition-all duration-200 ${isSelected
                                                        ? participant.isGuest
                                                            ? 'bg-orange-100 dark:bg-orange-900/30 border-orange-500 dark:border-orange-600 text-orange-700 dark:text-orange-300'
                                                            : 'bg-teal-100 dark:bg-teal-900/30 border-teal-500 dark:border-teal-600 text-teal-700 dark:text-teal-300'
                                                        : 'bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600 dark:text-gray-200'
                                                        }`}
                                                >
                                                    {participant.name}
                                                </button>
                                            );
                                        })}
                                </div>
                            )}
                        </div>

                        {/* Expense Guests Section - Only for non-group expenses */}
                        {!selectedGroupId && (
                            <div className="mb-4">
                                <label className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-2">
                                    Add Guests
                                    <span className="font-normal text-gray-500 dark:text-gray-400 ml-1">(people not on Splitwiser)</span>
                                </label>

                                {/* Guest input */}
                                <div className="flex gap-2 mb-2">
                                    <input
                                        type="text"
                                        placeholder="Guest name"
                                        value={newGuestName}
                                        onChange={(e) => setNewGuestName(e.target.value)}
                                        onKeyPress={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault();
                                                addExpenseGuest();
                                            }
                                        }}
                                        className="flex-1 border-b border-gray-300 dark:border-gray-600 py-2 focus:outline-none focus:border-teal-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400"
                                    />
                                    <button
                                        type="button"
                                        onClick={addExpenseGuest}
                                        disabled={!newGuestName.trim()}
                                        className="px-4 py-2 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded hover:bg-purple-200 dark:hover:bg-purple-900/50 disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px]"
                                    >
                                        Add
                                    </button>
                                </div>

                                {/* List of added expense guests */}
                                {expenseGuests.length > 0 && (
                                    <div className="flex flex-wrap gap-2">
                                        {expenseGuests.map(guest => (
                                            <div
                                                key={guest.temp_id}
                                                className="flex items-center gap-1 px-3 py-2 bg-purple-100 dark:bg-purple-900/30 border border-purple-500 dark:border-purple-600 text-purple-700 dark:text-purple-300 rounded-full text-sm"
                                            >
                                                <span>{guest.name}</span>
                                                <button
                                                    type="button"
                                                    onClick={() => removeExpenseGuest(guest.temp_id)}
                                                    className="ml-1 text-purple-500 hover:text-purple-700 dark:hover:text-purple-200"
                                                    aria-label={`Remove ${guest.name}`}
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                                    </svg>
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {getPotentialPayers().length > 1 && (
                            <div className="mb-4">
                                <label htmlFor="payer-select" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-2">Paid by:</label>
                                <select
                                    id="payer-select"
                                    value={
                                        payerIsExpenseGuest && payerTempGuestId
                                            ? `expense_guest_${payerTempGuestId}`
                                            : payerIsGuest
                                                ? `guest_${payerId}`
                                                : `user_${payerId}`
                                    }
                                    onChange={(e) => {
                                        const value = e.target.value;
                                        if (value.startsWith('expense_guest_')) {
                                            const tempId = value.replace('expense_guest_', '');
                                            setPayerIsExpenseGuest(true);
                                            setPayerTempGuestId(tempId);
                                            setPayerIsGuest(false);
                                            setPayerId(0);
                                        } else {
                                            const [type, id] = value.split('_');
                                            setPayerId(parseInt(id));
                                            setPayerIsGuest(type === 'guest');
                                            setPayerIsExpenseGuest(false);
                                            setPayerTempGuestId(null);
                                        }
                                    }}
                                    className="w-full border-b border-gray-300 dark:border-gray-600 py-2 focus:outline-none focus:border-teal-500 bg-white dark:bg-gray-700 dark:text-gray-100"
                                >
                                    {getPotentialPayers().map(p => {
                                        const key = p.isExpenseGuest && p.tempId
                                            ? `expense_guest_${p.tempId}`
                                            : p.isGuest
                                                ? `guest_${p.id}`
                                                : `user_${p.id}`;
                                        return (
                                            <option key={key} value={key}>
                                                {p.name}
                                            </option>
                                        );
                                    })}
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
                                        <div className="flex gap-2">
                                            <button
                                                type="button"
                                                onClick={() => setShowScanner(true)}
                                                className="text-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 px-3 py-2 min-h-[44px]"
                                            >
                                                + Scan
                                            </button>
                                            <button
                                                type="button"
                                                onClick={itemizedExpense.openAddItemModal}
                                                className="text-sm text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 px-3 py-2 min-h-[44px]"
                                            >
                                                + Add
                                            </button>
                                        </div>
                                    </div>

                                    {/* OCR Validation Warning */}
                                    {ocrValidationWarning && (
                                        <div className="mb-3 bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-300 dark:border-yellow-700 text-yellow-800 dark:text-yellow-200 px-3 py-2 rounded-md text-sm">
                                            <div className="flex items-start gap-2">
                                                <span className="text-yellow-500 flex-shrink-0">⚠️</span>
                                                <div>
                                                    <p className="font-medium">Some items may be missing</p>
                                                    <p className="text-xs mt-1 text-yellow-700 dark:text-yellow-300">{ocrValidationWarning}</p>
                                                    <p className="text-xs mt-1 text-yellow-600 dark:text-yellow-400">Please review and add any missing items manually using the "+ Add" button.</p>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => setOcrValidationWarning(null)}
                                                    aria-label="Dismiss warning"
                                                    className="text-yellow-500 hover:text-yellow-700 dark:hover:text-yellow-300 flex-shrink-0"
                                                >
                                                    ✕
                                                </button>
                                            </div>
                                        </div>
                                    )}

                                    <ExpenseItemList
                                        items={itemizedExpense.itemizedItems}
                                        participants={getAllParticipants()}
                                        onToggleAssignment={itemizedExpense.toggleItemAssignment}
                                        onRemoveItem={itemizedExpense.removeItem}
                                        onOpenSelector={itemizedExpense.setEditingItemIndex}
                                        onChangeSplitType={itemizedExpense.changeSplitType}
                                        onUpdateSplitDetail={itemizedExpense.updateSplitDetail}
                                        getParticipantName={getParticipantName}
                                        currentUserId={user?.id}
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
                        <button type="button" onClick={onClose} disabled={isSubmitting} className="px-4 py-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded min-h-[44px] disabled:opacity-50">Cancel</button>
                        <button type="submit" disabled={isSubmitting} className="px-4 py-2 bg-teal-500 text-white rounded hover:bg-teal-600 min-h-[44px] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center">
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
                </form>

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

export default AddExpenseModal;

import React, { useState, useRef } from 'react';
import { getApiUrl } from './api';
import { useSync } from './contexts/SyncContext';
import { compressImage } from './utils/imageCompression';

interface ReceiptScannerProps {
    onItemsDetected: (items: { description: string; price: number }[], receiptPath?: string, validationWarning?: string | null, taxCents?: number | null, tipCents?: number | null, totalCents?: number | null) => void;
    onClose: () => void;
}

interface ScannedItem {
    description: string;
    price: number;       // cents
    quantity: number;
}

interface ScanResult {
    items: ScannedItem[];
    tax: number | null;   // cents
    tip: number | null;   // cents
    total: number | null;  // cents
    receipt_image_path: string;
}

type Phase = 'upload' | 'review';

const ReceiptScanner: React.FC<ReceiptScannerProps> = ({ onItemsDetected, onClose }) => {
    const { isOnline } = useSync();
    const [phase, setPhase] = useState<Phase>('upload');
    const [image, setImage] = useState<File | null>(null);
    const [imageUrl, setImageUrl] = useState<string>('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>('');

    // Scan results
    const [items, setItems] = useState<ScannedItem[]>([]);
    const [tax, setTax] = useState<number | null>(null);
    const [tip, setTip] = useState<number | null>(null);
    const [total, setTotal] = useState<number | null>(null);
    const [receiptImagePath, setReceiptImagePath] = useState<string>('');

    // Editing state
    const [editingIndex, setEditingIndex] = useState<number | null>(null);
    const [editDescription, setEditDescription] = useState('');
    const [editPrice, setEditPrice] = useState('');

    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            const file = e.target.files[0];
            setImage(file);
            setError('');
            if (imageUrl) URL.revokeObjectURL(imageUrl);
            setImageUrl(URL.createObjectURL(file));
        }
    };

    const handleScan = async () => {
        if (!image) return;

        setLoading(true);
        setError('');

        try {
            const compressedImage = await compressImage(image, 1920, 1);

            const formData = new FormData();
            formData.append('file', compressedImage);

            const token = localStorage.getItem('token');
            const response = await fetch(getApiUrl('ocr/scan-receipt'), {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData,
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || 'Receipt scanning failed');
            }

            const data: ScanResult = await response.json();

            if (!data.items || data.items.length === 0) {
                throw new Error('No items detected on the receipt. Please try a clearer photo.');
            }

            setItems(data.items);
            setTax(data.tax);
            setTip(data.tip);
            setTotal(data.total);
            setReceiptImagePath(data.receipt_image_path);
            setPhase('review');
        } catch (err: any) {
            setError(err.message || 'Failed to scan receipt');
        } finally {
            setLoading(false);
        }
    };

    const handleConfirm = () => {
        const finalItems = items.map(item => ({
            description: item.description,
            price: item.price,
        }));

        // Build a validation warning if item total doesn't match receipt total
        let warning: string | null = null;
        if (total != null) {
            const itemSum = items.reduce((sum, i) => sum + i.price, 0);
            const expectedSubtotal = total - (tax ?? 0) - (tip ?? 0);
            if (expectedSubtotal > 0 && Math.abs(itemSum - expectedSubtotal) > 10) {
                warning = `Item total ($${(itemSum / 100).toFixed(2)}) differs from receipt subtotal ($${(expectedSubtotal / 100).toFixed(2)}).`;
            }
        }

        onItemsDetected(finalItems, receiptImagePath, warning, tax, tip, total);
    };

    const handleCancel = () => {
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        onClose();
    };

    // Inline editing
    const startEditing = (index: number) => {
        setEditingIndex(index);
        setEditDescription(items[index].description);
        setEditPrice((items[index].price / 100).toFixed(2));
    };

    const saveEdit = () => {
        if (editingIndex === null) return;
        const priceCents = Math.round(parseFloat(editPrice || '0') * 100);
        setItems(prev => prev.map((item, i) =>
            i === editingIndex
                ? { ...item, description: editDescription || item.description, price: priceCents }
                : item
        ));
        setEditingIndex(null);
    };

    const cancelEdit = () => {
        setEditingIndex(null);
    };

    const deleteItem = (index: number) => {
        setItems(prev => prev.filter((_, i) => i !== index));
        if (editingIndex === index) setEditingIndex(null);
    };

    const formatCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;

    const itemSubtotal = items.reduce((sum, i) => sum + i.price, 0);

    return (
        <div className="fixed inset-0 bg-gray-600 dark:bg-gray-900/75 bg-opacity-50 overflow-y-auto h-full w-full flex items-center justify-center z-50 p-4">
            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl dark:shadow-gray-900/50 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
                {/* Header */}
                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-xl font-bold dark:text-gray-100">Scan Receipt</h2>
                    <div className="flex items-center gap-2 text-sm">
                        <div className={`flex items-center gap-1 ${phase === 'upload' ? 'text-teal-600 dark:text-teal-400 font-semibold' : 'text-gray-400 dark:text-gray-500'}`}>
                            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${phase === 'upload' ? 'bg-teal-100 dark:bg-teal-900/30' : 'bg-gray-100 dark:bg-gray-700'}`}>1</span>
                            <span className="hidden sm:inline">Upload</span>
                        </div>
                        <span className="text-gray-300 dark:text-gray-600">&rarr;</span>
                        <div className={`flex items-center gap-1 ${phase === 'review' ? 'text-teal-600 dark:text-teal-400 font-semibold' : 'text-gray-400 dark:text-gray-500'}`}>
                            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${phase === 'review' ? 'bg-teal-100 dark:bg-teal-900/30' : 'bg-gray-100 dark:bg-gray-700'}`}>2</span>
                            <span className="hidden sm:inline">Review</span>
                        </div>
                    </div>
                </div>

                {/* Error */}
                {error && (
                    <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                        <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
                    </div>
                )}

                {/* Offline warning */}
                {!isOnline && (
                    <div className="mb-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                        <p className="text-sm text-yellow-700 dark:text-yellow-400">
                            Receipt scanning requires an internet connection.
                        </p>
                    </div>
                )}

                {/* Upload Phase */}
                {phase === 'upload' && (
                    <div>
                        {!image && (
                            <div className="mb-4 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                                <p className="text-sm text-blue-700 dark:text-blue-400">
                                    Take a clear photo of your receipt. The AI will automatically detect and itemize all purchases.
                                </p>
                            </div>
                        )}

                        <div className="mb-4">
                            <label className="block w-full">
                                <span className="sr-only">Choose receipt</span>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept="image/*"
                                    onChange={handleImageChange}
                                    className="block w-full text-sm text-gray-500 dark:text-gray-400
                                        file:mr-4 file:py-2 file:px-4
                                        file:rounded-full file:border-0
                                        file:text-sm file:font-semibold
                                        file:bg-teal-50 file:text-teal-700
                                        hover:file:bg-teal-100
                                        dark:file:bg-teal-900/30 dark:file:text-teal-300
                                        cursor-pointer file:cursor-pointer"
                                />
                            </label>
                            {image && (
                                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                                    Selected: {image.name}
                                </p>
                            )}
                        </div>

                        {imageUrl && (
                            <div className="mb-4">
                                <img
                                    src={imageUrl}
                                    alt="Receipt preview"
                                    className="max-w-full max-h-80 mx-auto rounded border border-gray-300 dark:border-gray-600"
                                />
                            </div>
                        )}

                        {loading && (
                            <div className="mb-4 flex items-center justify-center gap-3 py-6">
                                <svg className="animate-spin h-5 w-5 text-teal-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                                </svg>
                                <span className="text-sm text-gray-600 dark:text-gray-300">Scanning receipt with AI...</span>
                            </div>
                        )}

                        <div className="flex justify-end space-x-3">
                            <button
                                onClick={handleCancel}
                                className="px-4 py-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
                                disabled={loading}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleScan}
                                disabled={!image || loading || !isOnline}
                                className={`px-4 py-2 text-white rounded flex items-center gap-2 ${
                                    !image || loading || !isOnline
                                        ? 'bg-gray-300 dark:bg-gray-600 cursor-not-allowed'
                                        : 'bg-teal-500 hover:bg-teal-600'
                                }`}
                            >
                                {loading ? 'Scanning...' : 'Scan Receipt'}
                            </button>
                        </div>
                    </div>
                )}

                {/* Review Phase */}
                {phase === 'review' && (
                    <div>
                        {/* Receipt image thumbnail for reference */}
                        {imageUrl && (
                            <details className="mb-4">
                                <summary className="text-sm text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300">
                                    View receipt image
                                </summary>
                                <div className="mt-2">
                                    <img
                                        src={imageUrl}
                                        alt="Receipt"
                                        className="max-w-full max-h-64 mx-auto rounded border border-gray-300 dark:border-gray-600"
                                    />
                                </div>
                            </details>
                        )}

                        {/* Items list */}
                        <div className="space-y-2 mb-4">
                            <div className="flex justify-between items-center mb-2">
                                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                                    Detected Items ({items.length})
                                </h3>
                                <span className="text-sm text-gray-500 dark:text-gray-400">
                                    Tap an item to edit
                                </span>
                            </div>

                            {items.map((item, index) => (
                                <div
                                    key={index}
                                    className={`border rounded-lg p-3 ${
                                        editingIndex === index
                                            ? 'border-teal-400 dark:border-teal-500 bg-teal-50/50 dark:bg-teal-900/10'
                                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 cursor-pointer'
                                    }`}
                                    onClick={() => editingIndex !== index && startEditing(index)}
                                >
                                    {editingIndex === index ? (
                                        <div className="space-y-2">
                                            <input
                                                type="text"
                                                value={editDescription}
                                                onChange={e => setEditDescription(e.target.value)}
                                                className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 dark:text-gray-100"
                                                placeholder="Item name"
                                                autoFocus
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter') saveEdit();
                                                    if (e.key === 'Escape') cancelEdit();
                                                }}
                                            />
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm text-gray-500 dark:text-gray-400">$</span>
                                                <input
                                                    type="number"
                                                    step="0.01"
                                                    min="0"
                                                    value={editPrice}
                                                    onChange={e => setEditPrice(e.target.value)}
                                                    className="w-28 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 dark:text-gray-100"
                                                    onKeyDown={e => {
                                                        if (e.key === 'Enter') saveEdit();
                                                        if (e.key === 'Escape') cancelEdit();
                                                    }}
                                                />
                                                <div className="flex-1" />
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); cancelEdit(); }}
                                                    className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
                                                >
                                                    Cancel
                                                </button>
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); saveEdit(); }}
                                                    className="px-2 py-1 text-xs text-white bg-teal-500 hover:bg-teal-600 rounded"
                                                >
                                                    Save
                                                </button>
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); deleteItem(index); }}
                                                    className="px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded"
                                                >
                                                    Delete
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex justify-between items-center">
                                            <div className="flex-1 min-w-0">
                                                <span className="text-sm text-gray-800 dark:text-gray-200 truncate block">
                                                    {item.quantity > 1 && (
                                                        <span className="text-gray-500 dark:text-gray-400 mr-1">{item.quantity}x</span>
                                                    )}
                                                    {item.description}
                                                </span>
                                            </div>
                                            <span className="text-sm font-medium text-gray-800 dark:text-gray-200 ml-4 whitespace-nowrap">
                                                {formatCents(item.price)}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>

                        {/* Summary */}
                        <div className="border-t border-gray-200 dark:border-gray-700 pt-3 space-y-1">
                            <div className="flex justify-between text-sm">
                                <span className="text-gray-600 dark:text-gray-400">Items subtotal</span>
                                <span className="font-medium text-gray-800 dark:text-gray-200">{formatCents(itemSubtotal)}</span>
                            </div>
                            {tax != null && tax > 0 && (
                                <div className="flex justify-between text-sm">
                                    <span className="text-gray-600 dark:text-gray-400">Tax (from receipt)</span>
                                    <span className="text-gray-600 dark:text-gray-400">{formatCents(tax)}</span>
                                </div>
                            )}
                            {tip != null && tip > 0 && (
                                <div className="flex justify-between text-sm">
                                    <span className="text-gray-600 dark:text-gray-400">Tip (from receipt)</span>
                                    <span className="text-gray-600 dark:text-gray-400">{formatCents(tip)}</span>
                                </div>
                            )}
                            {total != null && (
                                <div className="flex justify-between text-sm">
                                    <span className="text-gray-600 dark:text-gray-400">Receipt total</span>
                                    <span className="text-gray-600 dark:text-gray-400">{formatCents(total)}</span>
                                </div>
                            )}
                        </div>

                        {/* Actions */}
                        <div className="flex justify-end space-x-3 mt-4">
                            <button
                                onClick={() => { setPhase('upload'); setItems([]); setError(''); }}
                                className="px-4 py-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
                            >
                                Re-scan
                            </button>
                            <button
                                onClick={handleConfirm}
                                disabled={items.length === 0}
                                className={`px-4 py-2 text-white rounded ${
                                    items.length === 0
                                        ? 'bg-gray-300 dark:bg-gray-600 cursor-not-allowed'
                                        : 'bg-teal-500 hover:bg-teal-600'
                                }`}
                            >
                                Confirm Items ({items.length})
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default ReceiptScanner;

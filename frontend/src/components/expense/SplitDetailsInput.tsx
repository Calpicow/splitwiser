import React from 'react';
import type { Participant } from '../../types/expense';
import { getParticipantKey } from '../../utils/participantHelpers';

interface SplitDetailsInputProps {
    splitType: 'EXACT' | 'PERCENT' | 'SHARES';
    participants: Participant[];
    splitDetails: { [key: string]: string | number };
    onChange: (key: string, value: string) => void;
    currency: string;
    getParticipantName: (p: Participant) => string;
}

const SplitDetailsInput: React.FC<SplitDetailsInputProps> = ({
    splitType,
    participants,
    splitDetails,
    onChange,
    currency,
    getParticipantName
}) => {
    const getUnitLabel = () => {
        switch (splitType) {
            case 'PERCENT':
                return '%';
            case 'SHARES':
                return 'shares';
            case 'EXACT':
                return currency;
        }
    };

    return (
        <div className="bg-gray-50 dark:bg-gray-700 p-3 rounded space-y-3">
            {participants.map(p => {
                const key = getParticipantKey(p);
                return (
                    <div key={key} className="flex items-center justify-between gap-3">
                        <span className="text-sm flex-1 dark:text-gray-100">
                            {getParticipantName(p)}
                        </span>
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                inputMode="decimal"
                                className="w-24 border dark:border-gray-600 rounded p-2 text-sm text-right min-h-[44px] dark:bg-gray-800 dark:text-gray-100"
                                placeholder="0"
                                value={splitDetails[key] || ''}
                                onChange={(e) => onChange(key, e.target.value)}
                            />
                            <span className="text-sm text-gray-500 dark:text-gray-400 w-16">
                                {getUnitLabel()}
                            </span>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

export default SplitDetailsInput;

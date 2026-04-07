import { useState } from 'react';

export const useSplitDetails = () => {
    const [splitDetails, setSplitDetails] = useState<{ [key: string]: string | number }>({});

    const handleSplitDetailChange = (key: string, value: string) => {
        setSplitDetails(prev => ({ ...prev, [key]: value }));
    };

    const removeSplitDetail = (key: string) => {
        setSplitDetails(prev => {
            const newDetails = { ...prev };
            delete newDetails[key];
            return newDetails;
        });
    };

    return {
        splitDetails,
        setSplitDetails,
        handleSplitDetailChange,
        removeSplitDetail
    };
};

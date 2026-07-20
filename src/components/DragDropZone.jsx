import React, { useCallback, useState } from 'react';
import { Upload, File, X, FolderOpen } from 'lucide-react';

export function DragDropZone({ onFilesSelect, selectedFiles, onRemoveFile, onClearAll }) {
    const [isDragging, setIsDragging] = useState(false);

    const handleDragOver = useCallback((e) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    const handleDragLeave = useCallback((e) => {
        e.preventDefault();
        setIsDragging(false);
    }, []);

    const handleDrop = useCallback((e) => {
        e.preventDefault();
        setIsDragging(false);

        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            onFilesSelect(Array.from(e.dataTransfer.files));
        }
    }, [onFilesSelect]);

    const handleFileInput = useCallback((e) => {
        if (e.target.files && e.target.files.length > 0) {
            onFilesSelect(Array.from(e.target.files));
        }
    }, [onFilesSelect]);

    const formatFileSize = (bytes) => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    };

    if (selectedFiles && selectedFiles.length > 0) {
        const totalSize = selectedFiles.reduce((sum, file) => sum + file.size, 0);

        return (
            <div className="file-queue-container animate-fade-in">
                <div className="queue-header">
                    <div>
                        <h3>{selectedFiles.length} file{selectedFiles.length > 1 ? 's' : ''} selected</h3>
                        <p className="total-size">Total: {formatFileSize(totalSize)}</p>
                    </div>
                    <button className="clear-all-btn" onClick={onClearAll} title="Clear all">
                        Clear All
                    </button>
                </div>
                <div className="file-list">
                    {selectedFiles.map((file, index) => (
                        <div key={index} className="file-item animate-slide-in">
                            <div className="file-icon-small">
                                <File size={24} color="var(--primary-color)" />
                            </div>
                            <div className="file-info-small">
                                <p className="file-name-small">{file.name}</p>
                                <p className="file-size-small">{formatFileSize(file.size)}</p>
                            </div>
                            <button
                                className="remove-file-btn"
                                onClick={() => onRemoveFile(index)}
                                title="Remove file"
                            >
                                <X size={16} />
                            </button>
                        </div>
                    ))}
                </div>
                <div className="add-more-container">
                    <button
                        className="add-more-btn"
                        onClick={() => document.getElementById('file-input').click()}
                    >
                        <Upload size={18} /> Add More Files
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div
            className={`drop-zone ${isDragging ? 'dragging' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => document.getElementById('file-input').click()}
        >
            <input
                type="file"
                id="file-input"
                className="hidden"
                onChange={handleFileInput}
                multiple
            />
            <div className="icon-container">
                <Upload size={48} className={isDragging ? 'bounce' : ''} />
            </div>
            <p className="drop-text">
                Drag & Drop files here <br />
                <span className="sub-text">or click to browse (multiple files supported)</span>
            </p>
        </div>
    );
}

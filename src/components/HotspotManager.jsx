/**
 * Quick Fix Script - Test if App loads without errors
 */

// Create a minimal test component to identify the issue
import React from 'react';

export function HotspotManager({ onHotspotCreated }) {
    // Simple check - if not in Electron, show nothing
    if (typeof window === 'undefined' || !window.electronAPI) {
        return null; // Don't render anything if not in Electron
    }

    return (
        <div className="hotspot-manager">
            <p>Hotspot feature available in desktop app</p>
        </div>
    );
}

// ==UserScript==
// @name         Openguessr Location Hack - Enhanced Edition 2026
// @namespace    https://openguessr.com/
// @version      18.0.0
// @description  Professional edition with API interception, smart caching, enhanced UI, and zero detection. Press INSERT to toggle.
// @author       Uygar (Enhanced Edition 2026)
// @license      MIT
// @match        https://openguessr.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_log
// @grant        GM_xmlhttpRequest
// @connect      maps.googleapis.com
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    /* ==========================================
       CONFIGURATION & CONSTANTS
       ========================================== */

    const CONFIG = {
        DEBUG_MODE: true, // Changed to true for easier debugging
        UPDATE_INTERVAL: 500, // Faster check - 500ms instead of 2000ms
        ANIMATION_DURATION: 300,
        DEFAULT_ZOOM: 4, // Changed from 8 to 4 - wider view
        MAP_TYPE: 'satellite', // satellite, roadmap, hybrid, terrain
        STORAGE_KEYS: {
            DARK_MODE: 'og_dark_mode',
            POSITION: 'og_window_position',
            SIZE: 'og_window_size',
            SETTINGS: 'og_settings',
            LOCATION_HISTORY: 'og_location_history'
        },
        DEFAULT_SIZE: {
            width: 700,
            height: 500
        },
        MIN_SIZE: {
            width: 300,
            height: 250
        },
        MAX_HISTORY: 50
    };

    /* ==========================================
       UTILITY FUNCTIONS
       ========================================== */

    const Utils = {
        log: (...args) => {
            if (CONFIG.DEBUG_MODE) {
                console.log('[OpenGuessr Enhanced]', ...args);
            }
        },

        error: (...args) => {
            console.error('[OpenGuessr Enhanced ERROR]', ...args);
        },

        debounce: (func, wait) => {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        },

        throttle: (func, limit) => {
            let inThrottle;
            return function(...args) {
                if (!inThrottle) {
                    func.apply(this, args);
                    inThrottle = true;
                    setTimeout(() => inThrottle = false, limit);
                }
            };
        },

        parseCoordinates: (coordString) => {
            if (!coordString) return null;
            const parts = coordString.split(',').map(s => parseFloat(s.trim()));
            if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                return { lat: parts[0], lng: parts[1] };
            }
            return null;
        },

        formatCoordinates: (lat, lng, precision = 6) => {
            return `${lat.toFixed(precision)}, ${lng.toFixed(precision)}`;
        },

        copyToClipboard: async (text) => {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (err) {
                // Fallback method
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                const success = document.execCommand('copy');
                document.body.removeChild(textarea);
                return success;
            }
        },

        sanitizeHTML: (str) => {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }
    };

    /* ==========================================
       STORAGE MANAGER
       ========================================== */

    const Storage = {
        get: (key, defaultValue = null) => {
            try {
                const value = GM_getValue(key);
                return value !== undefined ? value : defaultValue;
            } catch (err) {
                Utils.error('Storage get error:', err);
                return defaultValue;
            }
        },

        set: (key, value) => {
            try {
                GM_setValue(key, value);
                return true;
            } catch (err) {
                Utils.error('Storage set error:', err);
                return false;
            }
        },

        remove: (key) => {
            try {
                GM_deleteValue(key);
                return true;
            } catch (err) {
                Utils.error('Storage remove error:', err);
                return false;
            }
        },

        getSettings: () => {
            return Storage.get(CONFIG.STORAGE_KEYS.SETTINGS, {
                autoOpen: false,
                showCoordinates: true,
                mapType: CONFIG.MAP_TYPE,
                defaultZoom: CONFIG.DEFAULT_ZOOM,
                showHistory: true,
                playSound: false
            });
        },

        saveSettings: (settings) => {
            Storage.set(CONFIG.STORAGE_KEYS.SETTINGS, settings);
        },

        getLocationHistory: () => {
            return Storage.get(CONFIG.STORAGE_KEYS.LOCATION_HISTORY, []);
        },

        addLocationToHistory: (location) => {
            let history = Storage.getLocationHistory();
            const timestamp = Date.now();
            const entry = { ...location, timestamp };

            // Prevent duplicates
            history = history.filter(h =>
                h.lat !== location.lat || h.lng !== location.lng
            );

            history.unshift(entry);

            // Limit history size
            if (history.length > CONFIG.MAX_HISTORY) {
                history = history.slice(0, CONFIG.MAX_HISTORY);
            }

            Storage.set(CONFIG.STORAGE_KEYS.LOCATION_HISTORY, history);
        },

        clearLocationHistory: () => {
            Storage.set(CONFIG.STORAGE_KEYS.LOCATION_HISTORY, []);
        }
    };

    /* ==========================================
       LOCATION EXTRACTOR
       ========================================== */

    const LocationExtractor = {
        currentLocation: null,
        observers: [],

        // Simple extraction like the original script
        extractFromIframe: () => {
            try {
                const iframes = document.querySelectorAll('iframe[src*="google.com/maps"]');

                for (const iframe of iframes) {
                    try {
                        const url = new URL(iframe.src);

                        // Try pb parameter (most common)
                        if (url.searchParams.has('pb')) {
                            const pb = url.searchParams.get('pb');
                            const match = pb.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
                            if (match) {
                                return {
                                    lat: parseFloat(match[1]),
                                    lng: parseFloat(match[2]),
                                    source: 'iframe-pb'
                                };
                            }
                        }

                        // Try location parameter
                        if (url.searchParams.has('location')) {
                            const coords = Utils.parseCoordinates(url.searchParams.get('location'));
                            if (coords) return { ...coords, source: 'iframe-location' };
                        }
                    } catch (err) {
                        continue;
                    }
                }
            } catch (err) {
                Utils.error('extractFromIframe error:', err);
            }
            return null;
        },

        // Method 2: Intercept XHR/Fetch requests
        interceptNetworkRequests: () => {
            // Intercept fetch
            const originalFetch = window.fetch;
            window.fetch = async function(...args) {
                const response = await originalFetch.apply(this, args);

                try {
                    const url = args[0]?.toString() || '';
                    if (url.includes('maps') || url.includes('location') || url.includes('coordinates')) {
                        // Clone response to read it
                        const clonedResponse = response.clone();
                        const text = await clonedResponse.text();

                        // Try to find coordinates in response
                        const coordMatch = text.match(/[-]?\d+\.\d+,\s*[-]?\d+\.\d+/g);
                        if (coordMatch) {
                            const coords = Utils.parseCoordinates(coordMatch[0]);
                            if (coords && coords.lat >= -90 && coords.lat <= 90 &&
                                coords.lng >= -180 && coords.lng <= 180) {
                                LocationExtractor.currentLocation = { ...coords, source: 'fetch' };
                                Utils.log('Location found via fetch:', coords);
                            }
                        }
                    }
                } catch (err) {
                    // Silent fail - response might not be text
                }

                return response;
            };

            // Intercept XMLHttpRequest
            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSend = XMLHttpRequest.prototype.send;

            XMLHttpRequest.prototype.open = function(method, url, ...args) {
                this._url = url;
                return originalOpen.apply(this, [method, url, ...args]);
            };

            XMLHttpRequest.prototype.send = function(...args) {
                this.addEventListener('load', function() {
                    try {
                        if (this._url && (this._url.includes('maps') || this._url.includes('location'))) {
                            const coordMatch = this.responseText.match(/[-]?\d+\.\d+,\s*[-]?\d+\.\d+/g);
                            if (coordMatch) {
                                const coords = Utils.parseCoordinates(coordMatch[0]);
                                if (coords && coords.lat >= -90 && coords.lat <= 90) {
                                    LocationExtractor.currentLocation = { ...coords, source: 'xhr' };
                                    Utils.log('Location found via XHR:', coords);
                                }
                            }
                        }
                    } catch (err) {
                        // Silent fail
                    }
                });
                return originalSend.apply(this, args);
            };
        },

        // Method 3: Monitor DOM for location data
        monitorDOM: () => {
            const observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) { // Element node
                            // Check for iframes
                            if (node.tagName === 'IFRAME' && node.src.includes('google.com/maps')) {
                                const location = LocationExtractor.extractFromIframe();
                                if (location) {
                                    LocationExtractor.currentLocation = location;
                                }
                            }

                            // Check child iframes
                            const iframes = node.querySelectorAll?.('iframe[src*="google.com/maps"]');
                            if (iframes?.length > 0) {
                                const location = LocationExtractor.extractFromIframe();
                                if (location) {
                                    LocationExtractor.currentLocation = location;
                                }
                            }
                        }
                    }
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            LocationExtractor.observers.push(observer);
        },

        // Get current location using all methods
        getCurrentLocation: () => {
            // Try iframe extraction first (most reliable)
            const iframeLocation = LocationExtractor.extractFromIframe();
            if (iframeLocation) {
                LocationExtractor.currentLocation = iframeLocation;
                return iframeLocation;
            }

            // Return last known location from network interception
            return LocationExtractor.currentLocation;
        },

        initialize: () => {
            Utils.log('Initializing location extractor...');
            LocationExtractor.interceptNetworkRequests();

            // Wait for body to be available
            if (document.body) {
                LocationExtractor.monitorDOM();
            } else {
                document.addEventListener('DOMContentLoaded', () => {
                    LocationExtractor.monitorDOM();
                });
            }
        },

        cleanup: () => {
            LocationExtractor.observers.forEach(observer => observer.disconnect());
            LocationExtractor.observers = [];
        }
    };

    /* ==========================================
       UI MANAGER
       ========================================== */

    const UI = {
        elements: {},
        isDragging: false,
        isResizing: false,
        dragOffset: { x: 0, y: 0 },
        resizeStart: { x: 0, y: 0, width: 0, height: 0 },

        injectStyles: () => {
            GM_addStyle(`
                :root {
                    --og-bg-color: rgba(30, 30, 30, 0.95);
                    --og-header-bg-color: rgba(44, 47, 51, 0.5);
                    --og-text-color: #f0f0f0;
                    --og-border-color: rgba(255, 255, 255, 0.1);
                    --og-shadow-color: rgba(0, 0, 0, 0.5);
                    --og-accent-color: #a100c2;
                    --og-button-close-bg: #e74c3c;
                    --og-font: 'Segoe UI', 'Roboto', 'Helvetica Neue', sans-serif;
                }

                #og-enhanced-container {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    width: 700px;
                    height: 500px;
                    display: none;
                    flex-direction: column;
                    background-color: var(--og-bg-color);
                    border: 1px solid var(--og-border-color);
                    box-shadow: 0 8px 32px 0 var(--og-shadow-color);
                    z-index: 10000;
                    border-radius: 12px;
                    overflow: hidden;
                    font-family: var(--og-font);
                    opacity: 0;
                    transform: scale(0.98) translateY(10px);
                    transition: opacity 0.3s ease, transform 0.3s ease;
                    resize: both;
                    min-width: 300px;
                    min-height: 250px;
                }

                #og-enhanced-container.visible {
                    opacity: 1;
                    transform: scale(1) translateY(0);
                }

                .og-header {
                    height: 40px;
                    background-color: var(--og-header-bg-color);
                    backdrop-filter: blur(10px);
                    -webkit-backdrop-filter: blur(10px);
                    padding: 0 15px;
                    cursor: grab;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-bottom: 1px solid var(--og-border-color);
                    flex-shrink: 0;
                    user-select: none;
                    -webkit-user-select: none;
                }

                .og-header:active {
                    cursor: grabbing;
                }

                .og-header-left {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }

                .og-logo {
                    color: var(--og-text-color);
                    font-weight: 600;
                    font-size: 0.9em;
                }

                .og-status-indicator {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background: #10b981;
                    animation: pulse 2s infinite;
                }

                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                }

                .og-header-right {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .og-btn {
                    padding: 6px 12px;
                    border: none;
                    border-radius: 6px;
                    font-size: 13px;
                    font-weight: 500;
                    cursor: pointer;
                    transition: all 0.2s;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    background: var(--og-accent-color);
                    color: white;
                }

                .og-btn:hover {
                    transform: translateY(-1px);
                    opacity: 0.9;
                }

                .og-btn-icon {
                    width: 28px;
                    height: 28px;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border: none;
                    cursor: pointer;
                    transition: all 0.2s;
                    background-color: transparent;
                    color: var(--og-text-color);
                    font-size: 16px;
                }

                .og-btn-icon:hover {
                    background-color: rgba(161, 0, 194, 0.2);
                    transform: scale(1.1);
                }

                .og-btn-danger {
                    background: var(--og-button-close-bg);
                    color: white;
                }

                .og-content {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }

                .og-info-bar {
                    padding: 10px 16px;
                    background: rgba(161, 0, 194, 0.1);
                    border-bottom: 1px solid var(--og-border-color);
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    flex-shrink: 0;
                    flex-wrap: wrap;
                    gap: 8px;
                }

                .og-coordinates {
                    font-family: 'Monaco', 'Courier New', monospace;
                    font-size: 13px;
                    color: var(--og-accent-color);
                    font-weight: 600;
                    user-select: all;
                }

                .og-map-container {
                    flex: 1;
                    position: relative;
                    overflow: hidden;
                }

                .og-map-iframe {
                    width: 100%;
                    height: 100%;
                    border: none;
                }

                .og-loading {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    text-align: center;
                    color: var(--og-text-color);
                }

                .og-spinner {
                    border: 3px solid rgba(161, 0, 194, 0.1);
                    border-top: 3px solid var(--og-accent-color);
                    border-radius: 50%;
                    width: 40px;
                    height: 40px;
                    animation: spin 1s linear infinite;
                    margin: 0 auto 10px;
                }

                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }

                .og-settings-panel {
                    position: fixed;
                    width: 280px;
                    background-color: var(--og-bg-color);
                    backdrop-filter: blur(12px);
                    -webkit-backdrop-filter: blur(12px);
                    border: 1px solid var(--og-border-color);
                    border-radius: 10px;
                    padding: 15px;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.25);
                    color: var(--og-text-color);
                    font-family: var(--og-font);
                    z-index: 1000000;
                    display: none;
                    opacity: 0;
                    transform: translateX(-20px);
                    transition: opacity 0.3s ease, transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
                }

                .og-settings-panel.visible {
                    display: block;
                    opacity: 1;
                    transform: translateX(0);
                }

                .og-settings-title {
                    font-size: 16px;
                    font-weight: 600;
                    margin-bottom: 15px;
                }

                .og-setting-item {
                    margin-bottom: 15px;
                }

                .og-setting-label {
                    display: block;
                    font-size: 12px;
                    font-weight: 500;
                    margin-bottom: 6px;
                }

                .og-setting-input {
                    width: 100%;
                    padding: 8px;
                    border: 1px solid var(--og-border-color);
                    border-radius: 6px;
                    background: rgba(50, 50, 50, 0.5);
                    color: var(--og-text-color);
                    font-size: 13px;
                }

                .og-setting-input[type="range"] {
                    padding: 0;
                    height: 6px;
                    background: rgba(161, 0, 194, 0.2);
                    outline: none;
                    -webkit-appearance: none;
                }

                .og-setting-input[type="range"]::-webkit-slider-thumb {
                    -webkit-appearance: none;
                    appearance: none;
                    width: 16px;
                    height: 16px;
                    background: var(--og-accent-color);
                    cursor: pointer;
                    border-radius: 50%;
                }

                .og-setting-input[type="range"]::-moz-range-thumb {
                    width: 16px;
                    height: 16px;
                    background: var(--og-accent-color);
                    cursor: pointer;
                    border-radius: 50%;
                    border: none;
                }

                .og-toggle {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }

                .og-toggle-switch {
                    position: relative;
                    width: 44px;
                    height: 24px;
                    background: #555;
                    border-radius: 12px;
                    cursor: pointer;
                    transition: background 0.2s;
                }

                .og-toggle-switch.active {
                    background: var(--og-accent-color);
                }

                .og-toggle-slider {
                    position: absolute;
                    top: 2px;
                    left: 2px;
                    width: 20px;
                    height: 20px;
                    background: white;
                    border-radius: 50%;
                    transition: transform 0.2s;
                }

                .og-toggle-switch.active .og-toggle-slider {
                    transform: translateX(20px);
                }

                .og-history-panel {
                    position: fixed;
                    width: 320px;
                    max-height: 400px;
                    background: var(--og-bg-color);
                    border: 1px solid var(--og-border-color);
                    border-radius: 12px;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.25);
                    z-index: 1000000;
                    display: none;
                    flex-direction: column;
                }

                .og-history-panel.visible {
                    display: flex;
                }

                .og-history-header {
                    padding: 12px;
                    border-bottom: 1px solid var(--og-border-color);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }

                .og-history-title {
                    font-size: 14px;
                    font-weight: 600;
                }

                .og-history-list {
                    flex: 1;
                    overflow-y: auto;
                    padding: 8px;
                }

                .og-history-item {
                    padding: 10px;
                    border-radius: 6px;
                    cursor: pointer;
                    transition: background 0.2s;
                    margin-bottom: 4px;
                }

                .og-history-item:hover {
                    background: rgba(161, 0, 194, 0.2);
                }

                .og-history-coords {
                    font-family: 'Monaco', 'Courier New', monospace;
                    font-size: 12px;
                    color: var(--og-accent-color);
                    margin-bottom: 4px;
                }

                .og-history-time {
                    font-size: 10px;
                    color: #888;
                }

                .og-toast {
                    position: fixed;
                    bottom: 20px;
                    left: 50%;
                    transform: translateX(-50%) translateY(100px);
                    background: var(--og-bg-color);
                    color: white;
                    padding: 12px 20px;
                    border-radius: 8px;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.4);
                    z-index: 10000000;
                    opacity: 0;
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                    font-size: 14px;
                    font-weight: 500;
                }

                .og-toast.visible {
                    opacity: 1;
                    transform: translateX(-50%) translateY(0);
                }

                .og-toast.success {
                    background: #10b981;
                }

                .og-toast.error {
                    background: #ef4444;
                }

                .og-history-list::-webkit-scrollbar {
                    width: 6px;
                }

                .og-history-list::-webkit-scrollbar-track {
                    background: transparent;
                }

                .og-history-list::-webkit-scrollbar-thumb {
                    background: rgba(161, 0, 194, 0.3);
                    border-radius: 3px;
                }

                .og-history-list::-webkit-scrollbar-thumb:hover {
                    background: rgba(161, 0, 194, 0.5);
                }
            `);
        },

        createElements: () => {
            // Main container
            const container = document.createElement('div');
            container.id = 'og-enhanced-container';
            container.innerHTML = `
                <div class="og-header">
                    <div class="og-header-left">
                        <div class="og-logo">🎯 OpenGuessr Pro</div>
                        <div class="og-status-indicator"></div>
                    </div>
                    <div class="og-header-right">
                        <button class="og-btn-icon" id="og-history-btn" title="Location History">
                            📜
                        </button>
                        <button class="og-btn-icon" id="og-settings-btn" title="Settings">
                            ⚙️
                        </button>
                        <button class="og-btn-icon og-btn-danger" id="og-close-btn" title="Close (Insert)">
                            ✕
                        </button>
                    </div>
                </div>
                <div class="og-content">
                    <div class="og-info-bar">
                        <div class="og-coordinates" id="og-coordinates">
                            Waiting for location...
                        </div>
                        <button class="og-btn og-btn-primary" id="og-copy-btn">
                            📋 Copy
                        </button>
                    </div>
                    <div class="og-map-container">
                        <div class="og-loading" id="og-loading">
                            <div class="og-spinner"></div>
                            <div>Loading map...</div>
                        </div>
                        <iframe class="og-map-iframe" id="og-map-iframe"></iframe>
                    </div>
                </div>
            `;

            // Settings panel
            const settingsPanel = document.createElement('div');
            settingsPanel.className = 'og-settings-panel';
            settingsPanel.id = 'og-settings-panel';
            settingsPanel.innerHTML = `
                <div class="og-settings-title">⚙️ Settings</div>

                <div class="og-setting-item">
                    <label class="og-setting-label">Window Width</label>
                    <input type="range" class="og-setting-input" id="og-width-slider" min="300" max="1200" value="700" style="cursor: pointer;">
                    <div style="text-align: center; margin-top: 4px; font-size: 12px; color: #888;" id="og-width-value">700px</div>
                </div>

                <div class="og-setting-item">
                    <label class="og-setting-label">Window Height</label>
                    <input type="range" class="og-setting-input" id="og-height-slider" min="250" max="900" value="500" style="cursor: pointer;">
                    <div style="text-align: center; margin-top: 4px; font-size: 12px; color: #888;" id="og-height-value">500px</div>
                </div>

                <div class="og-setting-item">
                    <label class="og-setting-label">Zoom Level</label>
                    <input type="range" class="og-setting-input" id="og-zoom-level" min="1" max="20" value="4" style="cursor: pointer;">
                    <div style="text-align: center; margin-top: 4px; font-size: 12px; color: #888;" id="og-zoom-value">4</div>
                </div>

                <div class="og-setting-item">
                    <div class="og-toggle">
                        <div class="og-toggle-switch" id="og-auto-open-toggle">
                            <div class="og-toggle-slider"></div>
                        </div>
                        <label class="og-setting-label" style="margin: 0;">Auto-open on game start</label>
                    </div>
                </div>

                <div class="og-setting-item">
                    <div class="og-toggle">
                        <div class="og-toggle-switch active" id="og-show-coords-toggle">
                            <div class="og-toggle-slider"></div>
                        </div>
                        <label class="og-setting-label" style="margin: 0;">Show Coordinates</label>
                    </div>
                </div>

                <div class="og-setting-item" style="margin-top: 24px;">
                    <button class="og-btn og-btn-danger" id="og-clear-history" style="width: 100%;">
                        🗑️ Clear Location History
                    </button>
                </div>
            `;

            // History panel
            const historyPanel = document.createElement('div');
            historyPanel.className = 'og-history-panel';
            historyPanel.id = 'og-history-panel';
            historyPanel.innerHTML = `
                <div class="og-history-header">
                    <div class="og-history-title">📜 Location History</div>
                    <button class="og-btn-icon" id="og-history-close">✕</button>
                </div>
                <div class="og-history-list" id="og-history-list">
                    <div style="text-align: center; padding: 20px; color: #6b7280;">
                        No locations in history
                    </div>
                </div>
            `;

            document.body.appendChild(container);
            document.body.appendChild(settingsPanel);
            document.body.appendChild(historyPanel);

            // Store references
            UI.elements = {
                container,
                settingsPanel,
                historyPanel,
                closeBtn: container.querySelector('#og-close-btn'),
                settingsBtn: container.querySelector('#og-settings-btn'),
                historyBtn: container.querySelector('#og-history-btn'),
                copyBtn: container.querySelector('#og-copy-btn'),
                coordinates: container.querySelector('#og-coordinates'),
                mapIframe: container.querySelector('#og-map-iframe'),
                loading: container.querySelector('#og-loading'),
                widthSlider: settingsPanel.querySelector('#og-width-slider'),
                widthValue: settingsPanel.querySelector('#og-width-value'),
                heightSlider: settingsPanel.querySelector('#og-height-slider'),
                heightValue: settingsPanel.querySelector('#og-height-value'),
                zoomLevelInput: settingsPanel.querySelector('#og-zoom-level'),
                zoomValueDisplay: settingsPanel.querySelector('#og-zoom-value'),
                autoOpenToggle: settingsPanel.querySelector('#og-auto-open-toggle'),
                showCoordsToggle: settingsPanel.querySelector('#og-show-coords-toggle'),
                clearHistoryBtn: settingsPanel.querySelector('#og-clear-history'),
                historyList: historyPanel.querySelector('#og-history-list'),
                historyClose: historyPanel.querySelector('#og-history-close')
            };

            UI.attachEventListeners();
        },

        attachEventListeners: () => {
            const { elements } = UI;

            // Close button
            elements.closeBtn.addEventListener('click', () => UI.hide());

            // Settings button
            elements.settingsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isActive = elements.settingsPanel.classList.toggle('visible');
                elements.historyPanel.classList.remove('visible');

                if (isActive) {
                    // Position panel to the RIGHT of the container
                    const containerRect = elements.container.getBoundingClientRect();
                    elements.settingsPanel.style.left = `${containerRect.right + 10}px`;
                    elements.settingsPanel.style.top = `${containerRect.top}px`;
                }
            });

            // History button
            elements.historyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                UI.updateHistoryPanel();
                const isActive = elements.historyPanel.classList.toggle('visible');
                elements.settingsPanel.classList.remove('visible');

                if (isActive) {
                    // Position panel to the RIGHT of the container
                    const containerRect = elements.container.getBoundingClientRect();
                    elements.historyPanel.style.left = `${containerRect.right + 10}px`;
                    elements.historyPanel.style.top = `${containerRect.top}px`;
                }
            });

            // History close button
            elements.historyClose.addEventListener('click', () => {
                elements.historyPanel.classList.remove('visible');
            });

            // Copy button
            elements.copyBtn.addEventListener('click', () => UI.copyCoordinates());

            // Width slider
            elements.widthSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                elements.widthValue.textContent = `${value}px`;
                elements.container.style.width = `${value}px`;
            });

            // Update panel positions only when slider is released (mouseup)
            elements.widthSlider.addEventListener('mouseup', () => {
                const containerRect = elements.container.getBoundingClientRect();
                if (elements.settingsPanel.classList.contains('visible')) {
                    elements.settingsPanel.style.left = `${containerRect.right + 10}px`;
                }
                if (elements.historyPanel.classList.contains('visible')) {
                    elements.historyPanel.style.left = `${containerRect.right + 10}px`;
                }
            });

            // Height slider
            elements.heightSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                elements.heightValue.textContent = `${value}px`;
                elements.container.style.height = `${value}px`;
            });

            // Zoom level change
            elements.zoomLevelInput.addEventListener('input', (e) => {
                const value = e.target.value;
                elements.zoomValueDisplay.textContent = value;
                const settings = Storage.getSettings();
                settings.defaultZoom = parseInt(value);
                Storage.saveSettings(settings);
                Utils.log('Zoom level changed to:', value);

                // Force map update with current location and new settings
                if (App.currentLocation) {
                    // Hide loading
                    if (UI.elements.loading) {
                        UI.elements.loading.style.display = 'none';
                    }
                    UI.updateMap(App.currentLocation, settings);
                }
            });

            // Auto-open toggle
            elements.autoOpenToggle.addEventListener('click', () => {
                elements.autoOpenToggle.classList.toggle('active');
                const settings = Storage.getSettings();
                settings.autoOpen = elements.autoOpenToggle.classList.contains('active');
                Storage.saveSettings(settings);
            });

            // Show coordinates toggle
            elements.showCoordsToggle.addEventListener('click', () => {
                elements.showCoordsToggle.classList.toggle('active');
                const settings = Storage.getSettings();
                settings.showCoordinates = elements.showCoordsToggle.classList.contains('active');
                Storage.saveSettings(settings);
                UI.updateCoordinatesDisplay();
            });

            // Clear history button
            elements.clearHistoryBtn.addEventListener('click', () => {
                if (confirm('Are you sure you want to clear all location history?')) {
                    Storage.clearLocationHistory();
                    UI.updateHistoryPanel();
                    UI.showToast('History cleared', 'success');
                }
            });

            // Dragging
            elements.container.querySelector('.og-header').addEventListener('mousedown', (e) => {
                if (e.target.closest('button')) return;
                UI.isDragging = true;
                UI.dragOffset = {
                    x: e.clientX - elements.container.offsetLeft,
                    y: e.clientY - elements.container.offsetTop
                };

                // Disable pointer events on iframe while dragging to prevent conflicts
                if (elements.mapIframe) {
                    elements.mapIframe.style.pointerEvents = 'none';
                }
            });

            // Mouse move
            document.addEventListener('mousemove', (e) => {
                if (UI.isDragging) {
                    const newLeft = e.clientX - UI.dragOffset.x;
                    const newTop = e.clientY - UI.dragOffset.y;
                    elements.container.style.left = `${newLeft}px`;
                    elements.container.style.top = `${newTop}px`;
                    elements.container.style.bottom = 'auto';
                    elements.container.style.right = 'auto';

                    // Move panels with the container
                    const containerRect = elements.container.getBoundingClientRect();
                    if (elements.settingsPanel.classList.contains('visible')) {
                        elements.settingsPanel.style.left = `${containerRect.right + 10}px`;
                        elements.settingsPanel.style.top = `${containerRect.top}px`;
                    }
                    if (elements.historyPanel.classList.contains('visible')) {
                        elements.historyPanel.style.left = `${containerRect.right + 10}px`;
                        elements.historyPanel.style.top = `${containerRect.top}px`;
                    }
                }
            });

            // Mouse up
            document.addEventListener('mouseup', () => {
                if (UI.isDragging) {
                    UI.savePosition();

                    // Re-enable pointer events on iframe after dragging
                    if (UI.elements.mapIframe) {
                        UI.elements.mapIframe.style.pointerEvents = 'auto';
                    }
                }
                UI.isDragging = false;
            });

            // Prevent settings and history panel clicks from propagating
            elements.settingsPanel.addEventListener('click', (e) => e.stopPropagation());
            elements.historyPanel.addEventListener('click', (e) => e.stopPropagation());
        },

        show: () => {
            if (!UI.elements.container) return;

            UI.elements.container.style.display = 'flex';
            setTimeout(() => {
                UI.elements.container.classList.add('visible');
            }, 10);

            UI.restorePosition();
            UI.loadSettings();

            // Trigger immediate location check
            const location = LocationExtractor.getCurrentLocation();
            if (location) {
                App.currentLocation = location;
                const settings = Storage.getSettings();
                const zoom = settings.defaultZoom || CONFIG.DEFAULT_ZOOM;
                const mapType = settings.mapType || CONFIG.MAP_TYPE;
                const url = `https://maps.google.com/maps?q=${location.lat},${location.lng}&ll=${location.lat},${location.lng}&z=${zoom}&t=${mapType}&output=embed`;

                // Hide loading
                if (UI.elements.loading) {
                    UI.elements.loading.style.display = 'none';
                }

                UI.elements.mapIframe.src = url;
                UI.elements.coordinates.textContent = Utils.formatCoordinates(location.lat, location.lng);
            }
        },

        hide: () => {
            if (!UI.elements.container) return;

            UI.elements.container.classList.remove('visible');
            UI.elements.settingsPanel.classList.remove('visible');
            UI.elements.historyPanel.classList.remove('visible');

            setTimeout(() => {
                UI.elements.container.style.display = 'none';
            }, CONFIG.ANIMATION_DURATION);
        },

        toggle: () => {
            if (UI.elements.container.classList.contains('visible')) {
                UI.hide();
            } else {
                UI.show();
                App.updateLocation();
            }
        },

        updateMap: (location, settings) => {
            if (!location || !UI.elements.mapIframe) {
                Utils.log('Cannot update map: location or iframe missing');
                return;
            }

            if (!settings) {
                settings = Storage.getSettings();
            }

            const zoom = settings.defaultZoom || CONFIG.DEFAULT_ZOOM;
            const mapType = settings.mapType || CONFIG.MAP_TYPE;

            Utils.log('Updating map with:', { location, zoom, mapType });

            // Build Google Maps embed URL
            const url = `https://maps.google.com/maps?q=${location.lat},${location.lng}&ll=${location.lat},${location.lng}&z=${zoom}&t=${mapType}&output=embed`;

            // Show loading
            if (UI.elements.loading) {
                UI.elements.loading.style.display = 'block';
            }

            // FORCE iframe update
            UI.elements.mapIframe.src = url;

            Utils.log('Iframe src set to:', url);

            // Hide loading after iframe loads
            UI.elements.mapIframe.onload = () => {
                if (UI.elements.loading) {
                    UI.elements.loading.style.display = 'none';
                }
                Utils.log('Map iframe loaded successfully');
            };

            // Update coordinates display
            if (UI.elements.coordinates) {
                UI.elements.coordinates.textContent = Utils.formatCoordinates(location.lat, location.lng);
            }
        },

        copyCoordinates: async () => {
            const coords = UI.elements.coordinates.textContent;
            if (coords && coords !== 'Waiting for location...') {
                const success = await Utils.copyToClipboard(coords);
                if (success) {
                    UI.showToast('Coordinates copied!', 'success');
                } else {
                    UI.showToast('Failed to copy', 'error');
                }
            }
        },

        updateCoordinatesDisplay: () => {
            const settings = Storage.getSettings();
            const infoBar = UI.elements.coordinates.parentElement;

            if (settings.showCoordinates) {
                infoBar.style.display = 'flex';
            } else {
                infoBar.style.display = 'none';
            }
        },

        showToast: (message, type = 'info') => {
            const toast = document.createElement('div');
            toast.className = `og-toast ${type}`;
            toast.textContent = message;
            document.body.appendChild(toast);

            setTimeout(() => toast.classList.add('visible'), 10);

            setTimeout(() => {
                toast.classList.remove('visible');
                setTimeout(() => toast.remove(), 300);
            }, 2000);
        },

        loadSettings: () => {
            const settings = Storage.getSettings();

            // Set width and height sliders to current container size
            const currentWidth = UI.elements.container.offsetWidth || 700;
            const currentHeight = UI.elements.container.offsetHeight || 500;
            UI.elements.widthSlider.value = currentWidth;
            UI.elements.widthValue.textContent = `${currentWidth}px`;
            UI.elements.heightSlider.value = currentHeight;
            UI.elements.heightValue.textContent = `${currentHeight}px`;

            // Zoom level
            UI.elements.zoomLevelInput.value = settings.defaultZoom;
            UI.elements.zoomValueDisplay.textContent = settings.defaultZoom;

            // Toggles
            UI.elements.autoOpenToggle.classList.toggle('active', settings.autoOpen);
            UI.elements.showCoordsToggle.classList.toggle('active', settings.showCoordinates);

            // Apply coordinate display
            UI.updateCoordinatesDisplay();
        },

        savePosition: () => {
            if (!UI.elements.container) return;

            const position = {
                left: UI.elements.container.offsetLeft,
                top: UI.elements.container.offsetTop,
                width: UI.elements.container.offsetWidth,
                height: UI.elements.container.offsetHeight
            };

            Storage.set(CONFIG.STORAGE_KEYS.POSITION, position);
        },

        restorePosition: () => {
            const position = Storage.get(CONFIG.STORAGE_KEYS.POSITION);

            if (position && UI.elements.container) {
                UI.elements.container.style.left = `${position.left}px`;
                UI.elements.container.style.top = `${position.top}px`;
                UI.elements.container.style.width = `${position.width}px`;
                UI.elements.container.style.height = `${position.height}px`;
                UI.elements.container.style.bottom = 'auto';
                UI.elements.container.style.right = 'auto';
            }
        },

        updateHistoryPanel: () => {
            const history = Storage.getLocationHistory();
            const listElement = UI.elements.historyList;

            if (history.length === 0) {
                listElement.innerHTML = `
                    <div style="text-align: center; padding: 20px; color: #6b7280;">
                        No locations in history
                    </div>
                `;
                return;
            }

            listElement.innerHTML = history.map((entry, index) => {
                const date = new Date(entry.timestamp);
                const timeString = date.toLocaleTimeString();
                const dateString = date.toLocaleDateString();

                return `
                    <div class="og-history-item" data-index="${index}">
                        <div class="og-history-coords">${Utils.formatCoordinates(entry.lat, entry.lng)}</div>
                        <div class="og-history-time">${dateString} ${timeString}</div>
                    </div>
                `;
            }).join('');

            // Add click handlers
            listElement.querySelectorAll('.og-history-item').forEach(item => {
                item.addEventListener('click', () => {
                    const index = parseInt(item.dataset.index);
                    const location = history[index];
                    if (location) {
                        App.updateMap(location);
                        UI.elements.historyPanel.classList.remove('visible');
                        UI.showToast('Location loaded from history', 'success');
                    }
                });
            });
        }
    };

    /* ==========================================
       MAIN APPLICATION
       ========================================== */

    const App = {
        currentLocation: null,
        updateInterval: null,
        isInitialized: false,

        initialize: () => {
            if (App.isInitialized) return;

            Utils.log('Initializing OpenGuessr Enhanced...');

            // Inject styles
            UI.injectStyles();

            // Initialize location extractor
            LocationExtractor.initialize();

            // Create UI elements
            UI.createElements();

            // Setup keyboard shortcut
            App.setupKeyboardShortcuts();

            // Start location monitoring IMMEDIATELY
            App.startLocationMonitoring();

            // Also do immediate location check
            setTimeout(() => {
                const loc = LocationExtractor.getCurrentLocation();
                if (loc) {
                    Utils.log('Initial location found:', loc);
                    App.currentLocation = loc;
                }
            }, 100);

            // Auto-open if enabled
            const settings = Storage.getSettings();
            if (settings.autoOpen) {
                setTimeout(() => {
                    const location = LocationExtractor.getCurrentLocation();
                    if (location) {
                        UI.show();
                    }
                }, 2000);
            }

            App.isInitialized = true;
            Utils.log('OpenGuessr Enhanced initialized successfully!');
        },

        setupKeyboardShortcuts: () => {
            document.addEventListener('keydown', (e) => {
                // Insert key to toggle
                if (e.key === 'Insert') {
                    e.preventDefault();
                    UI.toggle();
                }

                // Ctrl+Shift+C to copy coordinates
                if (e.ctrlKey && e.shiftKey && e.key === 'C') {
                    e.preventDefault();
                    UI.copyCoordinates();
                }
            });
        },

        startLocationMonitoring: () => {
            // Clear any existing interval
            if (App.updateInterval) {
                clearInterval(App.updateInterval);
            }

            // Simple monitoring like original script - check every 1.5 seconds
            App.updateInterval = setInterval(() => {
                // Skip if window not visible
                if (!UI.elements.container || UI.elements.container.style.display === 'none') {
                    return;
                }

                const location = LocationExtractor.getCurrentLocation();
                if (!location) return;

                // Check if location changed
                if (location && (location.lat !== App.currentLocation?.lat || location.lng !== App.currentLocation?.lng)) {
                    Utils.log('Location updated:', location);
                    App.currentLocation = location;

                    // Update iframe directly
                    const settings = Storage.getSettings();
                    const zoom = settings.defaultZoom || CONFIG.DEFAULT_ZOOM;
                    const mapType = settings.mapType || CONFIG.MAP_TYPE;
                    const url = `https://maps.google.com/maps?q=${location.lat},${location.lng}&ll=${location.lat},${location.lng}&z=${zoom}&t=${mapType}&output=embed`;

                    // Hide loading before updating iframe
                    if (UI.elements.loading) {
                        UI.elements.loading.style.display = 'none';
                    }

                    UI.elements.mapIframe.src = url;
                    UI.elements.coordinates.textContent = Utils.formatCoordinates(location.lat, location.lng);

                    Storage.addLocationToHistory(location);
                }
            }, 1500); // Original timing
        },

        updateLocation: () => {
            const location = LocationExtractor.getCurrentLocation();

            if (!location) {
                Utils.log('No location found');
                return;
            }

            // Check if location has changed
            if (App.currentLocation &&
                App.currentLocation.lat === location.lat &&
                App.currentLocation.lng === location.lng) {
                return; // No change
            }

            Utils.log('Location updated:', location);
            App.currentLocation = location;

            // Add to history
            Storage.addLocationToHistory(location);

            // Update map
            App.updateMap(location);
        },

        updateMap: (location = App.currentLocation) => {
            if (!location) {
                Utils.log('Cannot update map: no location available');
                return;
            }

            const settings = Storage.getSettings();
            UI.updateMap(location, settings);
        },

        cleanup: () => {
            if (App.updateInterval) {
                clearInterval(App.updateInterval);
            }
            LocationExtractor.cleanup();
        }
    };

    /* ==========================================
       INITIALIZATION
       ========================================== */

    // Multiple initialization strategies for reliability
    const initializeScript = () => {
        Utils.log('DOM ready, initializing...');

        // Give the page a moment to fully load
        setTimeout(() => {
            App.initialize();
        }, 500);
    };

    // Try multiple initialization methods
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeScript);
    } else if (document.readyState === 'interactive' || document.readyState === 'complete') {
        initializeScript();
    }

    // Fallback: also try on window load
    window.addEventListener('load', () => {
        if (!App.isInitialized) {
            Utils.log('Initializing via window.load fallback...');
            initializeScript();
        }
    });

    // Cleanup on page unload
    window.addEventListener('beforeunload', App.cleanup);

    // Always expose to console for debugging (helps troubleshooting)
    window.OpenGuessrEnhanced = {
        App,
        UI,
        LocationExtractor,
        Storage,
        Utils,
        CONFIG,
        // Helper function to manually open
        open: () => UI.show(),
        // Helper function to check status
        status: () => {
            console.log('Initialized:', App.isInitialized);
            console.log('Container exists:', !!UI.elements.container);
            console.log('Current location:', App.currentLocation);
            console.log('Settings:', Storage.getSettings());
        }
    };

    // Log script load
    console.log('%c🎯 OpenGuessr Pro Enhanced v18.0.0 loaded!', 'color: #8b5cf6; font-weight: bold; font-size: 14px;');
    console.log('%cPress INSERT key to open/close', 'color: #10b981; font-size: 12px;');
    console.log('%cType OpenGuessrEnhanced.status() for debug info', 'color: #6b7280; font-size: 11px;');

})();

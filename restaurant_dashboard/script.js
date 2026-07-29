// FoodPANDA Restaurant Intelligence — enhanced liquid-glass experience
'use strict';

let DATA = null;
let allRestaurants = [];
let allDishes = [];
let filteredItems = [];
let currentView = localStorage.getItem('fp_view') || 'restaurants';
let currentLocation = Number(localStorage.getItem('fp_location') || 0);
let searchQuery = '';
let activeCuisine = '';
let sortOption = localStorage.getItem('fp_sort') || 'distance';
let activeIntelFilter = '';
let gridCols = clamp(Number(localStorage.getItem('fp_grid_cols') || 3), 2, 6);
let showFavoritesOnly = false;
let analyticsRendered = false;
let currentModalRestaurantId = null;
let comparisonMode = false;
let trayDismissed = false;
let focusSnapshot = null;
let commandIndex = 0;
let commandMatches = [];
let activePriceFilter = localStorage.getItem('fp_price_filter') || '';
let customDropPct = clamp(Number(localStorage.getItem('fp_custom_drop') || 12), 1, 95);
let newDays = clamp(Number(localStorage.getItem('fp_new_days') || 7), 1, 365);
let newRangeFrom = localStorage.getItem('fp_new_range_from') || '';
let newRangeTo = localStorage.getItem('fp_new_range_to') || '';
let meanDateFrom = localStorage.getItem('fp_mean_from') || '';
let meanDateTo = localStorage.getItem('fp_mean_to') || '';
let visibleLimit = 60;
let lastRenderSignature = '';
let currentDishId = null;
let dishHistoryChart = null;
let dishSwipeStartX = null;
let restaurantsByLocation = [];
let dishesByLocation = [];
let restaurantById = new Map();
let dishById = new Map();
let dishBudgetThresholds = new Map();

const storedFavorites = safeJSON(localStorage.getItem('fp_favorites'), []);
const favorites = new Set(storedFavorites.map(v => String(v).includes(':') ? String(v) : `r:${v}`));
const compareSelection = new Set(safeJSON(localStorage.getItem('fp_compare'), []).map(String));
const cartItems = new Set(safeJSON(localStorage.getItem('fp_cart'), []).map(String));
let priceAlerts = safeJSON(localStorage.getItem('fp_price_alerts'), []).filter(Boolean);

const IMG_BASE = 'https://images.deliveryhero.io';
const FALLBACK_IMAGE = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="#10101a"/><stop offset="1" stop-color="#1c1220"/></linearGradient></defs><rect fill="url(#g)" width="640" height="360"/><circle cx="320" cy="150" r="45" fill="#d70f64" opacity=".25"/><path d="M285 205h70" stroke="#fff" opacity=".3" stroke-width="8" stroke-linecap="round"/><text x="50%" y="78%" text-anchor="middle" fill="#9299aa" font-family="Arial" font-size="24">FoodPANDA</text></svg>')}`;
const chartColors = ['#d70f64','#00d4aa','#f5b942','#ff5267','#8b5cf6','#3b82f6','#ec4899','#06b6d4','#84cc16','#f97316','#a78bfa','#22c55e'];
const chartRegistry = {};
const accentModes = ['berry', 'cyan', 'violet', 'lime'];
const sortCycle = ['distance','rating','reviews','delivery','name_asc','price_asc','price_desc','price_drop','price_rise'];

const theme = localStorage.getItem('fp_theme') || 'amoled';
const density = localStorage.getItem('fp_density') || 'comfortable';
const accent = localStorage.getItem('fp_accent') || 'berry';

document.addEventListener('DOMContentLoaded', init);

async function init() {
    applyTheme(theme, false);
    applyDensity(density, false);
    applyAccent(accent, false);
    updateLoading('Loading restaurant intelligence…', 8);

    try {
        DATA = await loadData();
        if (!Array.isArray(DATA?.locations) || DATA.locations.length === 0) throw new Error('The dataset does not contain any locations.');

        updateLoading('Normalizing restaurants and menus…', 38);
        processData();
        currentLocation = clamp(currentLocation, 0, DATA.locations.length - 1);
        cleanPersistedSelections();

        updateLoading('Building the glass interface…', 70);
        setupEventListeners();
        evaluatePriceAlerts();
        renderLocationTabs();
        syncControlState();
        renderSidebar();
        setView(currentView, { render: false, persist: false });
        renderGrid();
        updateStatsBar(true);
        updateCompareTray();
        updateActionCounts();

        updateLoading('Ready to explore', 100);
        window.setTimeout(() => showLoading(false), 240);
        showToast('success', 'Intelligence ready', `${allRestaurants.length} restaurants and ${allDishes.length} dishes loaded.`);
    } catch (err) {
        showLoading(false);
        console.error(err);
        const grid = document.getElementById('sh-grid');
        grid.innerHTML = emptyStateHTML('Database connection missing', err.message, 'Retry', 'location.reload()');
    }
}

async function loadData() {
    try {
        const [hyparquet, fzstd] = await Promise.all([
            import('https://cdn.jsdelivr.net/npm/hyparquet@1.7.0/+esm'),
            import('https://cdn.jsdelivr.net/npm/fzstd@0.1.1/+esm')
        ]);
        updateLoading('Reading parquet dataset…', 14);
        const resp = await fetch('data.parquet');
        if (!resp.ok) throw new Error('data.parquet not found');
        const buffer = await resp.arrayBuffer();
        updateLoading('Decoding parquet columns…', 26);
        const compressors = {
            ZSTD: (input, outputLength) => fzstd.decompress(input, outputLength ? new Uint8Array(outputLength) : undefined)
        };
        const rows = await new Promise((resolve, reject) => {
            hyparquet.parquetRead({
                file: buffer,
                compressors,
                rowFormat: 'object',
                onComplete: resolve,
                onError: reject
            });
        });
        if (!Array.isArray(rows) || rows.length === 0) throw new Error('Empty parquet');
        updateLoading('Reconstructing dataset…', 34);
        return reconstructFromParquet(rows);
    } catch (e) {
        console.warn('[data] Parquet unavailable, using JSON fallback:', e.message || e);
        updateLoading('Loading JSON dataset…', 14);
        const resp = await fetch('data.json');
        if (!resp.ok) throw new Error('No data.parquet or data.json found. Run the scraper first.');
        return resp.json();
    }
}

function reconstructFromParquet(rows) {
    const locMap = new Map();
    for (const row of rows) {
        const locName = row.loc_name || '';
        if (!locMap.has(locName)) locMap.set(locName, { name: locName, lat: Number(row.loc_lat || 0), lng: Number(row.loc_lng || 0), restMap: new Map() });
        const loc = locMap.get(locName);
        const rid = row.r_id != null ? Number(row.r_id) : 0;
        if (!loc.restMap.has(rid)) {
            loc.restMap.set(rid, {
                id: rid, code: row.r_code || '', name: row.r_name || '', image: row.r_image || '',
                cuisineList: safeJSON(row.r_cuisines, []), cuisineObjects: safeJSON(row.r_cuisineObjects, []),
                primaryCuisine: row.r_primary || '', rating: Number(row.r_rating || 0), reviewCount: Number(row.r_reviews || 0),
                deliveryTime: Number(row.r_delivery || 0), deliveryTimeMax: Number(row.r_deliveryMax || 0), deliveryTimeText: row.r_deliveryText || '',
                distance: Number(row.r_dist || 0), minimumOrder: Number(row.r_minOrder || 0), deliveryFee: Number(row.r_delFee || 0),
                budget: Number(row.r_budget || 0), priceRange: row.r_priceRange || '', hasDiscount: !!row.r_discount,
                discountTags: safeJSON(row.r_discountTags, []), latitude: Number(row.r_lat || 0), longitude: Number(row.r_lng || 0),
                isActive: !!row.r_active, isDeliveryEnabled: !!row.r_delEnabled, isPreorderEnabled: !!row.r_preorder,
                webPath: row.r_webPath || '', redirectionUrl: row.r_redirect || '', isPopular: !!row.r_popular,
                isNew: !!row.r_new, verticalType: safeJSON(row.r_verticalType, []),
                categories: safeJSON(row.r_categories, []), menus: {},
                minOrderValue: Number(row.r_minOrderVal || 0), preparationTime: Number(row.r_prepTime || 0),
                workingHours: safeJSON(row.r_workHours, {})
            });
        }
        const rest = loc.restMap.get(rid);
        if (row.d_id != null) {
            const did = String(row.d_id);
            if (!rest.menus[did]) rest.menus[did] = {
                id: row.d_id, name: row.d_name || '', price: Number(row.d_price || 0), oldPrice: Number(row.d_oldPrice || 0),
                description: row.d_desc || '', image: row.d_image || '', isAvailable: !!row.d_avail,
                isPopular: !!row.d_popular, category: row.d_cat || '', rating: Number(row.d_rating || 0)
            };
        }
    }
    const scrapedAt = rows[0]?.meta_scraped_at || '';
    return {
        locations: [...locMap.values()].map(loc => ({ name: loc.name, lat: loc.lat, lng: loc.lng, restaurants: [...loc.restMap.values()] })),
        scrapedAt
    };
}

function safeJSON(value, fallback) {
    try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}
function clamp(value, min, max) { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)); }
function escapeHTML(value = '') {
    return String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
}
function attr(value = '') { return escapeHTML(value); }
function itemKey(type, id) { return `${type}:${String(id)}`; }
function isFavorite(type, id) { return favorites.has(itemKey(type, id)); }
function isCompared(type, id) { return compareSelection.has(itemKey(type, id)); }
function formatMoney(value) { return `৳${Number(value || 0).toLocaleString('en-US')}`; }
function plural(count, singular, pluralWord = `${singular}s`) { return `${count} ${count === 1 ? singular : pluralWord}`; }
function debounce(fn, wait = 120) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
}

function updateLoading(message, percent) {
    const text = document.getElementById('loading-text');
    const pct = document.getElementById('loading-percent');
    const fill = document.getElementById('loading-track-fill');
    if (text && message) text.textContent = message;
    if (pct) pct.textContent = percent;
    if (fill) fill.style.width = `${percent}%`;
}
function showLoading(show) {
    const element = document.getElementById('loading-spinner');
    if (element) element.classList.toggle('hidden', !show);
}

function processData() {
    allRestaurants = [];
    allDishes = [];
    restaurantsByLocation = DATA.locations.map(() => []);
    dishesByLocation = DATA.locations.map(() => []);
    restaurantById = new Map();
    dishById = new Map();
    dishBudgetThresholds = new Map();
    const usedDishIds = new Set();

    DATA.locations.forEach((location, locationIndex) => {
        (location.restaurants || []).forEach((sourceRestaurant, restaurantIndex) => {
            const r = sourceRestaurant;
            r.id = r.id ?? `${locationIndex}-${restaurantIndex}`;
            r._locationIdx = locationIndex;
            r._locationName = location.name || `Location ${locationIndex + 1}`;
            r._dishList = r.menus ? Object.values(r.menus) : [];
            r._dishCount = r._dishList.length;
            r._isFavorite = isFavorite('r', r.id);
            r._valueScore = calculateRestaurantScore(r);
            r._searchText = `${r.name || ''} ${(r.cuisineList || []).join(' ')} ${r.primaryCuisine || ''}`.toLowerCase();

            r._dishList.forEach((sourceDish, dishIndex) => {
                const dish = sourceDish;
                let resolvedId = String(dish.id ?? dish.productId ?? `${r.id}-${dishIndex}`);
                if (usedDishIds.has(resolvedId)) resolvedId = `${r.id}:${resolvedId}`;
                usedDishIds.add(resolvedId);
                dish.id = resolvedId;
                dish.restaurantId = r.id;
                dish.restaurantName = r.name || 'Unknown restaurant';
                dish.restaurantCode = r.code || '';
                dish.category = dish.category || dish.name?.split(' ').slice(0, 2).join(' ') || 'Other';
                dish._locationIdx = locationIndex;
                dish._isFavorite = isFavorite('d', dish.id);
                dish._restaurant = r;
                dish._discountPct = dish.oldPrice > dish.price && dish.oldPrice > 0 ? Math.round((1 - dish.price / dish.oldPrice) * 100) : 0;
                dish._searchText = `${dish.name || ''} ${dish.restaurantName || ''} ${dish.category || ''} ${(r.cuisineList || []).join(' ')}`.toLowerCase();
                sourceDish._resolvedId = dish.id;
                const history = normalizeDishHistory(dish);
                dish._history = history.points;
                dish._historySource = history.source;
                dish._firstSeen = resolveDishFirstSeen(dish, r);
                dish._metrics = computeDishMetrics(dish);
                allDishes.push(dish);
                dishesByLocation[locationIndex].push(dish);
                dishById.set(String(dish.id), dish);
            });

            allRestaurants.push(r);
            restaurantsByLocation[locationIndex].push(r);
            restaurantById.set(String(r.id), r);
        });
    });
}
function calculateRestaurantScore(r) {
    const rating = clamp((r.rating || 0) / 5, 0, 1) * 45;
    const speed = clamp(1 - ((r.deliveryTime || 60) - 10) / 70, 0, 1) * 24;
    const social = clamp(Math.log10((r.reviewCount || 0) + 1) / 4, 0, 1) * 18;
    const menu = clamp((r._dishCount || 0) / 40, 0, 1) * 8;
    const offer = r.hasDiscount ? 5 : 0;
    return Math.round(rating + speed + social + menu + offer);
}


function numberFrom(...values) {
    for (const value of values) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 0;
}
function dateFrom(...values) {
    for (const value of values) {
        if (!value) continue;
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return null;
}
function dateKey(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function normalizeDishHistory(dish) {
    const raw = dish.priceHistory || dish.price_history || dish.history || dish.historicalPrices || dish.priceRecords || dish.historyData;
    if (!raw) return { points: [], source: 'none' };
    const points = [];
    const addPoint = (dateValue, priceValue) => {
        const date = dateFrom(dateValue);
        const price = numberFrom(priceValue);
        if (date && price) points.push({ date: dateKey(date), price });
    };
    if (Array.isArray(raw)) {
        raw.forEach(entry => {
            if (entry && typeof entry === 'object') {
                addPoint(entry.date || entry.day || entry.timestamp || entry.recordedAt || entry.created_at || entry.datetime,
                    entry.price || entry.actualPrice || entry.actual_price || entry.value || entry.amount || entry.salePrice);
            }
        });
    } else if (raw && typeof raw === 'object') {
        Object.entries(raw).forEach(([date,value]) => addPoint(date, typeof value === 'object' ? (value.price || value.value || value.amount) : value));
    }
    const unique = new Map(points.map(point => [point.date, point]));
    const normalized = [...unique.values()].sort((a,b) => a.date.localeCompare(b.date));
    return { points: normalized, source: normalized.length ? 'real' : 'none' };
}
function getDishDisplayHistory(dish) {
    return Array.isArray(dish?._history) ? dish._history : [];
}
function resolveDishFirstSeen(dish,restaurant) {
    const explicit = dateFrom(dish.firstSeen,dish.first_seen,dish.discoveredAt,dish.createdAt,dish.created_at,dish.addedAt,restaurant?.firstSeen,restaurant?.createdAt);
    if (explicit) return explicit;
    return dateFrom(dish._history?.[0]?.date);
}
function pointsInMeanRange(points) {
    if (!meanDateFrom && !meanDateTo) return points;
    return points.filter(point => (!meanDateFrom || point.date >= meanDateFrom) && (!meanDateTo || point.date <= meanDateTo));
}
function computeDishMetrics(dish) {
    const history = Array.isArray(dish._history) ? dish._history : [];
    const hasHistory = history.length > 0;
    const selected = pointsInMeanRange(history);
    const meanPoints = selected.length ? selected : history;
    const historicalPrices = meanPoints.map(point => Number(point.price)).filter(Number.isFinite);
    const allHistoricalPrices = history.map(point => Number(point.price)).filter(Number.isFinite);
    const current = numberFrom(dish.price, history.at(-1)?.price);
    const previous = hasHistory ? (numberFrom(history.at(-2)?.price) || current) : current;
    const average = historicalPrices.length ? historicalPrices.reduce((sum,value)=>sum+value,0)/historicalPrices.length : current;
    const minimum = allHistoricalPrices.length ? Math.min(...allHistoricalPrices) : current;
    const maximum = allHistoricalPrices.length ? Math.max(...allHistoricalPrices) : current;
    const changePct = hasHistory && previous && Math.abs(previous-current) > .01 ? ((current-previous)/previous)*100 : 0;
    const dealPct = hasHistory && average && average > current ? ((average-current)/average)*100 : 0;
    const firstSeen = dish._firstSeen || resolveDishFirstSeen(dish,dish._restaurant);
    const ageDays = firstSeen ? Math.max(0,Math.floor((Date.now()-firstSeen.getTime())/86400000)) : Infinity;
    const firstKey = firstSeen ? dateKey(firstSeen) : '';
    return {
        current, previous, average, minimum, maximum, changePct, dealPct,
        dropPct:Math.max(0,-changePct), risePct:Math.max(0,changePct),
        hasHistory,
        isAllTimeLow:hasHistory && current <= Math.min(...allHistoricalPrices) + .01,
        ageDays,
        isNew:Number.isFinite(ageDays) && ageDays <= newDays,
        isNewRange:Boolean(firstKey) && (!newRangeFrom || firstKey >= newRangeFrom) && (!newRangeTo || firstKey <= newRangeTo)
    };
}
function refreshDishMetrics(locationIndex = currentLocation) {
    const dishes = dishesByLocation[locationIndex] || [];
    dishes.forEach(dish => { dish._metrics = computeDishMetrics(dish); });
}
function cleanPersistedSelections() {
    const valid = new Set([
        ...allRestaurants.map(r => itemKey('r', r.id)),
        ...allDishes.map(d => itemKey('d', d.id))
    ]);
    [...compareSelection].forEach(key => { if (!valid.has(key)) compareSelection.delete(key); });
    [...cartItems].forEach(id => { if (!dishById.has(String(id))) cartItems.delete(id); });
    priceAlerts = priceAlerts.filter(alert => dishById.has(String(alert.dishId)));
    persistCompare();
    persistCart();
    persistAlerts();
}

function setupEventListeners() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const searchInput = document.getElementById('product-search');
    const sidebarInput = document.getElementById('sidebar-filter');
    const grid = document.getElementById('sh-grid');

    document.getElementById('sidebar-toggle').addEventListener('click', () => {
        sidebar.classList.add('visible');
        overlay.classList.add('active');
    });
    overlay.addEventListener('click', closeSidebar);

    const updateSearch = debounce((value, source) => {
        searchQuery = value.trim().toLowerCase();
        if (source !== 'header') searchInput.value = value;
        if (source !== 'sidebar') sidebarInput.value = value;
        document.getElementById('clear-search').classList.toggle('visible', Boolean(searchQuery));
        if (source === 'header') updateSuggestions(searchQuery); else hideSuggestions();
        renderSidebar();
        renderGrid();
    }, 150);
    searchInput.addEventListener('input', e => updateSearch(e.target.value, 'header'));
    sidebarInput.addEventListener('input', e => updateSearch(e.target.value, 'sidebar'));
    document.getElementById('clear-search').addEventListener('click', () => {
        searchInput.value = '';
        sidebarInput.value = '';
        searchQuery = '';
        hideSuggestions();
        document.getElementById('clear-search').classList.remove('visible');
        renderSidebar(); renderGrid(); searchInput.focus();
    });

    document.getElementById('locationTabs').addEventListener('click', e => {
        const btn = e.target.closest('.location-btn');
        if (!btn) return;
        currentLocation = Number(btn.dataset.loc);
        localStorage.setItem('fp_location', currentLocation);
        activeCuisine = '';
        analyticsRendered = false;
        renderLocationTabs(); renderSidebar(); updateStatsBar();
        if (currentView === 'analytics') loadAnalytics(); else renderGrid();
        closeSidebar();
        showToast('info', 'Location changed', `Now exploring ${DATA.locations[currentLocation]?.name || 'this area'}.`);
    });

    document.querySelectorAll('.view-btn').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));
    document.getElementById('gridSize').addEventListener('input', e => {
        gridCols = Number(e.target.value);
        localStorage.setItem('fp_grid_cols', gridCols);
        document.getElementById('gridSizeVal').textContent = gridCols;
        grid.style.gridTemplateColumns = `repeat(${gridCols}, minmax(0,1fr))`;
    });
    document.getElementById('sort-options').addEventListener('change', e => {
        sortOption = e.target.value;
        localStorage.setItem('fp_sort', sortOption);
        renderGrid();
    });

    document.getElementById('favorites-only-btn').addEventListener('click', () => {
        showFavoritesOnly = !showFavoritesOnly;
        document.getElementById('favorites-only-btn').classList.toggle('active', showFavoritesOnly);
        renderSidebar(); renderGrid();
        showToast('info', showFavoritesOnly ? 'Favorites enabled' : 'Favorites disabled', showFavoritesOnly ? 'Showing only saved picks.' : 'Showing the full catalogue.');
    });
    document.getElementById('select-all-btn').addEventListener('click', favoriteVisibleItems);
    document.getElementById('sort-toggle-btn').addEventListener('click', cycleSort);
    document.getElementById('compare-mode-btn').addEventListener('click', () => setComparisonMode(!comparisonMode));
    document.getElementById('clear-cuisine-btn').addEventListener('click', () => { activeCuisine = ''; renderSidebar(); renderGrid(); });

    document.querySelectorAll('.intel-btn').forEach(btn => btn.addEventListener('click', () => {
        activeIntelFilter = activeIntelFilter === btn.dataset.filter ? '' : btn.dataset.filter;
        syncIntelButtons();
        renderGrid();
    }));
    document.getElementById('price-intelligence-panel').addEventListener('click', e => {
        const button = e.target.closest('[data-price-filter]');
        if (!button) return;
        activePriceFilter = activePriceFilter === button.dataset.priceFilter ? '' : button.dataset.priceFilter;
        localStorage.setItem('fp_price_filter',activePriceFilter);
        syncPriceButtons(); renderGrid();
    });
    document.getElementById('custom-drop-pct').addEventListener('change', e => {
        customDropPct = clamp(Number(e.target.value || 12),1,95); e.target.value = customDropPct;
        localStorage.setItem('fp_custom_drop',customDropPct); refreshDishMetrics(); renderGrid();
    });
    document.getElementById('new-days').addEventListener('change', e => {
        newDays = clamp(Number(e.target.value || 7),1,365); e.target.value = newDays;
        localStorage.setItem('fp_new_days',newDays); refreshDishMetrics(); renderGrid();
    });
    [['new-range-from','from'],['new-range-to','to']].forEach(([id,side]) => document.getElementById(id).addEventListener('change',e => {
        if (side === 'from') newRangeFrom = e.target.value; else newRangeTo = e.target.value;
        localStorage.setItem(side === 'from' ? 'fp_new_range_from' : 'fp_new_range_to',e.target.value);
        refreshDishMetrics(); if (activePriceFilter === 'new_range') renderGrid();
    }));
    [['mean-date-from','from'],['mean-date-to','to']].forEach(([id,side]) => document.getElementById(id).addEventListener('change',e => {
        if (side === 'from') meanDateFrom = e.target.value; else meanDateTo = e.target.value;
        localStorage.setItem(side === 'from' ? 'fp_mean_from' : 'fp_mean_to',e.target.value);
        refreshDishMetrics(); renderGrid(); if (currentDishId != null) renderDishModal();
    }));
    document.getElementById('clear-mean-range').addEventListener('click', () => {
        meanDateFrom = ''; meanDateTo = '';
        localStorage.removeItem('fp_mean_from'); localStorage.removeItem('fp_mean_to');
        document.getElementById('mean-date-from').value = ''; document.getElementById('mean-date-to').value = '';
        refreshDishMetrics(); renderGrid(); if (currentDishId != null) renderDishModal();
    });

    document.getElementById('surprise-btn').addEventListener('click', surpriseMe);
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
    document.getElementById('density-toggle').addEventListener('click', toggleDensity);
    document.getElementById('focus-toggle').addEventListener('click', enterFocusMode);
    document.getElementById('focus-exit').addEventListener('click', () => exitFocusMode(true));
    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement && document.body.classList.contains('focus-mode')) exitFocusMode(false);
    });

    document.getElementById('alerts-btn').addEventListener('click', openAlertsModal);
    document.getElementById('header-compare-btn').addEventListener('click', () => compareSelection.size >= 2 ? openComparison() : setComparisonMode(true));
    document.getElementById('cart-btn').addEventListener('click', openCartModal);
    document.getElementById('stat-total-btn').addEventListener('click', () => { setView('restaurants'); clearFilters({ keepView: true }); });
    document.getElementById('stat-dishes-btn').addEventListener('click', () => setView('dishes'));
    document.getElementById('stat-good-buys-btn').addEventListener('click', () => { setView('dishes'); activePriceFilter = 'good_buy'; localStorage.setItem('fp_price_filter',activePriceFilter); syncPriceButtons(); renderGrid(); });
    document.getElementById('stat-rating-btn').addEventListener('click', () => { setView('restaurants'); sortOption = 'rating'; document.getElementById('sort-options').value = sortOption; activeIntelFilter = 'toprated'; syncIntelButtons(); renderGrid(); });
    document.getElementById('reset-filters-btn').addEventListener('click', () => clearFilters());
    document.getElementById('active-filter-chips').addEventListener('click', handleFilterChipClick);

    grid.addEventListener('click', handleGridClick);
    document.getElementById('cuisine-list').addEventListener('click', e => {
        const item = e.target.closest('.cuisine-item');
        if (!item) return;
        activeCuisine = activeCuisine === item.dataset.cuisine ? '' : item.dataset.cuisine;
        renderSidebar(); renderGrid();
    });

    document.getElementById('search-suggestions').addEventListener('click', e => {
        const item = e.target.closest('.suggestion-item');
        if (!item) return;
        hideSuggestions();
        if (item.dataset.type === 'dish') openDish(item.dataset.id); else openRestaurant(item.dataset.restaurantId);
    });
    document.addEventListener('click', e => { if (!e.target.closest('.search-wrapper')) hideSuggestions(); });

    document.getElementById('scroll-top').addEventListener('click', () => window.scrollTo({top:0,behavior:'smooth'}));
    document.getElementById('scroll-bottom').addEventListener('click', () => window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'}));

    document.getElementById('modal-close').addEventListener('click', closeRestaurantModal);
    document.getElementById('restaurant-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeRestaurantModal(); });
    document.getElementById('modal-menu-search').addEventListener('input', e => renderRestaurantModalBody(e.target.value));
    document.getElementById('modal-body').addEventListener('click', e => {
        const item = e.target.closest('[data-dish-id]');
        if (item) openDish(item.dataset.dishId);
    });
    document.getElementById('modal-favorite').addEventListener('click', () => currentModalRestaurantId != null && toggleFavorite('r', currentModalRestaurantId));
    document.getElementById('modal-compare').addEventListener('click', () => currentModalRestaurantId != null && toggleCompare('r', currentModalRestaurantId));

    document.getElementById('compare-clear').addEventListener('click', clearComparison);
    document.getElementById('compare-exit').addEventListener('click', () => { comparisonMode = false; trayDismissed = true; syncComparisonUI(); updateCompareTray(); });
    document.getElementById('compare-now').addEventListener('click', openComparison);
    document.getElementById('compare-preview').addEventListener('click', e => {
        const btn = e.target.closest('[data-remove-key]');
        if (btn) removeCompareKey(btn.dataset.removeKey);
    });
    document.getElementById('comparison-close').addEventListener('click', closeComparison);
    document.getElementById('comparison-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeComparison(); });

    document.getElementById('dish-modal-close').addEventListener('click', closeDishModal);
    document.getElementById('dish-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeDishModal(); });
    document.getElementById('dish-prev').addEventListener('click', () => cycleDish(-1));
    document.getElementById('dish-next').addEventListener('click', () => cycleDish(1));
    document.getElementById('dish-cart-toggle').addEventListener('click', () => currentDishId != null && toggleCart(currentDishId));
    document.getElementById('dish-favorite-toggle').addEventListener('click', () => currentDishId != null && toggleFavorite('d',currentDishId));
    document.getElementById('dish-compare-toggle').addEventListener('click', () => currentDishId != null && toggleCompare('d',currentDishId));
    document.getElementById('alert-drop-btn').addEventListener('click', () => currentDishId != null && togglePriceAlert(currentDishId,'drop'));
    document.getElementById('alert-rise-btn').addEventListener('click', () => currentDishId != null && togglePriceAlert(currentDishId,'rise'));
    document.querySelector('.dish-tabs').addEventListener('click', e => {
        const tab = e.target.closest('[data-dish-tab]'); if (tab) setDishTab(tab.dataset.dishTab);
    });
    const dishShell = document.getElementById('dish-history-shell');
    dishShell.addEventListener('pointerdown', e => { dishSwipeStartX = e.clientX; }, {passive:true});
    dishShell.addEventListener('pointerup', e => {
        if (dishSwipeStartX == null) return;
        const distance = e.clientX - dishSwipeStartX; dishSwipeStartX = null;
        if (Math.abs(distance) > 65) cycleDish(distance > 0 ? -1 : 1);
    }, {passive:true});

    document.getElementById('alerts-close').addEventListener('click', closeAlertsModal);
    document.getElementById('alerts-modal').addEventListener('click',e => { if (e.target === e.currentTarget) closeAlertsModal(); });
    document.getElementById('alerts-list').addEventListener('click', e => {
        const button = e.target.closest('[data-remove-alert]'); if (button) removePriceAlert(button.dataset.removeAlert);
    });
    document.getElementById('cart-close').addEventListener('click', closeCartModal);
    document.getElementById('cart-modal').addEventListener('click',e => { if (e.target === e.currentTarget) closeCartModal(); });
    document.getElementById('cart-clear').addEventListener('click', clearCart);
    document.getElementById('cart-list').addEventListener('click', e => {
        const button = e.target.closest('[data-remove-cart]'); if (button) toggleCart(button.dataset.removeCart);
        const row = e.target.closest('[data-open-dish]'); if (row && !button) openDish(row.dataset.openDish);
    });

    document.getElementById('command-open').addEventListener('click', openCommandPalette);
    document.getElementById('command-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeCommandPalette(); });
    document.getElementById('command-search').addEventListener('input', renderCommands);
    document.getElementById('command-list').addEventListener('click', e => {
        const item = e.target.closest('.command-item'); if (item) runCommand(Number(item.dataset.index));
    });

    document.getElementById('refresh-analytics-btn').addEventListener('click', () => { analyticsRendered = false; loadAnalytics(); showToast('success','Analytics refreshed','All charts were rebuilt from the current location.'); });
    document.addEventListener('keydown', handleKeyboard);
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('visible');
    document.getElementById('sidebar-overlay').classList.remove('active');
}

function syncControlState() {
    document.getElementById('gridSize').value = gridCols;
    document.getElementById('gridSizeVal').textContent = gridCols;
    document.getElementById('sort-options').value = sortCycle.includes(sortOption) ? sortOption : 'distance';
    document.getElementById('custom-drop-pct').value = customDropPct;
    document.getElementById('new-days').value = newDays;
    document.getElementById('new-range-from').value = newRangeFrom;
    document.getElementById('new-range-to').value = newRangeTo;
    document.getElementById('mean-date-from').value = meanDateFrom;
    document.getElementById('mean-date-to').value = meanDateTo;
    syncIntelButtons();
    syncPriceButtons();
    syncComparisonUI();
    updateActionCounts();
}
function syncIntelButtons() {
    document.querySelectorAll('.intel-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === activeIntelFilter));
}
function syncPriceButtons() {
    document.querySelectorAll('[data-price-filter]').forEach(btn => btn.classList.toggle('active',btn.dataset.priceFilter === activePriceFilter));
}
function syncComparisonUI() {
    document.getElementById('compare-mode-btn').classList.toggle('active', comparisonMode);
    document.querySelectorAll('.card-action-btn.compare').forEach(btn => btn.classList.toggle('active', compareSelection.has(btn.dataset.key)));
    document.querySelectorAll('.rest-card,.dish-card').forEach(card => card.classList.toggle('card-selected', compareSelection.has(card.dataset.key)));
    updateActionCounts();
}

function setView(view, options = {}) {
    if (!['restaurants','dishes','analytics'].includes(view)) view = 'restaurants';
    currentView = view;
    if (options.persist !== false) localStorage.setItem('fp_view', currentView);
    document.querySelectorAll('.view-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === currentView));
    document.querySelectorAll('#sort-options option[value="price_drop"],#sort-options option[value="price_rise"]').forEach(option => { option.disabled = currentView !== 'dishes'; });
    if (currentView !== 'dishes' && ['price_drop','price_rise'].includes(sortOption)) {
        sortOption = 'distance'; document.getElementById('sort-options').value = sortOption; localStorage.setItem('fp_sort',sortOption);
    }
    const titles = { restaurants: 'Restaurant Radar', dishes: 'Dish Discovery', analytics: 'Market Intelligence' };
    document.getElementById('current-view-title').textContent = titles[currentView];
    const grid = document.getElementById('sh-grid');
    const analytics = document.getElementById('analytics-panel');
    const resultsToolbar = document.querySelector('.results-toolbar');
    const pricePanel = document.getElementById('price-intelligence-panel');
    pricePanel.hidden = currentView !== 'dishes';
    if (currentView === 'analytics') {
        resultsToolbar.style.display = 'none';
        grid.style.display = 'none';
        analytics.hidden = false;
        if (!analyticsRendered || options.refresh) loadAnalytics();
    } else {
        resultsToolbar.style.display = 'flex';
        analytics.hidden = true;
        grid.style.display = 'grid';
        if (options.render !== false) renderGrid();
    }
}

function getFilteredRestaurants() {
    let items = (restaurantsByLocation[currentLocation] || []).filter(r => {
        if (searchQuery && !r._searchText.includes(searchQuery)) return false;
        if (showFavoritesOnly && !r._isFavorite) return false;
        if (activeCuisine && !(r.cuisineList || []).includes(activeCuisine)) return false;
        if (activeIntelFilter === 'popular' && !r.isPopular) return false;
        if (activeIntelFilter === 'fast' && (r.deliveryTime || 999) > 30) return false;
        if (activeIntelFilter === 'toprated' && (r.rating || 0) < 4) return false;
        if (activeIntelFilter === 'hasmenu' && !r._dishCount) return false;
        if (activeIntelFilter === 'discount' && !r.hasDiscount) return false;
        if (activeIntelFilter === 'new' && !r.isNew) return false;
        if (activeIntelFilter === 'budget' && (r.budget || 99) > 2) return false;
        if (activeIntelFilter === 'preorder' && !r.isPreorderEnabled) return false;
        return true;
    });
    sortRestaurants(items);
    return items;
}

function getFilteredDishes() {
    let items = (dishesByLocation[currentLocation] || []).filter(d => {
        if (searchQuery && !d._searchText.includes(searchQuery)) return false;
        if (showFavoritesOnly && !d._isFavorite) return false;
        if (activeCuisine && !(d._restaurant?.cuisineList || []).includes(activeCuisine) && d.category !== activeCuisine) return false;
        const r = d._restaurant;
        const m = d._metrics;
        if (activeIntelFilter === 'discount' && !d._discountPct) return false;
        if (activeIntelFilter === 'popular' && !r?.isPopular) return false;
        if (activeIntelFilter === 'fast' && (r?.deliveryTime || 999) > 30) return false;
        if (activeIntelFilter === 'toprated' && (r?.rating || 0) < 4) return false;
        if (activeIntelFilter === 'new' && !m.isNew) return false;
        if (activeIntelFilter === 'budget' && (d.price || 0) > getDishBudgetThreshold()) return false;
        if (activeIntelFilter === 'preorder' && !r?.isPreorderEnabled) return false;
        if (activePriceFilter === 'great_deal' && m.dealPct < 15) return false;
        if (activePriceFilter === 'good_buy' && m.dealPct < 5) return false;
        if (activePriceFilter === 'custom_drop' && m.dropPct < customDropPct) return false;
        if (activePriceFilter === 'wait' && !(m.current > m.average * 1.05)) return false;
        if (activePriceFilter === 'all_time_low' && !m.isAllTimeLow) return false;
        if (activePriceFilter === 'new_items' && !m.isNew) return false;
        if (activePriceFilter === 'new_range' && !m.isNewRange) return false;
        if (activePriceFilter === 'price_change' && Math.abs(m.changePct) < .01) return false;
        return true;
    });
    sortDishes(items);
    return items;
}

function getDishBudgetThreshold() {
    if (dishBudgetThresholds.has(currentLocation)) return dishBudgetThresholds.get(currentLocation);
    const prices = (dishesByLocation[currentLocation] || []).map(d => Number(d.price)).filter(price => price > 0).sort((a,b) => a-b);
    const threshold = prices.length ? prices[Math.floor(prices.length * .35)] : 300;
    dishBudgetThresholds.set(currentLocation, threshold);
    return threshold;
}
function sortRestaurants(items) {
    const sortFns = {
        distance: (a,b) => (a.distance ?? 999) - (b.distance ?? 999),
        rating: (a,b) => (b.rating || 0) - (a.rating || 0) || (b.reviewCount || 0) - (a.reviewCount || 0),
        reviews: (a,b) => (b.reviewCount || 0) - (a.reviewCount || 0),
        delivery: (a,b) => (a.deliveryTime ?? 999) - (b.deliveryTime ?? 999),
        name_asc: (a,b) => String(a.name).localeCompare(String(b.name)),
        price_asc: (a,b) => (a.budget || 99) - (b.budget || 99),
        price_desc: (a,b) => (b.budget || 0) - (a.budget || 0)
    };
    items.sort(sortFns[sortOption] || sortFns.distance);
}
function sortDishes(items) {
    if (activeIntelFilter === 'discount' && !['price_drop','price_rise'].includes(sortOption)) return items.sort((a,b) => b._discountPct - a._discountPct || (a.price || 0) - (b.price || 0));
    const sortFns = {
        distance: (a,b) => (a._restaurant?.distance ?? 999) - (b._restaurant?.distance ?? 999),
        rating: (a,b) => (b._restaurant?.rating || 0) - (a._restaurant?.rating || 0),
        reviews: (a,b) => (b._restaurant?.reviewCount || 0) - (a._restaurant?.reviewCount || 0),
        delivery: (a,b) => (a._restaurant?.deliveryTime ?? 999) - (b._restaurant?.deliveryTime ?? 999),
        name_asc: (a,b) => String(a.name).localeCompare(String(b.name)),
        price_asc: (a,b) => (a.price || 0) - (b.price || 0),
        price_desc: (a,b) => (b.price || 0) - (a.price || 0),
        price_drop: (a,b) => (b._metrics?.dropPct || 0) - (a._metrics?.dropPct || 0) || (b._metrics?.dealPct || 0) - (a._metrics?.dealPct || 0),
        price_rise: (a,b) => (b._metrics?.risePct || 0) - (a._metrics?.risePct || 0) || (b.price || 0) - (a.price || 0)
    };
    items.sort(sortFns[sortOption] || sortFns.name_asc);
}

function renderLocationTabs() {
    const tabs = document.getElementById('locationTabs');
    tabs.innerHTML = DATA.locations.map((loc, index) => `<button class="location-btn ${index === currentLocation ? 'active' : ''}" data-loc="${index}"><i class="fas fa-location-dot"></i>${escapeHTML(loc.name || `Location ${index + 1}`)}</button>`).join('');
}

function renderSidebar() {
    const locRestaurants = restaurantsByLocation[currentLocation] || [];
    const cuisineCounts = {};
    locRestaurants.forEach(r => (r.cuisineList || []).forEach(c => cuisineCounts[c] = (cuisineCounts[c] || 0) + 1));
    const matches = Object.entries(cuisineCounts)
        .filter(([name]) => !searchQuery || name.toLowerCase().includes(searchQuery) || locRestaurants.some(r => r.name?.toLowerCase().includes(searchQuery) && r.cuisineList?.includes(name)))
        .sort((a,b) => b[1] - a[1]);

    document.getElementById('cuisine-list').innerHTML = matches.length ? matches.map(([name,count]) => `
        <li class="cuisine-item ${activeCuisine === name ? 'active' : ''}" data-cuisine="${attr(name)}">
            <span>${escapeHTML(name)}</span><span class="cuisine-count">${count}</span>
        </li>`).join('') : `<li class="recent-empty">No matching cuisines</li>`;

    const favoriteCount = locRestaurants.filter(r => r._isFavorite).length;
    const avgScore = locRestaurants.length ? Math.round(locRestaurants.reduce((sum,r) => sum + r._valueScore, 0) / locRestaurants.length) : 0;
    document.getElementById('sidebar-stats').innerHTML = `
        <div class="sidebar-stat"><b>${locRestaurants.length}</b><span>Restaurants</span></div>
        <div class="sidebar-stat"><b>${favoriteCount}</b><span>Favorites</span></div>
        <div class="sidebar-stat"><b>${avgScore}</b><span>Avg fit score</span></div>
        <div class="sidebar-stat"><b>${compareSelection.size}</b><span>Compared</span></div>`;
}

function updateStatsBar(instant = true) {
    const restaurants = restaurantsByLocation[currentLocation] || [];
    const dishes = dishesByLocation[currentLocation] || [];
    const discountCount = restaurants.filter(r => r.hasDiscount).length;
    const avgRating = restaurants.length ? restaurants.reduce((sum,r) => sum + (r.rating || 0), 0) / restaurants.length : 0;
    animateValue('total-items', restaurants.length, 0, instant);
    animateValue('total-dishes', dishes.length, 0, instant);
    animateValue('discount-count', discountCount, 0, instant);
    animateValue('average-rating', avgRating, 1, instant);
}
function animateValue(id, target, decimals = 0, instant = false) {
    const el = document.getElementById(id);
    if (!el) return;
    if (instant || matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.textContent = Number(target).toFixed(decimals); return;
    }
    const start = Number(el.textContent) || 0;
    const duration = 480;
    const started = performance.now();
    el.classList.remove('counting'); void el.offsetWidth; el.classList.add('counting');
    const step = now => {
        const t = Math.min(1, (now - started) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = (start + (target - start) * eased).toFixed(decimals);
        if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

function renderGrid() {
    if (currentView === 'analytics') return;
    const grid = document.getElementById('sh-grid');
    const signature = [currentView,currentLocation,searchQuery,activeCuisine,sortOption,activeIntelFilter,activePriceFilter,showFavoritesOnly,customDropPct,newDays,newRangeFrom,newRangeTo,meanDateFrom,meanDateTo].join('|');
    if (signature !== lastRenderSignature) { visibleLimit = 60; lastRenderSignature = signature; }
    const items = currentView === 'restaurants' ? getFilteredRestaurants() : getFilteredDishes();
    filteredItems = items;
    grid.style.gridTemplateColumns = `repeat(${gridCols}, minmax(0,1fr))`;
    if (!items.length) {
        grid.innerHTML = emptyStateHTML('Nothing matched this combination', 'Try clearing a filter, changing location, or searching a broader term.', 'Reset filters', 'clearFilters()');
    } else {
        const visible = items.slice(0,visibleLimit);
        grid.innerHTML = visible.map((item,index) => currentView === 'restaurants' ? createRestaurantCard(item,index) : createDishCard(item,index)).join('') +
            (visible.length < items.length ? `<button class="load-more-card" data-action="load-more"><i class="fas fa-plus"></i><strong>Load ${Math.min(60,items.length-visible.length)} more</strong><span>${visible.length} of ${items.length} shown</span></button>` : '');
    }
    updateResultsToolbar(items.length);
    syncComparisonUI();
    updateActionCounts();
}

function restaurantImage(r) { return r.image || `${IMG_BASE}/image/fd-bd/LH/${encodeURIComponent(r.code || '')}-listing.jpg`; }
function restaurantInsight(r) {
    if (r.hasDiscount && r.deliveryTime <= 30) return 'Strong offer with quick delivery';
    if (r.rating >= 4.5 && r.reviewCount >= 100) return 'Highly trusted by local diners';
    if (r._dishCount >= 30) return 'Large menu with plenty of choice';
    if (r.deliveryTime && r.deliveryTime <= 20) return 'One of the fastest nearby options';
    if ((r.budget || 99) <= 1) return 'Budget-friendly pick';
    return `${r._dishCount || 0} indexed dishes to explore`;
}
function motionClass() { return ''; }
function createRestaurantCard(r,index) {
    const key = itemKey('r',r.id);
    const image = restaurantImage(r);
    const cuisines = (r.cuisineList || []).slice(0,3).join(', ') || 'Various cuisines';
    const priceRange = r.priceRange || '৳'.repeat(clamp(r.budget || 1,1,4));
    const badges = [
        r.primaryCuisine ? `<span class="badge badge-cuisine">${escapeHTML(r.primaryCuisine)}</span>` : '',
        r.hasDiscount ? '<span class="badge badge-discount"><i class="fas fa-tag"></i> Offer</span>' : '',
        r.isPopular ? '<span class="badge badge-popular"><i class="fas fa-fire"></i> Popular</span>' : '',
        r.isNew ? '<span class="badge badge-new">New</span>' : ''
    ].filter(Boolean).join('');
    return `
        <article class="rest-card ${motionClass(index)} ${isCompared('r',r.id) ? 'card-selected' : ''}" data-type="r" data-id="${attr(r.id)}" data-key="${attr(key)}" style="--delay:${Math.min(index,18)*24}ms">
            <div class="rest-card-img-wrap">
                <img class="rest-card-img" src="${attr(image)}" loading="lazy" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'" alt="${attr(r.name)}">
                <div class="rest-card-overlay"></div><span class="card-glow-line"></span>
                <div class="rest-card-badges"><div class="card-badge-row">${badges}</div><span class="badge badge-score">Fit ${r._valueScore}</span></div>
                <div class="card-actions">
                    <button class="card-action-btn favorite ${r._isFavorite ? 'active' : ''}" data-action="favorite" aria-label="Favorite ${attr(r.name)}"><i class="fas fa-heart"></i></button>
                    <button class="card-action-btn compare ${isCompared('r',r.id) ? 'active' : ''}" data-action="compare" data-key="${attr(key)}" aria-label="Compare ${attr(r.name)}"><i class="fas fa-scale-balanced"></i></button>
                </div>
            </div>
            <div class="rest-card-body">
                <div class="rest-card-topline"><h3 class="rest-card-name" title="${attr(r.name)}">${escapeHTML(r.name)}</h3><span class="value-score">${r._valueScore}/100</span></div>
                <div class="rest-card-cuisines">${escapeHTML(cuisines)}</div>
                <div class="card-insight"><i class="fas fa-wand-magic-sparkles"></i><span>${escapeHTML(restaurantInsight(r))}</span></div>
                <div class="rest-card-footer">
                    <span class="rest-card-stat rating"><i class="fas fa-star"></i><b>${r.rating ? Number(r.rating).toFixed(1) : 'N/A'}</b><span>rating</span></span>
                    <span class="rest-card-stat distance"><i class="fas fa-location-arrow"></i><b>${r.distance ? `${Number(r.distance).toFixed(1)}km` : 'N/A'}</b><span>away</span></span>
                    <span class="rest-card-stat delivery"><i class="fas fa-bolt"></i><b>${r.deliveryTime ? `${r.deliveryTime}m` : 'N/A'}</b><span>delivery</span></span>
                    <span class="rest-card-stat price"><i class="fas fa-wallet"></i><b>${escapeHTML(priceRange)}</b><span>price</span></span>
                </div>
            </div>
        </article>`;
}

function createDishCard(d,index) {
    const key = itemKey('d',d.id);
    const image = d.image || '';
    const m = d._metrics || computeDishMetrics(d);
    const changeClass = m.changePct < -.01 ? 'down' : m.changePct > .01 ? 'up' : 'flat';
    const changeText = Math.abs(m.changePct) < .01 ? 'No change' : `${m.changePct > 0 ? '+' : ''}${m.changePct.toFixed(1)}%`;
    const badges = [
        m.dealPct >= 15 ? `<span class="dish-price-badge great">Great deal ${Math.round(m.dealPct)}%</span>` : m.dealPct >= 5 ? `<span class="dish-price-badge good">Good buy ${Math.round(m.dealPct)}%</span>` : '',
        m.isAllTimeLow ? '<span class="dish-price-badge low">All-time low</span>' : '',
        m.isNew ? `<span class="dish-price-badge new">New ${m.ageDays}d</span>` : ''
    ].filter(Boolean).join('');
    return `
        <article class="dish-card ${isCompared('d',d.id) ? 'card-selected' : ''}" data-type="d" data-id="${attr(d.id)}" data-restaurant-id="${attr(d.restaurantId)}" data-key="${attr(key)}">
            <div class="dish-card-img-wrap">
                ${image ? `<img class="dish-card-img" src="${attr(image)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'" alt="${attr(d.name)}">` : '<div class="dish-placeholder"><i class="fas fa-bowl-food"></i></div>'}
                <div class="dish-badge-stack">${badges}</div>
                ${m.hasHistory ? `<span class="dish-change-chip ${changeClass}"><i class="fas ${changeClass === 'down' ? 'fa-arrow-down' : changeClass === 'up' ? 'fa-arrow-up' : 'fa-minus'}"></i>${changeText}</span>` : ''}
                <div class="card-actions dish-actions">
                    <button class="card-action-btn cart ${isInCart(d.id) ? 'active' : ''}" data-action="cart" aria-label="Add ${attr(d.name)} to cart"><i class="fas fa-cart-shopping"></i></button>
                    <button class="card-action-btn alert ${hasAnyAlert(d.id) ? 'active' : ''}" data-action="alert" aria-label="Price alerts for ${attr(d.name)}"><i class="fas fa-bell"></i></button>
                    <button class="card-action-btn favorite ${d._isFavorite ? 'active' : ''}" data-action="favorite" aria-label="Favorite ${attr(d.name)}"><i class="fas fa-heart"></i></button>
                    <button class="card-action-btn compare ${isCompared('d',d.id) ? 'active' : ''}" data-action="compare" data-key="${attr(key)}" aria-label="Compare ${attr(d.name)}"><i class="fas fa-scale-balanced"></i></button>
                </div>
            </div>
            <div class="dish-card-body">
                <h3 class="dish-card-name" title="${attr(d.name)}">${escapeHTML(d.name)}</h3>
                <div class="dish-card-restaurant">${escapeHTML(d.restaurantName)}</div>
                <div class="dish-card-footer">
                    <div><span class="dish-card-price"><span class="currency">৳</span>${Number(d.price || 0).toLocaleString('en-US')}</span>${d.oldPrice > d.price ? `<span class="dish-card-old-price">${formatMoney(d.oldPrice)}</span>` : ''}</div>
                    <span class="dish-card-category">${escapeHTML(d.category || 'Other')}</span>
                </div>
                <div class="dish-card-intel">${m.hasHistory ? `<span>Mean ${formatMoney(m.average)}</span><span>Low ${formatMoney(m.minimum)}</span>` : `<span>${d.oldPrice > d.price ? `Was ${formatMoney(d.oldPrice)}` : 'No recorded history'}</span><span>${m.changePct ? `${m.changePct > 0 ? '+' : ''}${m.changePct.toFixed(1)}%` : 'Current price only'}</span>`}</div>
            </div>
        </article>`;
}

function emptyStateHTML(title, message, buttonText, action) {
    return `<div class="empty-state"><div class="empty-state-card"><div class="empty-state-icon"><i class="fas fa-compass"></i></div><h3>${escapeHTML(title)}</h3><p>${escapeHTML(message)}</p><button onclick="${action}">${escapeHTML(buttonText)}</button></div></div>`;
}

function updateResultsToolbar(count) {
    document.getElementById('results-count').textContent = currentView === 'dishes' ? plural(count,'dish','dishes') : plural(count,'restaurant');
    const locationName = DATA.locations[currentLocation]?.name || 'current area';
    document.getElementById('results-context').textContent = `${locationName} · sorted by ${sortLabel(sortOption)}`;
    const chips = [];
    if (searchQuery) chips.push({key:'search',label:`Search: ${searchQuery}`});
    if (activeCuisine) chips.push({key:'cuisine',label:activeCuisine});
    if (activeIntelFilter) chips.push({key:'intel',label:filterLabel(activeIntelFilter)});
    if (activePriceFilter) chips.push({key:'price',label:priceFilterLabel(activePriceFilter)});
    if (meanDateFrom || meanDateTo) chips.push({key:'mean',label:`Mean: ${meanDateFrom || 'start'} → ${meanDateTo || 'today'}`});
    if (showFavoritesOnly) chips.push({key:'favorites',label:'Favorites only'});
    document.getElementById('active-filter-chips').innerHTML = chips.map(chip => `<span class="filter-chip">${escapeHTML(chip.label)}<button data-clear="${chip.key}" aria-label="Remove filter"><i class="fas fa-times"></i></button></span>`).join('');
}
function sortLabel(value) {
    return ({distance:'nearest',rating:'rating',reviews:'review count',delivery:'delivery speed',name_asc:'name',price_asc:'lowest price',price_desc:'highest price',price_drop:'biggest price drop',price_rise:'biggest price rise'})[value] || value;
}
function filterLabel(value) {
    return ({popular:'Popular',fast:'Fast delivery',toprated:'Top rated',hasmenu:'Has menu',discount:'Discounts',new:'New',budget:'Budget',preorder:'Pre-order'})[value] || value;
}
function priceFilterLabel(value) {
    return ({great_deal:'Great Deal 15%+',good_buy:'Good Buy 5%+',custom_drop:`Drop ≥ ${customDropPct}%`,wait:'Wait',all_time_low:'All Time Low',new_items:`New in ${newDays} days`,new_range:'New Only custom range',price_change:'Price Change'})[value] || value;
}
function handleFilterChipClick(e) {
    const btn = e.target.closest('[data-clear]');
    if (!btn) return;
    if (btn.dataset.clear === 'search') {
        searchQuery = ''; document.getElementById('product-search').value = ''; document.getElementById('sidebar-filter').value = ''; document.getElementById('clear-search').classList.remove('visible');
    }
    if (btn.dataset.clear === 'cuisine') activeCuisine = '';
    if (btn.dataset.clear === 'intel') { activeIntelFilter = ''; syncIntelButtons(); }
    if (btn.dataset.clear === 'price') { activePriceFilter = ''; localStorage.removeItem('fp_price_filter'); syncPriceButtons(); }
    if (btn.dataset.clear === 'mean') {
        meanDateFrom = ''; meanDateTo = ''; localStorage.removeItem('fp_mean_from'); localStorage.removeItem('fp_mean_to');
        document.getElementById('mean-date-from').value = ''; document.getElementById('mean-date-to').value = ''; refreshDishMetrics();
    }
    if (btn.dataset.clear === 'favorites') { showFavoritesOnly = false; document.getElementById('favorites-only-btn').classList.remove('active'); }
    renderSidebar(); renderGrid();
}

function handleGridClick(e) {
    const loadMore = e.target.closest('[data-action="load-more"]');
    if (loadMore) { visibleLimit += 60; renderGrid(); return; }
    const card = e.target.closest('.rest-card,.dish-card');
    if (!card) return;
    const action = e.target.closest('[data-action]')?.dataset.action;
    const type = card.dataset.type;
    const id = card.dataset.id;
    if (action === 'favorite') { e.stopPropagation(); toggleFavorite(type,id); return; }
    if (action === 'compare') { e.stopPropagation(); toggleCompare(type,id); return; }
    if (action === 'cart') { e.stopPropagation(); toggleCart(id); return; }
    if (action === 'alert') { e.stopPropagation(); openDish(id); setDishTab('history'); return; }
    if (comparisonMode) { toggleCompare(type,id); return; }
    if (type === 'd') openDish(id); else openRestaurant(id);
}

function handleCardTilt(e) {
    if (!matchMedia('(pointer:fine)').matches || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const card = e.target.closest('.rest-card,.dish-card');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - .5;
    const y = (e.clientY - rect.top) / rect.height - .5;
    card.style.transform = `perspective(900px) rotateX(${(-y*4).toFixed(2)}deg) rotateY(${(x*5).toFixed(2)}deg) translateY(-4px)`;
}
function resetCardTilt(e) {
    const card = e.target.closest?.('.rest-card,.dish-card');
    if (card) card.style.transform = '';
}

function toggleFavorite(type,id) {
    const key = itemKey(type,id);
    const adding = !favorites.has(key);
    if (adding) favorites.add(key); else favorites.delete(key);
    localStorage.setItem('fp_favorites', JSON.stringify([...favorites]));
    const entry = type === 'r' ? restaurantById.get(String(id)) : dishById.get(String(id));
    if (entry) entry._isFavorite = adding;
    renderSidebar(); renderGrid();
    updateModalActions();
    updateDishActionStates();
    showToast(adding ? 'success' : 'info', adding ? 'Saved to favorites' : 'Removed from favorites', entry?.name || 'Selection updated.');
}
function favoriteVisibleItems() {
    const items = currentView === 'dishes' ? getFilteredDishes() : getFilteredRestaurants();
    const type = currentView === 'dishes' ? 'd' : 'r';
    items.forEach(item => { favorites.add(itemKey(type,item.id)); item._isFavorite = true; });
    localStorage.setItem('fp_favorites', JSON.stringify([...favorites]));
    renderSidebar(); renderGrid();
    showToast('success','Visible items saved',`${items.length} ${currentView === 'dishes' ? 'dishes' : 'restaurants'} added to favorites.`);
}

function cycleSort() {
    const availableSorts = currentView === 'dishes' ? sortCycle : sortCycle.filter(value => !['price_drop','price_rise'].includes(value));
    const index = availableSorts.indexOf(sortOption);
    sortOption = availableSorts[(index + 1) % availableSorts.length];
    document.getElementById('sort-options').value = sortOption;
    localStorage.setItem('fp_sort',sortOption);
    renderGrid();
    showToast('info','Sorting changed',`Results are now sorted by ${sortLabel(sortOption)}.`);
}

function clearFilters(options = {}) {
    searchQuery = ''; activeCuisine = ''; activeIntelFilter = ''; activePriceFilter = ''; showFavoritesOnly = false;
    document.getElementById('product-search').value = '';
    document.getElementById('sidebar-filter').value = '';
    document.getElementById('clear-search').classList.remove('visible');
    document.getElementById('favorites-only-btn').classList.remove('active');
    localStorage.removeItem('fp_price_filter'); syncIntelButtons(); syncPriceButtons(); hideSuggestions();
    if (!options.keepView && currentView === 'analytics') setView('restaurants',{render:false});
    renderSidebar(); renderGrid();
    showToast('info','Filters reset','You are back to the complete location view.');
}

function updateSuggestions(query) {
    const box = document.getElementById('search-suggestions');
    if (!query || query.length < 2) return hideSuggestions();
    const restaurants = (restaurantsByLocation[currentLocation] || []).filter(r => r._searchText.includes(query)).slice(0,5);
    const dishes = (dishesByLocation[currentLocation] || []).filter(d => d._searchText.includes(query)).slice(0,5);
    if (!restaurants.length && !dishes.length) return hideSuggestions();
    box.innerHTML = [
        ...restaurants.map(r => `<button class="suggestion-item" data-type="restaurant" data-restaurant-id="${attr(r.id)}"><span class="suggestion-main"><img class="suggestion-thumb" src="${attr(restaurantImage(r))}" onerror="this.src='${FALLBACK_IMAGE}'" alt=""><span>${escapeHTML(r.name)}<small>${escapeHTML((r.cuisineList || []).slice(0,2).join(' · ') || 'Restaurant')}</small></span></span><span class="suggestion-type restaurant">Place</span></button>`),
        ...dishes.map(d => `<button class="suggestion-item" data-type="dish" data-id="${attr(d.id)}" data-restaurant-id="${attr(d.restaurantId)}"><span class="suggestion-main">${d.image ? `<img class="suggestion-thumb" src="${attr(d.image)}" onerror="this.src='${FALLBACK_IMAGE}'" alt="">` : '<span class="suggestion-thumb"></span>'}<span>${escapeHTML(d.name)}<small>${escapeHTML(d.restaurantName)}</small></span></span><span class="suggestion-type dish">Dish</span></button>`)
    ].join('');
    box.style.display = 'block';
}
function hideSuggestions() { const box = document.getElementById('search-suggestions'); if (box) box.style.display = 'none'; }

function openRestaurant(id) {
    const r = restaurantById.get(String(id));
    if (!r) return;
    currentModalRestaurantId = r.id;
    document.getElementById('modal-restaurant-name').textContent = r.name;
    document.getElementById('modal-meta').innerHTML = `
        <span class="modal-meta-item"><i class="fas fa-star" style="color:var(--gold)"></i>${r.rating ? Number(r.rating).toFixed(1) : 'N/A'} · ${(r.reviewCount || 0).toLocaleString('en-US')} reviews</span>
        <span class="modal-meta-item"><i class="fas fa-bolt" style="color:var(--accent-secondary)"></i>${r.deliveryTime ? `${r.deliveryTime}-${r.deliveryTimeMax || r.deliveryTime + 20} min` : 'Time unavailable'}</span>
        <span class="modal-meta-item"><i class="fas fa-location-arrow"></i>${r.distance ? `${Number(r.distance).toFixed(1)} km` : 'Distance unavailable'}</span>
        <span class="modal-meta-item"><i class="fas fa-wallet"></i>Minimum ${formatMoney(r.minimumOrder || r.minOrderValue || 0)}</span>
        <span class="modal-meta-item"><i class="fas fa-motorcycle"></i>Delivery ${formatMoney(r.deliveryFee || 0)}</span>
        ${(r.cuisineList || []).slice(0,5).map(c => `<span class="badge badge-cuisine">${escapeHTML(c)}</span>`).join('')}`;
    document.getElementById('modal-menu-search').value = '';
    renderRestaurantModalBody('');
    updateModalActions();
    document.getElementById('restaurant-modal').classList.add('active');
    document.body.style.overflow = 'hidden';
}
function closeRestaurantModal() {
    document.getElementById('restaurant-modal').classList.remove('active');
    currentModalRestaurantId = null;
    restoreBodyScroll();
}
function updateModalActions() {
    if (currentModalRestaurantId == null) return;
    document.getElementById('modal-favorite').classList.toggle('active',isFavorite('r',currentModalRestaurantId));
    document.getElementById('modal-compare').classList.toggle('active',isCompared('r',currentModalRestaurantId));
}
function renderRestaurantModalBody(query = '') {
    const r = restaurantById.get(String(currentModalRestaurantId));
    if (!r) return;
    const normalizedQuery = query.trim().toLowerCase();
    const groups = buildMenuGroups(r).map(group => ({
        ...group,
        items: group.items.filter(item => !normalizedQuery || `${item.name || ''} ${item.description || ''} ${group.name}`.toLowerCase().includes(normalizedQuery))
    })).filter(group => group.items.length);
    const visibleCount = groups.reduce((sum,group) => sum + group.items.length,0);
    document.getElementById('modal-menu-count').textContent = plural(visibleCount,'dish','dishes');
    const summary = `
        <div class="restaurant-summary">
            <div class="summary-tile primary"><span>AI-style fit signal</span><b>${r._valueScore}/100 · ${escapeHTML(restaurantInsight(r))}</b></div>
            <div class="summary-tile"><span>Menu depth</span><b>${r._dishCount || 0} dishes</b></div>
            <div class="summary-tile"><span>Delivery range</span><b>${r.deliveryTime || '—'}–${r.deliveryTimeMax || (r.deliveryTime ? r.deliveryTime + 20 : '—')} min</b></div>
            <div class="summary-tile"><span>Price position</span><b>${escapeHTML(r.priceRange || '৳'.repeat(clamp(r.budget || 1,1,4)))}</b></div>
        </div>`;
    if (!groups.length) {
        document.getElementById('modal-body').innerHTML = summary + `<div class="empty-state-card" style="margin:20px auto"><div class="empty-state-icon"><i class="fas fa-magnifying-glass"></i></div><h3>No dishes matched</h3><p>Try another menu keyword.</p></div>`;
        return;
    }
    document.getElementById('modal-body').innerHTML = summary + groups.map(group => `
        <section class="menu-category"><h3 class="menu-category-name">${escapeHTML(group.name)}<span class="menu-count-pill">${group.items.length}</span></h3><div class="menu-items">${group.items.map(menuItemHTML).join('')}</div></section>`).join('');
}
function buildMenuGroups(r) {
    const menus = r.menus || {};
    const categories = Array.isArray(r.categories) ? r.categories : [];
    const used = new Set();
    const groups = [];
    categories.forEach(category => {
        const items = (category.items || []).map(id => menus[String(id)] || menus[id]).filter(Boolean);
        items.forEach(item => used.add(item));
        if (items.length) groups.push({name:category.name || 'Menu',items});
    });
    const ungrouped = Object.values(menus).filter(item => !used.has(item));
    if (ungrouped.length) {
        const byCategory = {};
        ungrouped.forEach(item => {
            const category = item.category || 'More from the menu';
            (byCategory[category] ||= []).push(item);
        });
        Object.entries(byCategory).forEach(([name,items]) => groups.push({name,items}));
    }
    return groups;
}
function menuItemHTML(item) {
    const discount = item.oldPrice > item.price && item.oldPrice > 0 ? Math.round((1 - item.price / item.oldPrice) * 100) : 0;
    return `<article class="menu-item" data-dish-id="${attr(item._resolvedId || item.id || '')}" tabindex="0">${item.image ? `<img class="menu-item-img" src="${attr(item.image)}" loading="lazy" decoding="async" onerror="this.style.display='none'" alt="">` : ''}<div class="menu-item-info"><h4 class="menu-item-name" title="${attr(item.name)}">${escapeHTML(item.name)}</h4>${item.description ? `<p class="menu-item-desc">${escapeHTML(item.description)}</p>` : ''}<div><span class="menu-item-price">${formatMoney(item.price)}</span>${item.oldPrice > item.price ? `<span class="menu-item-old-price">${formatMoney(item.oldPrice)}</span>` : ''}${discount ? `<span class="menu-item-discount">Save ${discount}%</span>` : ''}</div></div><i class="fas fa-chart-line menu-history-icon" aria-hidden="true"></i></article>`;
}
function setComparisonMode(enabled) {
    comparisonMode = enabled;
    trayDismissed = false;
    syncComparisonUI(); updateCompareTray();
    showToast('info',enabled ? 'Comparison mode on' : 'Comparison mode off',enabled ? 'Tap any 2–6 cards to stage them.' : 'Normal card opening is restored.');
}
function toggleCompare(type,id) {
    const key = itemKey(type,id);
    trayDismissed = false;
    if (compareSelection.has(key)) compareSelection.delete(key);
    else {
        if (compareSelection.size >= 6) return showToast('warning','Comparison tray is full','Remove one selection before adding another.');
        compareSelection.add(key);
    }
    persistCompare(); syncComparisonUI(); updateCompareTray(); renderSidebar(); updateModalActions(); updateDishActionStates();
}
function removeCompareKey(key) { compareSelection.delete(key); persistCompare(); syncComparisonUI(); updateCompareTray(); renderSidebar(); updateModalActions(); updateDishActionStates(); }
function clearComparison() {
    compareSelection.clear(); persistCompare(); trayDismissed = false; syncComparisonUI(); updateCompareTray(); renderSidebar(); updateModalActions(); updateDishActionStates();
    showToast('info','Comparison cleared','The staging tray is empty.');
}
function persistCompare() { localStorage.setItem('fp_compare',JSON.stringify([...compareSelection])); }
function getItemByKey(key) {
    const split = String(key).indexOf(':');
    if (split < 0) return null;
    const type = key.slice(0,split); const id = key.slice(split+1);
    const item = type === 'r' ? restaurantById.get(id) : dishById.get(id);
    return item ? {type,item} : null;
}
function updateCompareTray() {
    updateActionCounts();
    const tray = document.getElementById('compare-tray');
    const entries = [...compareSelection].map(getItemByKey).filter(Boolean);
    const shouldShow = !trayDismissed && (comparisonMode || entries.length > 0);
    tray.classList.toggle('visible',shouldShow);
    document.getElementById('compare-status').textContent = entries.length ? `${entries.length} of 6 selected` : 'Choose 2–6 items';
    document.getElementById('compare-now').disabled = entries.length < 2;
    document.getElementById('compare-preview').innerHTML = entries.map(({type,item}) => {
        const image = type === 'r' ? restaurantImage(item) : item.image;
        return `<div class="compare-preview-item" title="${attr(item.name)}">${image ? `<img src="${attr(image)}" onerror="this.style.display='none'" alt="">` : '<i class="fas fa-bowl-food"></i>'}<button data-remove-key="${attr(itemKey(type,item.id))}" aria-label="Remove ${attr(item.name)}"><i class="fas fa-times"></i></button></div>`;
    }).join('');
}
function openComparison() {
    const entries = [...compareSelection].map(getItemByKey).filter(Boolean);
    if (entries.length < 2) return;
    const restaurants = entries.filter(e => e.type === 'r').map(e => e.item);
    const dishes = entries.filter(e => e.type === 'd').map(e => e.item);
    let html = '';
    if (restaurants.length) {
        const bestScore = Math.max(...restaurants.map(r => r._valueScore));
        html += `<section class="compare-section"><h3>Restaurants</h3><div class="compare-grid">${restaurants.map((r,index) => compareRestaurantHTML(r,index,r._valueScore === bestScore)).join('')}</div></section>`;
    }
    if (dishes.length) {
        const bestDiscount = Math.max(...dishes.map(d => d._discountPct));
        const cheapest = Math.min(...dishes.map(d => d.price || Infinity));
        html += `<section class="compare-section"><h3>Dishes</h3><div class="compare-grid">${dishes.map((d,index) => compareDishHTML(d,index,d._discountPct ? d._discountPct === bestDiscount : d.price === cheapest)).join('')}</div></section>`;
    }
    document.getElementById('comparison-body').innerHTML = html;
    document.getElementById('comparison-modal').classList.add('active');
    document.body.style.overflow = 'hidden';
}
function compareRestaurantHTML(r,index,best) {
    return `<article class="compare-card ${best ? 'best' : ''}" style="--delay:${index*55}ms"><div class="compare-card-head"><img src="${attr(restaurantImage(r))}" onerror="this.src='${FALLBACK_IMAGE}'" alt=""><div><strong>${escapeHTML(r.name)}</strong><span>${escapeHTML((r.cuisineList || []).slice(0,2).join(' · ') || 'Restaurant')}</span></div></div>${[
        ['Fit score',`${r._valueScore}/100`],['Rating',r.rating ? `${Number(r.rating).toFixed(1)} (${(r.reviewCount || 0).toLocaleString('en-US')})` : 'N/A'],['Delivery',r.deliveryTime ? `${r.deliveryTime} min` : 'N/A'],['Distance',r.distance ? `${Number(r.distance).toFixed(1)} km` : 'N/A'],['Menu depth',plural(r._dishCount || 0,'dish','dishes')],['Minimum order',formatMoney(r.minimumOrder || r.minOrderValue || 0)],['Delivery fee',formatMoney(r.deliveryFee || 0)],['Offer',r.hasDiscount ? 'Available' : 'None shown']
    ].map(([label,value]) => `<div class="compare-metric"><span>${label}</span><b>${escapeHTML(value)}</b></div>`).join('')}</article>`;
}
function compareDishHTML(d,index,best) {
    return `<article class="compare-card ${best ? 'best' : ''}" style="--delay:${index*55}ms"><div class="compare-card-head">${d.image ? `<img src="${attr(d.image)}" onerror="this.style.display='none'" alt="">` : '<span class="compare-icon"><i class="fas fa-bowl-food"></i></span>'}<div><strong>${escapeHTML(d.name)}</strong><span>${escapeHTML(d.restaurantName)}</span></div></div>${[
        ['Current price',formatMoney(d.price)],['Previous price',d.oldPrice > d.price ? formatMoney(d.oldPrice) : 'No markdown'],['Savings',d._discountPct ? `${d._discountPct}%` : '—'],['Category',d.category || 'Other'],['Restaurant rating',d._restaurant?.rating ? Number(d._restaurant.rating).toFixed(1) : 'N/A'],['Delivery',d._restaurant?.deliveryTime ? `${d._restaurant.deliveryTime} min` : 'N/A']
    ].map(([label,value]) => `<div class="compare-metric"><span>${label}</span><b>${escapeHTML(value)}</b></div>`).join('')}</article>`;
}
function closeComparison() { document.getElementById('comparison-modal').classList.remove('active'); restoreBodyScroll(); }

function updateActionCounts() {
    const alertsCount = document.getElementById('alerts-count');
    const compareCount = document.getElementById('header-compare-count');
    const cartCount = document.getElementById('cart-count');
    if (alertsCount) alertsCount.textContent = priceAlerts.length;
    if (compareCount) compareCount.textContent = compareSelection.size;
    if (cartCount) cartCount.textContent = cartItems.size;
    const alertsButton = document.getElementById('alerts-btn');
    if (alertsButton) alertsButton.classList.toggle('has-triggered',priceAlerts.some(alert => alert.status === 'triggered'));
}
function restoreBodyScroll() {
    if (!document.querySelector('.modal.active,.command-modal.active')) document.body.style.overflow = '';
}

function isInCart(id) { return cartItems.has(String(id)); }
function persistCart() { localStorage.setItem('fp_cart',JSON.stringify([...cartItems])); }
function updateDishCardAction(id,action,active) {
    document.querySelectorAll('.dish-card').forEach(card => {
        if (String(card.dataset.id) === String(id)) card.querySelector(`.${action}`)?.classList.toggle('active',active);
    });
}
function toggleCart(id,quiet = false) {
    const key = String(id);
    const dish = dishById.get(String(key));
    if (!dish) return;
    const adding = !cartItems.has(key);
    if (adding) cartItems.add(key); else cartItems.delete(key);
    persistCart(); updateActionCounts(); updateDishCardAction(id,'cart',adding); updateDishActionStates();
    if (document.getElementById('cart-modal').classList.contains('active')) renderCart();
    if (!quiet) showToast(adding ? 'success' : 'info',adding ? 'Added to cart' : 'Removed from cart',dish.name);
}
function clearCart() {
    cartItems.clear(); persistCart(); updateActionCounts();
    document.querySelectorAll('.card-action-btn.cart').forEach(button => button.classList.remove('active'));
    updateDishActionStates(); renderCart(); showToast('info','Cart cleared','All saved dishes were removed.');
}
function openCartModal() {
    renderCart(); document.getElementById('cart-modal').classList.add('active'); document.body.style.overflow = 'hidden';
}
function closeCartModal() { document.getElementById('cart-modal').classList.remove('active'); restoreBodyScroll(); }
function renderCart() {
    const dishes = [...cartItems].map(id => dishById.get(String(id))).filter(Boolean);
    const list = document.getElementById('cart-list');
    if (!dishes.length) list.innerHTML = '<div class="manager-empty"><i class="fas fa-cart-shopping"></i><h3>Your cart is empty</h3><p>Add dishes from cards or the price-history view.</p></div>';
    else list.innerHTML = dishes.map(d => `<article class="manager-row" data-open-dish="${attr(d.id)}">${d.image ? `<img src="${attr(d.image)}" loading="lazy" alt="">` : '<span class="manager-row-icon"><i class="fas fa-bowl-food"></i></span>'}<div><strong>${escapeHTML(d.name)}</strong><span>${escapeHTML(d.restaurantName)} · ${escapeHTML(d.category || 'Other')}</span></div><b>${formatMoney(d.price)}</b><button data-remove-cart="${attr(d.id)}" aria-label="Remove"><i class="fas fa-trash"></i></button></article>`).join('');
    document.getElementById('cart-total').textContent = formatMoney(dishes.reduce((sum,dish)=>sum+numberFrom(dish.price),0));
}

function alertKey(dishId,direction) { return `${String(dishId)}:${direction}`; }
function hasAnyAlert(dishId) { return priceAlerts.some(alert => String(alert.dishId) === String(dishId)); }
function hasPriceAlert(dishId,direction) { return priceAlerts.some(alert => alert.id === alertKey(dishId,direction)); }
function persistAlerts() { localStorage.setItem('fp_price_alerts',JSON.stringify(priceAlerts)); }
function togglePriceAlert(dishId,direction) {
    const dish = dishById.get(String(dishId));
    if (!dish) return;
    const id = alertKey(dishId,direction);
    const existing = priceAlerts.findIndex(alert => alert.id === id);
    if (existing >= 0) {
        priceAlerts.splice(existing,1);
        showToast('info','Price alert removed',`${direction === 'drop' ? 'Drop' : 'Rise'} monitor disabled for ${dish.name}.`);
    } else {
        priceAlerts.push({id,dishId:String(dishId),direction,baseline:numberFrom(dish.price),lastSeenPrice:numberFrom(dish.price),createdAt:new Date().toISOString(),status:'watching'});
        showToast('success','Price alert enabled',`Watching ${dish.name} for the next price ${direction}.`);
    }
    persistAlerts(); updateActionCounts(); updateDishCardAction(dishId,'alert',hasAnyAlert(dishId)); updateDishActionStates();
    if (document.getElementById('alerts-modal').classList.contains('active')) renderAlerts();
}
function removePriceAlert(id) {
    const alert = priceAlerts.find(item => item.id === id);
    priceAlerts = priceAlerts.filter(item => item.id !== id);
    persistAlerts(); updateActionCounts();
    if (alert) updateDishCardAction(alert.dishId,'alert',hasAnyAlert(alert.dishId));
    updateDishActionStates(); renderAlerts();
}
function evaluatePriceAlerts() {
    const triggered = [];
    priceAlerts.forEach(alert => {
        const dish = dishById.get(String(alert.dishId));
        if (!dish) return;
        const current = numberFrom(dish.price);
        const previous = numberFrom(alert.lastSeenPrice,alert.baseline,current);
        const matched = alert.direction === 'drop' ? current < previous : current > previous;
        if (matched) {
            alert.status = 'triggered'; alert.triggeredAt = new Date().toISOString(); alert.triggerPrice = current;
            triggered.push({alert,dish,previous,current});
        }
        alert.lastSeenPrice = current;
    });
    persistAlerts(); updateActionCounts();
    triggered.slice(0,3).forEach(({alert,dish,previous,current}) => showToast('success',`Price ${alert.direction} detected`,`${dish.name}: ${formatMoney(previous)} → ${formatMoney(current)}`,6000));
}
function openAlertsModal() { renderAlerts(); document.getElementById('alerts-modal').classList.add('active'); document.body.style.overflow = 'hidden'; }
function closeAlertsModal() { document.getElementById('alerts-modal').classList.remove('active'); restoreBodyScroll(); }
function renderAlerts() {
    const list = document.getElementById('alerts-list');
    if (!priceAlerts.length) {
        list.innerHTML = '<div class="manager-empty"><i class="fas fa-bell-slash"></i><h3>No price alerts</h3><p>Open a dish and choose Alert on drop or Alert on rise.</p></div>'; return;
    }
    list.innerHTML = priceAlerts.map(alert => {
        const dish = dishById.get(String(alert.dishId));
        if (!dish) return '';
        const direction = alert.direction === 'drop' ? 'Drop' : 'Rise';
        return `<article class="manager-row alert-row ${alert.status === 'triggered' ? 'triggered' : ''}">${dish.image ? `<img src="${attr(dish.image)}" loading="lazy" alt="">` : '<span class="manager-row-icon"><i class="fas fa-bell"></i></span>'}<div><strong>${escapeHTML(dish.name)}</strong><span>${direction} alert · baseline ${formatMoney(alert.baseline)} · now ${formatMoney(dish.price)}</span></div><em>${alert.status === 'triggered' ? 'Triggered' : 'Watching'}</em><button data-remove-alert="${attr(alert.id)}" aria-label="Remove"><i class="fas fa-trash"></i></button></article>`;
    }).join('');
}

function getDishNavigationList() {
    const currentFiltered = currentView === 'dishes' && filteredItems.length && filteredItems.every(item => 'restaurantId' in item) ? filteredItems : [];
    const list = currentFiltered.length ? currentFiltered : (dishesByLocation[currentLocation] || []);
    return list.length ? list : allDishes;
}
function openDish(id) {
    const dish = dishById.get(String(id));
    if (!dish) return;
    currentDishId = dish.id; currentModalRestaurantId = null;
    document.getElementById('restaurant-modal').classList.remove('active');
    setDishTab('history'); renderDishModal();
    document.getElementById('dish-modal').classList.add('active'); document.body.style.overflow = 'hidden';
}
function closeDishModal() {
    document.getElementById('dish-modal').classList.remove('active'); currentDishId = null;
    if (dishHistoryChart) { dishHistoryChart.destroy(); dishHistoryChart = null; }
    restoreBodyScroll();
}
function cycleDish(direction) {
    if (currentDishId == null) return;
    const list = getDishNavigationList();
    const index = list.findIndex(dish => String(dish.id) === String(currentDishId));
    const nextIndex = (Math.max(0,index) + direction + list.length) % list.length;
    currentDishId = list[nextIndex].id; renderDishModal();
}
function setDishTab(tab) {
    const active = tab === 'details' ? 'details' : 'history';
    document.querySelectorAll('.dish-tab').forEach(button => button.classList.toggle('active',button.dataset.dishTab === active));
    document.querySelectorAll('.dish-tab-panel').forEach(panel => panel.classList.toggle('active',panel.id === `dish-tab-${active}`));
    if (active === 'history' && currentDishId != null) requestAnimationFrame(renderDishHistoryChart);
}
function updateDishActionStates() {
    if (currentDishId == null) return;
    document.getElementById('dish-cart-toggle')?.classList.toggle('active',isInCart(currentDishId));
    document.getElementById('dish-favorite-toggle')?.classList.toggle('active',isFavorite('d',currentDishId));
    document.getElementById('dish-compare-toggle')?.classList.toggle('active',isCompared('d',currentDishId));
    document.getElementById('alert-drop-btn')?.classList.toggle('active',hasPriceAlert(currentDishId,'drop'));
    document.getElementById('alert-rise-btn')?.classList.toggle('active',hasPriceAlert(currentDishId,'rise'));
}
function renderDishModal() {
    const dish = dishById.get(String(currentDishId));
    if (!dish) return;
    dish._metrics = computeDishMetrics(dish);
    const m = dish._metrics;
    const list = getDishNavigationList();
    const position = Math.max(0,list.findIndex(item => String(item.id) === String(dish.id))) + 1;
    document.getElementById('dish-position').textContent = `${position} / ${list.length} · DISH PRICE INTELLIGENCE`;
    document.getElementById('dish-modal-name').textContent = dish.name;
    document.getElementById('dish-modal-restaurant').textContent = `${dish.restaurantName} · ${dish.category || 'Other'}`;
    const bg = document.getElementById('dish-history-bg');
    bg.style.backgroundImage = dish.image ? `url("${String(dish.image).replace(/["\\]/g,'\\$&')}")` : 'none';
    const source = document.getElementById('history-source-badge');
    source.textContent = dish._history.length ? `${dish._history.length} recorded point${dish._history.length === 1 ? '' : 's'}` : 'No recorded price history';
    source.className = `history-source-badge ${dish._history.length ? 'real' : 'none'}`;
    const change = m.changePct;
    const historyKpis = dish._history.length ? [
        ['Current',formatMoney(m.current),'current'],
        ['Mean',formatMoney(m.average),'mean'],
        ['Recorded low',formatMoney(m.minimum),'low'],
        ['Recorded high',formatMoney(m.maximum),'high'],
        ['Latest change',`${change > 0 ? '+' : ''}${change.toFixed(1)}%`,change < 0 ? 'down' : change > 0 ? 'up' : 'flat']
    ] : [
        ['Current',formatMoney(m.current),'current'],
        ['Previous/listed',dish.oldPrice > dish.price ? formatMoney(dish.oldPrice) : 'Unavailable','mean'],
        ['History','Not supplied','flat']
    ];
    document.getElementById('dish-history-kpis').innerHTML = historyKpis.map(([label,value,type]) => `<div class="history-kpi ${type}"><span>${label}</span><strong>${value}</strong></div>`).join('');
    document.getElementById('dish-detail-content').innerHTML = `<div class="dish-detail-hero">${dish.image ? `<img src="${attr(dish.image)}" alt="${attr(dish.name)}">` : ''}<div><h3>${escapeHTML(dish.name)}</h3><p>${escapeHTML(dish.description || 'No description is available in the current dataset.')}</p></div></div><div class="detail-grid">${[
        ['Restaurant',dish.restaurantName],['Category',dish.category || 'Other'],['Current price',formatMoney(dish.price)],['Price history',dish._history.length ? `${dish._history.length} recorded points` : 'None recorded'],['First seen',dish._firstSeen ? dish._firstSeen.toLocaleDateString('en-US') : 'Unknown'],['Delivery',dish._restaurant?.deliveryTime ? `${dish._restaurant.deliveryTime} min` : 'N/A']
    ].map(([label,value])=>`<div><span>${escapeHTML(label)}</span><b>${escapeHTML(value)}</b></div>`).join('')}</div>`;
    updateDishActionStates();
    requestAnimationFrame(renderDishHistoryChart);
}
function renderDishHistoryChart() {
    const dish = dishById.get(String(currentDishId));
    const canvas = document.getElementById('dish-history-chart');
    const empty = document.getElementById('dish-history-empty');
    if (!dish || !canvas || !empty || !document.getElementById('dish-tab-history').classList.contains('active')) return;
    if (dishHistoryChart) { dishHistoryChart.destroy(); dishHistoryChart = null; }
    const displayHistory = getDishDisplayHistory(dish);
    if (!displayHistory.length) {
        canvas.hidden = true;
        empty.hidden = false;
        empty.innerHTML = `<i class="fas fa-chart-line"></i><h3>No price history available</h3><p>This database contains the current price only. The graph will appear when real dated price records are added.</p>`;
        return;
    }
    if (typeof Chart === 'undefined') return;
    canvas.hidden = false;
    empty.hidden = true;
    const colors = chartTheme();
    const average = dish._metrics.average;
    dishHistoryChart = new Chart(canvas.getContext('2d'),{
        type:'line',
        data:{
            labels:displayHistory.map(point => new Date(`${point.date}T12:00:00`).toLocaleDateString('en-US',{month:'short',day:'numeric',year:displayHistory.length > 180 ? '2-digit' : undefined})),
            datasets:[
                {label:'Recorded price',data:displayHistory.map(point=>point.price),borderColor:colors.accent,backgroundColor:'transparent',fill:false,borderWidth:3,pointRadius:displayHistory.length > 60 ? 0 : 2,pointHoverRadius:5,tension:.2},
                {label:'Recorded mean',data:displayHistory.map(()=>average),borderColor:colors.secondary,borderDash:[7,6],backgroundColor:'transparent',borderWidth:1.5,pointRadius:0}
            ]
        },
        options:{responsive:true,maintainAspectRatio:false,animation:false,normalized:true,devicePixelRatio:Math.min(window.devicePixelRatio || 1,1.5),interaction:{mode:'index',intersect:false},layout:{padding:{top:84,right:20,bottom:52,left:12}},plugins:{legend:{labels:{color:colors.text,usePointStyle:true}},tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: ${formatMoney(ctx.parsed.y)}`}}},scales:{x:{grid:{display:false},ticks:{color:colors.muted,maxTicksLimit:10,maxRotation:0}},y:{grid:{color:colors.grid},ticks:{color:colors.muted,callback:value=>formatMoney(value)}}}}
    });
}
function applyTheme(value,persist = true) {
    const themeValue = value === 'light' ? 'light' : 'amoled';
    document.body.dataset.theme = themeValue;
    if (persist) localStorage.setItem('fp_theme',themeValue);
    const icon = document.querySelector('#theme-toggle i');
    if (icon) icon.className = themeValue === 'amoled' ? 'fas fa-moon' : 'fas fa-sun';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = themeValue === 'amoled' ? '#000000' : '#eef3fb';
    if (currentView === 'analytics' && analyticsRendered) loadAnalytics();
    if (currentDishId != null) requestAnimationFrame(renderDishHistoryChart);
}
function toggleTheme() {
    const next = document.body.dataset.theme === 'amoled' ? 'light' : 'amoled';
    applyTheme(next);
    showToast('success',next === 'amoled' ? 'AMOLED black enabled' : 'Light glass enabled',next === 'amoled' ? 'Pure black surfaces reduce glow outside the content.' : 'The interface is now bright, translucent, and airy.');
}
function applyDensity(value,persist = true) {
    const densityValue = value === 'compact' ? 'compact' : 'comfortable';
    document.body.dataset.density = densityValue;
    if (persist) localStorage.setItem('fp_density',densityValue);
    const icon = document.querySelector('#density-toggle i');
    if (icon) icon.className = densityValue === 'compact' ? 'fas fa-table-cells' : 'fas fa-table-cells-large';
}
function toggleDensity() {
    const next = document.body.dataset.density === 'compact' ? 'comfortable' : 'compact';
    applyDensity(next); renderGrid();
    showToast('info',`${next === 'compact' ? 'Compact' : 'Comfortable'} density`,next === 'compact' ? 'More results fit on screen.' : 'Cards now show richer context.');
}
function applyAccent(value,persist = true) {
    const accentValue = accentModes.includes(value) ? value : 'berry';
    document.body.dataset.accent = accentValue;
    if (persist) localStorage.setItem('fp_accent',accentValue);
}

function surpriseMe() {
    const button = document.getElementById('surprise-btn');
    button.classList.remove('surprising'); void button.offsetWidth; button.classList.add('surprising');
    currentLocation = Math.floor(Math.random() * DATA.locations.length);
    localStorage.setItem('fp_location',currentLocation);
    const newView = Math.random() > .45 ? 'restaurants' : 'dishes';
    activeIntelFilter = newView === 'restaurants'
        ? ['popular','fast','toprated','hasmenu','discount','new','budget'][Math.floor(Math.random()*7)]
        : ['popular','fast','toprated','discount','budget'][Math.floor(Math.random()*5)];
    sortOption = sortCycle[Math.floor(Math.random()*sortCycle.length)];
    gridCols = clamp(2 + Math.floor(Math.random()*4),2,5);
    const newAccent = accentModes[Math.floor(Math.random()*accentModes.length)];
    applyAccent(newAccent);
    document.getElementById('sort-options').value = sortOption;
    document.getElementById('gridSize').value = gridCols;
    document.getElementById('gridSizeVal').textContent = gridCols;
    localStorage.setItem('fp_grid_cols',gridCols); localStorage.setItem('fp_sort',sortOption);
    renderLocationTabs(); renderSidebar(); updateStatsBar(); syncIntelButtons(); setView(newView);
    showToast('success','A fresh discovery mix',`${filterLabel(activeIntelFilter)} ${newView} in ${DATA.locations[currentLocation].name}, sorted by ${sortLabel(sortOption)}.`);
}

async function enterFocusMode() {
    if (document.body.classList.contains('focus-mode')) return exitFocusMode(true);
    focusSnapshot = {currentView,currentLocation,activeIntelFilter,sortOption,gridCols,activeCuisine,searchQuery,showFavoritesOnly};
    activeCuisine = ''; searchQuery = ''; showFavoritesOnly = false;
    if (currentView === 'analytics') currentView = 'restaurants';
    activeIntelFilter = currentView === 'dishes' ? 'discount' : 'toprated';
    sortOption = currentView === 'dishes' ? 'price_asc' : 'rating';
    gridCols = Math.min(5,Math.max(3,gridCols));
    document.body.classList.add('focus-mode');
    syncIntelButtons(); setView(currentView,{persist:false});
    try { await document.documentElement.requestFullscreen?.(); } catch { /* CSS fallback remains active */ }
    showToast('success','Best-picks focus','Distractions are hidden and the strongest available signal is active.');
}
function exitFocusMode(exitFullscreen = true) {
    document.body.classList.remove('focus-mode');
    if (focusSnapshot) {
        ({currentView,currentLocation,activeIntelFilter,sortOption,gridCols,activeCuisine,searchQuery,showFavoritesOnly} = focusSnapshot);
        focusSnapshot = null;
        document.getElementById('product-search').value = searchQuery;
        document.getElementById('sidebar-filter').value = searchQuery;
        document.getElementById('sort-options').value = sortOption;
        document.getElementById('gridSize').value = gridCols;
        document.getElementById('gridSizeVal').textContent = gridCols;
        document.getElementById('favorites-only-btn').classList.toggle('active',showFavoritesOnly);
        renderLocationTabs(); renderSidebar(); syncIntelButtons(); setView(currentView,{persist:false});
    }
    if (exitFullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function showToast(type,title,message,duration = 3600) {
    const stack = document.getElementById('toast-stack');
    if (!stack) return;
    const icons = {success:'fa-check',warning:'fa-triangle-exclamation',error:'fa-xmark',info:'fa-circle-info'};
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span class="toast-icon"><i class="fas ${icons[type] || icons.info}"></i></span><div><strong>${escapeHTML(title)}</strong><span>${escapeHTML(message)}</span></div><button aria-label="Dismiss"><i class="fas fa-times"></i></button>`;
    const remove = () => { toast.classList.add('removing'); setTimeout(() => toast.remove(),320); };
    toast.querySelector('button').addEventListener('click',remove);
    stack.appendChild(toast);
    setTimeout(remove,duration);
}

function getCommands() {
    return [
        {icon:'fa-store',title:'Open restaurant radar',desc:'Browse restaurants in the current location',key:'R',run:() => setView('restaurants')},
        {icon:'fa-utensils',title:'Open dish discovery',desc:'Browse every indexed menu item',key:'D',run:() => setView('dishes')},
        {icon:'fa-chart-simple',title:'Open market intelligence',desc:'View charts, rankings, and pricing analysis',key:'A',run:() => setView('analytics')},
        {icon:'fa-moon',title:'Toggle light / AMOLED',desc:'Switch the complete visual theme',key:'T',run:toggleTheme},
        {icon:'fa-table-cells',title:'Toggle card density',desc:'Choose compact or comfortable cards',key:'G',run:toggleDensity},
        {icon:'fa-expand',title:'Enter best-picks focus',desc:'Hide chrome and surface stronger picks',key:'F',run:enterFocusMode},
        {icon:'fa-heart',title:'Show favorites only',desc:'Filter to locally saved restaurants or dishes',key:'V',run:() => { showFavoritesOnly = true; document.getElementById('favorites-only-btn').classList.add('active'); renderGrid(); }},
        {icon:'fa-scale-balanced',title:'Toggle comparison mode',desc:'Stage 2–6 cards for side-by-side analysis',key:'C',run:() => setComparisonMode(!comparisonMode)},
        {icon:'fa-wand-magic-sparkles',title:'Surprise me',desc:'Randomize location, view, signal, density, and accent',key:'S',run:surpriseMe},
        {icon:'fa-rotate-left',title:'Reset every filter',desc:'Return to a clean location view',key:'X',run:clearFilters}
    ];
}
function openCommandPalette() {
    const modal = document.getElementById('command-modal');
    modal.classList.add('active');
    const input = document.getElementById('command-search');
    input.value = ''; commandIndex = 0; renderCommands(); setTimeout(() => input.focus(),0);
}
function closeCommandPalette() { document.getElementById('command-modal').classList.remove('active'); }
function renderCommands() {
    const query = document.getElementById('command-search').value.trim().toLowerCase();
    commandMatches = getCommands().filter(command => `${command.title} ${command.desc}`.toLowerCase().includes(query));
    commandIndex = clamp(commandIndex,0,Math.max(0,commandMatches.length-1));
    document.getElementById('command-list').innerHTML = commandMatches.map((command,index) => `<button class="command-item ${index === commandIndex ? 'selected' : ''}" data-index="${index}"><i class="fas ${command.icon}"></i><div><strong>${escapeHTML(command.title)}</strong><span>${escapeHTML(command.desc)}</span></div><kbd>${command.key}</kbd></button>`).join('') || '<div class="recent-empty">No command matched.</div>';
}
function runCommand(index) { const command = commandMatches[index]; if (!command) return; closeCommandPalette(); command.run(); }
function handleKeyboard(e) {
    const commandOpen = document.getElementById('command-modal').classList.contains('active');
    const dishOpen = document.getElementById('dish-modal').classList.contains('active');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCommandPalette(); return; }
    if (commandOpen) {
        if (e.key === 'ArrowDown') { e.preventDefault(); commandIndex = Math.min(commandMatches.length-1,commandIndex+1); renderCommands(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); commandIndex = Math.max(0,commandIndex-1); renderCommands(); }
        else if (e.key === 'Enter') { e.preventDefault(); runCommand(commandIndex); }
        else if (e.key === 'Escape') closeCommandPalette();
        return;
    }
    if (dishOpen && e.key === 'ArrowLeft') { e.preventDefault(); cycleDish(-1); return; }
    if (dishOpen && e.key === 'ArrowRight') { e.preventDefault(); cycleDish(1); return; }
    if (e.key === '/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) { e.preventDefault(); document.getElementById('product-search').focus(); }
    if (e.key === 'Escape') {
        hideSuggestions(); closeSidebar(); closeRestaurantModal(); closeComparison(); closeDishModal(); closeAlertsModal(); closeCartModal();
        if (document.body.classList.contains('focus-mode')) exitFocusMode(true);
    }
}

function chartTheme() {
    const styles = getComputedStyle(document.body);
    return { text: styles.getPropertyValue('--text-secondary').trim(), muted: styles.getPropertyValue('--text-muted').trim(), grid: styles.getPropertyValue('--chart-grid').trim(), accent: styles.getPropertyValue('--accent-color').trim(), soft: styles.getPropertyValue('--accent-soft').trim(), secondary: styles.getPropertyValue('--accent-secondary').trim() };
}
function destroyChart(name) { if (chartRegistry[name]) { chartRegistry[name].destroy(); delete chartRegistry[name]; } }
function makeChart(name,canvasId,config) {
    destroyChart(name);
    config.options = {...(config.options || {}),animation:false};
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;
    chartRegistry[name] = new Chart(canvas,config);
}

function loadAnalytics() {
    const restaurants = restaurantsByLocation[currentLocation] || [];
    const dishes = dishesByLocation[currentLocation] || [];
    const colors = chartTheme();
    const avgRating = restaurants.length ? (restaurants.reduce((sum,r) => sum + (r.rating || 0),0) / restaurants.length).toFixed(1) : '0.0';
    const avgDelivery = restaurants.length ? Math.round(restaurants.reduce((sum,r) => sum + (r.deliveryTime || 0),0) / restaurants.length) : 0;
    const offerCount = restaurants.filter(r => r.hasDiscount).length;
    const avgDishPrice = dishes.length ? Math.round(dishes.reduce((sum,d) => sum + (d.price || 0),0) / dishes.length) : 0;
    document.getElementById('kpiRow').innerHTML = `
        <div class="kpi-card pink"><div class="kpi-lbl">Restaurants</div><div class="kpi-val">${restaurants.length}</div><div class="kpi-sub">in ${escapeHTML(DATA.locations[currentLocation]?.name || 'location')}</div></div>
        <div class="kpi-card teal"><div class="kpi-lbl">Indexed dishes</div><div class="kpi-val">${dishes.length}</div><div class="kpi-sub">average ${formatMoney(avgDishPrice)}</div></div>
        <div class="kpi-card gold"><div class="kpi-lbl">Average rating</div><div class="kpi-val">${avgRating}</div><div class="kpi-sub">${avgDelivery} min typical delivery</div></div>
        <div class="kpi-card red"><div class="kpi-lbl">Offer coverage</div><div class="kpi-val">${restaurants.length ? Math.round(offerCount/restaurants.length*100) : 0}%</div><div class="kpi-sub">${offerCount} restaurants</div></div>`;

    const cuisineCounts = {};
    restaurants.forEach(r => (r.cuisineList || []).forEach(c => cuisineCounts[c] = (cuisineCounts[c] || 0) + 1));
    const cuisineSorted = Object.entries(cuisineCounts).sort((a,b) => b[1]-a[1]).slice(0,10);
    makeChart('cuisine','chartCuisine',{type:'doughnut',data:{labels:cuisineSorted.map(x=>x[0]),datasets:[{data:cuisineSorted.map(x=>x[1]),backgroundColor:chartColors,borderWidth:0,hoverOffset:7}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{color:colors.text,font:{size:10},padding:9,usePointStyle:true}}}}});

    const ratingLabels = ['No rating','<3','3–3.5','3.5–4','4–4.5','4.5+'];
    const ratingCounts = Object.fromEntries(ratingLabels.map(label => [label,0]));
    restaurants.forEach(r => { const rating=r.rating||0; const key=!rating?'No rating':rating<3?'<3':rating<3.5?'3–3.5':rating<4?'3.5–4':rating<4.5?'4–4.5':'4.5+'; ratingCounts[key]++; });
    makeChart('rating','chartRating',{type:'bar',data:{labels:ratingLabels,datasets:[{data:ratingLabels.map(x=>ratingCounts[x]),backgroundColor:chartColors.slice(0,6),borderRadius:8,borderSkipped:false}]},options:barOptions(colors)});

    const deliveryLabels = ['N/A','0–15','16–30','31–45','46–60','60+'];
    const deliveryCounts = Object.fromEntries(deliveryLabels.map(label=>[label,0]));
    restaurants.forEach(r => { const t=r.deliveryTime||0; const key=!t?'N/A':t<=15?'0–15':t<=30?'16–30':t<=45?'31–45':t<=60?'46–60':'60+'; deliveryCounts[key]++; });
    makeChart('delivery','chartDelivery',{type:'bar',data:{labels:deliveryLabels,datasets:[{data:deliveryLabels.map(x=>deliveryCounts[x]),backgroundColor:['#667087','#00d4aa','#3b82f6','#f5b942','#f97316','#ff5267'],borderRadius:8,borderSkipped:false}]},options:barOptions(colors)});

    const priceLabels = ['N/A','৳ Budget','৳৳ Mid','৳৳৳ Premium','৳৳৳৳ Luxury'];
    const priceCounts = Object.fromEntries(priceLabels.map(label=>[label,0]));
    restaurants.forEach(r => { const b=r.budget||0; const key=!b?'N/A':b===1?'৳ Budget':b===2?'৳৳ Mid':b===3?'৳৳৳ Premium':'৳৳৳৳ Luxury'; priceCounts[key]++; });
    makeChart('price','chartPrice',{type:'polarArea',data:{labels:priceLabels,datasets:[{data:priceLabels.map(x=>priceCounts[x]),backgroundColor:chartColors.slice(0,5).map(c=>`${c}bb`),borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,scales:{r:{ticks:{display:false},grid:{color:colors.grid},angleLines:{color:colors.grid}}},plugins:{legend:{position:'right',labels:{color:colors.text,font:{size:10},usePointStyle:true}}}}});

    const categoryStats = {};
    dishes.forEach(d => {
        const category=d.category||'Other';
        const stat=categoryStats[category] ||= {prices:[],discounts:[]};
        if (d.price > 0) stat.prices.push(Number(d.price));
        if (d._discountPct) stat.discounts.push(d._discountPct);
    });
    const categorySorted = Object.entries(categoryStats).sort((a,b)=>b[1].prices.length-a[1].prices.length);
    const topCategories = categorySorted.slice(0,12);
    makeChart('categoryPrice','chartCuisinePrice',{type:'bar',data:{labels:topCategories.map(x=>x[0]),datasets:[{data:topCategories.map(x=>Math.round(avg(x[1].prices))),backgroundColor:colors.secondary,borderRadius:7,borderSkipped:false}]},options:{...barOptions(colors),indexAxis:'y'}});

    const menuLabels = ['0','1–5','6–15','16–30','31+'];
    const menuCounts = Object.fromEntries(menuLabels.map(label=>[label,0]));
    restaurants.forEach(r => { const c=r._dishCount||0; const key=!c?'0':c<=5?'1–5':c<=15?'6–15':c<=30?'16–30':'31+'; menuCounts[key]++; });
    makeChart('menuDepth','chartDishCount',{type:'bar',data:{labels:menuLabels,datasets:[{data:menuLabels.map(x=>menuCounts[x]),backgroundColor:['#ff5267','#f5b942','#3b82f6','#8b5cf6','#00d4aa'],borderRadius:8,borderSkipped:false}]},options:barOptions(colors)});

    const discounted = dishes.filter(d=>d._discountPct);
    makeChart('discount','chartDiscount',{type:'doughnut',data:{labels:['Discounted','Regular price'],datasets:[{data:[discounted.length,dishes.length-discounted.length],backgroundColor:['#ff5267bb','#3b82f699'],borderWidth:0,hoverOffset:7}]},options:{responsive:true,maintainAspectRatio:false,cutout:'65%',plugins:{legend:{position:'right',labels:{color:colors.text,font:{size:10},usePointStyle:true}},title:{display:true,text:discounted.length?`Average ${Math.round(avg(discounted.map(d=>d._discountPct)))}% off`:'No discounts indexed',color:colors.text,font:{size:11}}}}});

    renderLeaderboard('leaderCuisines',cuisineSorted.slice(0,8),value=>value,colors.secondary);
    const mostReviewed=[...restaurants].sort((a,b)=>(b.reviewCount||0)-(a.reviewCount||0)).slice(0,8);
    renderEntityLeaderboard('leaderReviews',mostReviewed,r=>(r.reviewCount||0).toLocaleString('en-US'),r=>r.reviewCount||0,colors.accent);
    const topRated=[...restaurants].filter(r=>r.rating).sort((a,b)=>(b.rating||0)-(a.rating||0)||(b.reviewCount||0)-(a.reviewCount||0)).slice(0,8);
    renderEntityLeaderboard('leaderRating',topRated,r=>Number(r.rating).toFixed(1),r=>r.rating||0,'#f5b942');

    document.getElementById('cuisinePriceTable').innerHTML = categorySorted.map(([name,stat]) => {
        const prices=stat.prices; const average=Math.round(avg(prices)); const min=prices.length?Math.min(...prices):0; const max=prices.length?Math.max(...prices):0; const avgDiscount=stat.discounts.length?Math.round(avg(stat.discounts)):0;
        return `<tr><td><span class="badge badge-cuisine">${escapeHTML(name)}</span></td><td>${prices.length}</td><td style="color:var(--accent-secondary)">${formatMoney(average)}</td><td>${formatMoney(min)}</td><td>${formatMoney(max)}</td><td>${formatMoney(max-min)}</td><td>${stat.discounts.length}</td><td style="color:${avgDiscount>20?'var(--danger)':avgDiscount?'var(--gold)':'var(--text-muted)'}">${avgDiscount}%</td></tr>`;
    }).join('');
    analyticsRendered = true;
}
function avg(values) { return values.length ? values.reduce((a,b)=>a+b,0)/values.length : 0; }
function barOptions(colors) {
    return {responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:colors.muted,font:{size:10}},grid:{display:false}},y:{beginAtZero:true,ticks:{color:colors.muted,font:{size:10},precision:0},grid:{color:colors.grid}}}};
}
function renderLeaderboard(id,entries,formatter,color) {
    const max=entries.length?entries[0][1]||1:1;
    document.getElementById(id).innerHTML=entries.map(([name,value],index)=>leaderboardRow(name,formatter(value),value/max,index,color)).join('');
}
function renderEntityLeaderboard(id,entries,formatter,valueGetter,color) {
    const max=entries.length?Math.max(...entries.map(valueGetter))||1:1;
    document.getElementById(id).innerHTML=entries.map((item,index)=>leaderboardRow(item.name,formatter(item),valueGetter(item)/max,index,color)).join('');
}
function leaderboardRow(name,value,ratio,index,color) {
    const rankClass=index===0?'gold':index===1?'silver':index===2?'bronze':'';
    return `<div class="lb-row"><span class="lb-rank ${rankClass}">${index+1}</span><span class="lb-name">${escapeHTML(name)}</span><span class="lb-bar-wrap"><span class="lb-bar" style="width:${Math.round(ratio*100)}%;background:${color}"></span></span><span class="lb-val">${escapeHTML(value)}</span></div>`;
}

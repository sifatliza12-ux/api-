/**
 * marketplace.js
 * Dedicated, full-viewport Marketplace page — opened as its own extension
 * tab from the popup launcher so it has real room for cards, filters, and
 * whatever else (Subscriptions, Payments, Creator Dashboard) lands here
 * later, instead of being squeezed into the 390px popup.
 */

const API_BASE = 'http://localhost:5000';

const escapeHtml = (str) => {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

const formatRelativeDate = (iso) => {
    if (!iso) return 'Unknown';
    try {
        const d = new Date(iso);
        const diff = Date.now() - d.getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    } catch (e) {
        return 'Unknown';
    }
};

const fetchJson = async (url, opts = {}) => {
    const response = await fetch(url, opts);
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
};

// Fixed marketplace taxonomy shown in the category chips — a static
// product decision, not something derived from any particular API.
const MARKETPLACE_CATEGORY_LABELS = {
    all: 'All',
    productivity: 'Productivity',
    travel: 'Travel',
    finance: 'Finance',
    shopping: 'Shopping',
    education: 'Education',
    entertainment: 'Entertainment',
    'social-media': 'Social Media',
    other: 'Other'
};

// Maps whatever category string a listing actually has (older seed data
// uses "social"/"automation"/"ecommerce", freshly-published APIs default
// to "all") onto the fixed taxonomy above. Purely a value-based lookup —
// never keyed on an API's name — so it works the same for any listing,
// demo or real.
const CATEGORY_ALIASES = {
    productivity: 'productivity',
    travel: 'travel',
    finance: 'finance',
    shopping: 'shopping',
    ecommerce: 'shopping',
    education: 'education',
    entertainment: 'entertainment',
    social: 'social-media',
    'social-media': 'social-media',
    'social media': 'social-media'
};

const normalizeCategorySlug = (raw) => {
    const key = String(raw || '').trim().toLowerCase();
    return CATEGORY_ALIASES[key] || 'other';
};

const categoryLabel = (slug) => MARKETPLACE_CATEGORY_LABELS[slug] || 'Other';

// The backend doesn't track real ratings or install counts yet, so these
// are stable "prototype" numbers derived from each listing's own id —
// deterministic (the same item always shows the same numbers, so
// sorting/filtering doesn't jitter) and generic (works for any listing,
// not hardcoded to specific demo APIs).
const seededFraction = (seed) => {
    const x = Math.sin(seed * 999331) * 10000;
    return x - Math.floor(x);
};

const getPrototypeStats = (item) => {
    const seed = Number(item.id) || 1;
    const rating = Math.round((3.6 + seededFraction(seed) * 1.4) * 10) / 10; // 3.6–5.0
    const installs = Math.round(80 + seededFraction(seed + 0.5) * 6200); // 80–6280
    return { rating, installs };
};

const formatInstallCount = (n) => {
    if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 >= 100 ? 1 : 0)}k`;
    return String(n);
};

const renderStars = (rating) => {
    const full = Math.min(5, Math.max(0, Math.round(rating)));
    return '★'.repeat(full) + '☆'.repeat(5 - full);
};

const isFreeItem = (it) => !!it.free || !it.price || Number(it.price) === 0;

document.addEventListener('DOMContentLoaded', () => {
    const refreshBtn = document.getElementById('refresh-btn');
    const marketplaceSearch = document.getElementById('marketplace-search');
    const marketplaceFilter = document.getElementById('marketplace-filter');
    const marketplaceSort = document.getElementById('marketplace-sort');
    const marketplaceList = document.getElementById('marketplace-list');
    const marketplaceFeaturedSection = document.getElementById('marketplace-featured-section');
    const marketplaceFeatured = document.getElementById('marketplace-featured');
    const marketplaceResultCount = document.getElementById('marketplace-result-count');
    const categoryChipsRow = document.getElementById('marketplace-category-chips');

    let marketplaceItems = [];
    let activeCategory = 'all';

    const buildMarketCardHtml = (it) => {
        const stats = getPrototypeStats(it);
        const free = isFreeItem(it);
        const catSlug = normalizeCategorySlug(it.category);
        const priceLabel = free ? 'Free' : `$${it.price}`;

        return `
            <div class="market-card-top">
                <div class="market-card-heading">
                    <h3>${escapeHtml(it.name)}</h3>
                    <div class="market-badges">
                        <span class="badge badge-category">${escapeHtml(categoryLabel(catSlug))}</span>
                        <span class="badge ${free ? 'badge-free' : 'badge-paid'}">${free ? 'Free' : 'Paid'}</span>
                    </div>
                </div>
                <span class="market-price ${free ? 'market-price--free' : ''}">${priceLabel}</span>
            </div>
            <p class="market-card-description">${escapeHtml(it.description || 'No description provided.')}</p>
            <div class="market-meta market-meta--rich">
                <span class="market-meta-item" title="Creator">👤 ${escapeHtml(it.publisher || 'Unknown')}</span>
                <span class="market-meta-item" title="Published">🕐 ${formatRelativeDate(it.createdAt)}</span>
            </div>
            <div class="market-stats">
                <span class="market-stat" title="${stats.rating.toFixed(1)} out of 5">
                    <span class="market-stars" aria-hidden="true">${renderStars(stats.rating)}</span>
                    <span class="market-stat-value">${stats.rating.toFixed(1)}</span>
                </span>
                <span class="market-stat" title="${stats.installs} installs">⬇ ${formatInstallCount(stats.installs)}</span>
            </div>
            <button type="button" class="btn btn-primary market-buy-btn">${free ? 'Install' : `Purchase • $${it.price}`}</button>
        `;
    };

    const attachMarketCardHandlers = (card, it) => {
        card.addEventListener('click', () => openMarketModal(it));
        const buyBtn = card.querySelector('.market-buy-btn');
        if (buyBtn) {
            buyBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                alert('Purchase flow is not implemented in this demo.');
            });
        }
    };

    const renderMarketplaceSkeleton = () => {
        if (marketplaceResultCount) marketplaceResultCount.textContent = '';

        if (marketplaceList) {
            marketplaceList.innerHTML = Array.from({ length: 6 }).map(() => `
                <div class="market-card market-card--skeleton" aria-hidden="true">
                    <div class="skeleton-line skeleton-line--title"></div>
                    <div class="skeleton-line skeleton-line--desc"></div>
                    <div class="skeleton-line skeleton-line--desc" style="width:60%"></div>
                    <div class="skeleton-line skeleton-line--pill"></div>
                </div>
            `).join('');
        }

        if (marketplaceFeaturedSection && marketplaceFeatured) {
            marketplaceFeaturedSection.hidden = false;
            marketplaceFeatured.innerHTML = Array.from({ length: 3 }).map(() => `
                <div class="market-card market-card--featured market-card--skeleton" aria-hidden="true">
                    <div class="skeleton-line skeleton-line--title"></div>
                    <div class="skeleton-line skeleton-line--desc"></div>
                </div>
            `).join('');
        }
    };

    const renderFeatured = (items) => {
        if (!marketplaceFeatured || !marketplaceFeaturedSection) return;

        if (!items || items.length === 0) {
            marketplaceFeaturedSection.hidden = true;
            marketplaceFeatured.innerHTML = '';
            return;
        }

        // "Featured" = highest rating × install-count out of the full,
        // unfiltered catalog — a generic ranking rule, not a hand-picked
        // list, so it stays correct as listings come and go.
        const featured = items
            .slice()
            .sort((a, b) => {
                const sa = getPrototypeStats(a);
                const sb = getPrototypeStats(b);
                return (sb.rating * sb.installs) - (sa.rating * sa.installs);
            })
            .slice(0, 3);

        marketplaceFeaturedSection.hidden = false;
        marketplaceFeatured.innerHTML = '';
        featured.forEach((it) => {
            const card = document.createElement('article');
            card.className = 'market-card market-card--featured';
            card.dataset.id = it.id;
            card.innerHTML = `<span class="featured-ribbon">★ Featured</span>${buildMarketCardHtml(it)}`;
            attachMarketCardHandlers(card, it);
            marketplaceFeatured.appendChild(card);
        });
    };

    const renderMarketplace = (items) => {
        if (!marketplaceList) return;

        if (marketplaceResultCount) {
            marketplaceResultCount.textContent = items && items.length
                ? `${items.length} API${items.length === 1 ? '' : 's'}`
                : '';
        }

        if (!items || items.length === 0) {
            marketplaceList.innerHTML = `
                <div class="marketplace-empty">
                    <div class="marketplace-empty-icon" aria-hidden="true">🔍</div>
                    <h3>No APIs found.</h3>
                    <p>Try a different search term, category, or filter.</p>
                </div>
            `;
            return;
        }

        marketplaceList.innerHTML = '';
        items.forEach((it) => {
            const card = document.createElement('article');
            card.className = 'market-card';
            card.dataset.id = it.id;
            card.innerHTML = buildMarketCardHtml(it);
            attachMarketCardHandlers(card, it);
            marketplaceList.appendChild(card);
        });
    };

    const applyMarketplaceFilters = () => {
        const q = (marketplaceSearch && marketplaceSearch.value || '').trim().toLowerCase();
        const filter = (marketplaceFilter && marketplaceFilter.value) || 'all';
        const sort = (marketplaceSort && marketplaceSort.value) || 'newest';

        let result = (marketplaceItems || []).slice();
        if (q) {
            result = result.filter(i => `${i.name} ${i.description || ''} ${i.publisher || ''}`.toLowerCase().includes(q));
        }
        if (filter === 'free') result = result.filter(i => isFreeItem(i));
        if (filter === 'paid') result = result.filter(i => !isFreeItem(i));

        if (activeCategory && activeCategory !== 'all') {
            result = result.filter(i => normalizeCategorySlug(i.category) === activeCategory);
        }

        if (sort === 'price-asc') {
            result.sort((a, b) => (a.price || 0) - (b.price || 0));
        } else if (sort === 'price-desc') {
            result.sort((a, b) => (b.price || 0) - (a.price || 0));
        } else if (sort === 'downloads-desc') {
            result.sort((a, b) => getPrototypeStats(b).installs - getPrototypeStats(a).installs);
        } else if (sort === 'rating-desc') {
            result.sort((a, b) => getPrototypeStats(b).rating - getPrototypeStats(a).rating);
        } else {
            result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // newest (default)
        }

        // The "Featured" strip is an editorial/browsing aid over the FULL
        // catalog. Once the user is actively searching or filtering, keeping
        // it visible (and unfiltered) made it look like search/filter wasn't
        // doing anything — the browse grid below would shrink, but the row
        // of cards at the top of the page stayed exactly the same. Hiding it
        // whenever any filter is active removes that illusion.
        const isBrowsingUnfiltered = !q && filter === 'all' && activeCategory === 'all';
        if (isBrowsingUnfiltered) {
            renderFeatured(marketplaceItems);
        } else if (marketplaceFeaturedSection) {
            marketplaceFeaturedSection.hidden = true;
        }

        renderMarketplace(result);
    };

    const loadMarketplaceItems = async () => {
        renderMarketplaceSkeleton();
        try {
            const { ok, data } = await fetchJson(`${API_BASE}/marketplace`);
            if (!ok) {
                console.warn('[ForgeFlow][marketplace] failed to load marketplace items', data);
                marketplaceItems = [];
                applyMarketplaceFilters();
                return;
            }
            marketplaceItems = data || [];
            applyMarketplaceFilters();
        } catch (err) {
            console.error('[ForgeFlow][marketplace] loadMarketplaceItems error', err);
            marketplaceItems = [];
            applyMarketplaceFilters();
        }
    };

    const updateMarketplaceListingPrice = (newPrice) => {
        const listingCard = document.querySelector('.market-card--listing');
        const priceLine = listingCard?.querySelector('.listing-price-line');
        if (!listingCard || !priceLine) return;

        priceLine.textContent = newPrice > 0
            ? `Original purchase price: $10 • Selling price: $${newPrice}`
            : 'Original purchase price: $10 • Selling price: Free';
    };

    const handleEditPriceButton = () => {
        const listingCard = document.querySelector('.market-card--listing');
        const priceLine = listingCard?.querySelector('.listing-price-line');
        const currentPriceMatch = priceLine?.textContent?.match(/Selling price: \$(\d+)/);
        const currentPrice = currentPriceMatch ? Number(currentPriceMatch[1]) : 15;
        const val = prompt('Enter new price (0 for Free):', String(currentPrice));
        if (val === null) return;

        const num = Number(val);
        if (Number.isNaN(num) || num < 0) {
            alert('Please enter a valid non-negative number for price.');
            return;
        }

        updateMarketplaceListingPrice(num);
        alert('Listing price updated.');
    };

    const handleRemoveListingButton = () => {
        if (!confirm('Remove this listing from the marketplace? This will not delete your API.')) return;

        const listingCard = document.querySelector('.market-card--listing');
        if (listingCard) {
            listingCard.remove();
        }

        alert('Listing removed.');
    };

    const openMarketModal = (item) => {
        const stats = getPrototypeStats(item);
        const free = isFreeItem(item);

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <h3>${escapeHtml(item.name)}</h3>
            <div class="modal-scroll-body">
                <div class="modal-badges">
                    <span class="badge badge-category">${escapeHtml(categoryLabel(normalizeCategorySlug(item.category)))}</span>
                    <span class="badge ${free ? 'badge-free' : 'badge-paid'}">${free ? 'Free' : 'Paid'}</span>
                </div>
                <p>${escapeHtml(item.description || '')}</p>
                <p><strong>Method:</strong> ${escapeHtml(item.method || '')} • <strong>Version:</strong> ${escapeHtml(item.version || '')}</p>
                <p><strong>Creator:</strong> ${escapeHtml(item.publisher || '')} • <strong>Price:</strong> <span id="market-price-${item.id}">${item.price && item.price > 0 ? '$' + item.price : 'Free'}</span></p>
                <p><strong>Published:</strong> ${formatRelativeDate(item.createdAt)}</p>
                <p><strong>Rating:</strong> ${stats.rating.toFixed(1)} ★ • <strong>Installs:</strong> ${formatInstallCount(stats.installs)}</p>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary edit-price">Edit Price</button>
                <button class="btn btn-secondary remove-listing">Remove Listing</button>
                <button class="btn btn-primary market-buy">Buy</button>
                <button class="btn btn-secondary modal-close">Close</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
        overlay.querySelector('.market-buy').addEventListener('click', () => {
            alert('Purchase flow is not implemented in this demo.');
        });

        const editBtn = overlay.querySelector('.edit-price');
        editBtn.addEventListener('click', async () => {
            const val = prompt('Enter new price (0 for Free):', String(typeof item.price !== 'undefined' ? item.price : '0'));
            if (val === null) return; // cancelled
            const num = Number(val);
            if (Number.isNaN(num) || num < 0) {
                alert('Please enter a valid non-negative number for price.');
                return;
            }

            try {
                const resp = await fetch(`${API_BASE}/marketplace/${item.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ price: num })
                });

                if (resp.ok) {
                    const idx = marketplaceItems.findIndex(m => m.id === item.id);
                    if (idx !== -1) {
                        marketplaceItems[idx].price = num;
                        marketplaceItems[idx].free = num === 0;
                    }
                    const priceSpan = document.getElementById(`market-price-${item.id}`);
                    if (priceSpan) priceSpan.textContent = num > 0 ? '$' + num : 'Free';
                    applyMarketplaceFilters();
                    alert('Price updated.');
                } else {
                    const d = await resp.json().catch(() => ({}));
                    alert(d.message || 'Failed to update price.');
                }
            } catch (err) {
                console.error('[ForgeFlow][marketplace] update price failed', err);
                const idx = marketplaceItems.findIndex(m => m.id === item.id);
                if (idx !== -1) {
                    marketplaceItems[idx].price = num;
                    marketplaceItems[idx].free = num === 0;
                }
                const priceSpan = document.getElementById(`market-price-${item.id}`);
                if (priceSpan) priceSpan.textContent = num > 0 ? '$' + num : 'Free';
                applyMarketplaceFilters();
                alert('Price updated locally (backend unavailable).');
            }
        });

        const removeBtn = overlay.querySelector('.remove-listing');
        removeBtn.addEventListener('click', async () => {
            if (!confirm('Remove this listing from the marketplace? This will not delete your API.')) return;
            try {
                const resp = await fetch(`${API_BASE}/marketplace/${item.id}`, { method: 'DELETE' });
                if (resp.ok) {
                    marketplaceItems = (marketplaceItems || []).filter(m => m.id !== item.id);
                    applyMarketplaceFilters();
                    overlay.remove();
                } else {
                    const d = await resp.json().catch(() => ({}));
                    alert(d.message || 'Failed to remove listing.');
                }
            } catch (err) {
                console.error('[ForgeFlow][marketplace] remove listing failed', err);
                marketplaceItems = (marketplaceItems || []).filter(m => m.id !== item.id);
                applyMarketplaceFilters();
                overlay.remove();
                alert('Listing removed locally (backend unavailable).');
            }
        });

        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    };

    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadMarketplaceItems);
    }

    if (marketplaceSearch) {
        marketplaceSearch.addEventListener('input', () => applyMarketplaceFilters());
    }

    if (marketplaceFilter) {
        marketplaceFilter.addEventListener('change', () => applyMarketplaceFilters());
    }

    if (marketplaceSort) {
        marketplaceSort.addEventListener('change', () => applyMarketplaceFilters());
    }

    if (categoryChipsRow) {
        const chips = categoryChipsRow.querySelectorAll('.chip');
        chips.forEach((chip) => {
            chip.addEventListener('click', () => {
                activeCategory = (chip.dataset && chip.dataset.category) || 'all';
                chips.forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                applyMarketplaceFilters();
            });
        });
    }

    document.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.closest('#edit-price-btn')) {
            event.preventDefault();
            handleEditPriceButton();
        }
        if (target.closest('#remove-listing-btn')) {
            event.preventDefault();
            handleRemoveListingButton();
        }
    });

    loadMarketplaceItems();
});

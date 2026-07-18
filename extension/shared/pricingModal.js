/**
 * Shared ForgeFlow pricing modal — used both when a creator first publishes
 * an API (extension/my-apis/my-apis.js) and when they later change an
 * already-published listing's price (extension/marketplace/marketplace.js),
 * so "set a price" looks and behaves identically everywhere instead of one
 * spot using a styled modal and the other a bare browser prompt(). Reuses
 * the same .modal/.modal-overlay/.form-field classes every other ForgeFlow
 * modal already uses (see my-apis.css / marketplace.css) — no new visual
 * language, just a shared implementation of an existing one.
 */
(function () {
    const escapeHtml = (str) => {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    // options:
    //   title              — modal heading
    //   initialPrice       — pre-filled price value (string/number), blank if unset
    //   initialNote        — pre-filled note/description value
    //   priceHint          — helper text under the price field
    //   noteLabel          — label for the optional note field
    //   notePlaceholder    — placeholder for the optional note field
    //   submitLabel        — primary button label
    //   submitPendingLabel — primary button label while submitting
    //   cancelLabel        — secondary button label
    //   onSubmit(price, note) — async, returns { success: true } or { success: false, message }
    window.openForgeFlowPricingModal = function (options) {
        const {
            title = 'Set Price',
            initialPrice = '',
            initialNote = '',
            priceHint = 'Buyers pay this amount once to purchase this API.',
            noteLabel = 'Note for buyers (optional)',
            notePlaceholder = 'Anything buyers should know about this API...',
            submitLabel = 'Publish',
            submitPendingLabel = 'Publishing…',
            cancelLabel = 'Cancel',
            onSubmit
        } = options || {};

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <h3>${escapeHtml(title)}</h3>
            <div class="modal-scroll-body">
                <div class="form-field">
                    <label class="form-field-label" for="pm-price">Price (USD) <span aria-hidden="true">*</span></label>
                    <input type="number" id="pm-price" class="form-input" min="0.01" step="0.01" placeholder="e.g. 9.99" value="${escapeHtml(initialPrice === 0 || initialPrice ? String(initialPrice) : '')}">
                    <span class="form-field-hint">${escapeHtml(priceHint)}</span>
                </div>
                <div class="form-field">
                    <label class="form-field-label" for="pm-note">${escapeHtml(noteLabel)}</label>
                    <textarea id="pm-note" class="form-textarea" placeholder="${escapeHtml(notePlaceholder)}">${escapeHtml(initialNote)}</textarea>
                </div>
                <p class="form-field-hint" id="pm-error" style="color:#fecaca; display:none"></p>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn btn-primary" id="pm-submit">${escapeHtml(submitLabel)}</button>
                <button type="button" class="btn btn-secondary modal-close">${escapeHtml(cancelLabel)}</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        overlay.querySelector('.modal-close').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        const priceInput = overlay.querySelector('#pm-price');
        const noteInput = overlay.querySelector('#pm-note');
        const errorEl = overlay.querySelector('#pm-error');
        const submitBtn = overlay.querySelector('#pm-submit');

        priceInput.focus();

        submitBtn.addEventListener('click', async () => {
            errorEl.style.display = 'none';

            const raw = priceInput.value.trim();
            const price = Number(raw);
            if (!raw || Number.isNaN(price) || price <= 0) {
                errorEl.textContent = 'Enter a price greater than $0.';
                errorEl.style.display = 'block';
                priceInput.focus();
                return;
            }

            submitBtn.disabled = true;
            const originalLabel = submitBtn.textContent;
            submitBtn.textContent = submitPendingLabel;

            try {
                const result = await onSubmit(price, noteInput.value.trim());
                if (result && result.success === false) {
                    errorEl.textContent = result.message || 'Something went wrong. Please try again.';
                    errorEl.style.display = 'block';
                    submitBtn.disabled = false;
                    submitBtn.textContent = originalLabel;
                    return;
                }
                close();
            } catch (err) {
                console.error('[ForgeFlow][pricingModal] submit failed', err);
                errorEl.textContent = 'Could not reach the ForgeFlow server. Please try again.';
                errorEl.style.display = 'block';
                submitBtn.disabled = false;
                submitBtn.textContent = originalLabel;
            }
        });

        return { close };
    };
})();

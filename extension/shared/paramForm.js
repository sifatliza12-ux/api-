/**
 * paramForm.js
 * Generic runtime-parameter form renderer/collector shared by every page
 * that can run an API (My APIs, Marketplace, Purchased APIs). It knows
 * nothing about any particular workflow, site, or field name — it only
 * reads the generic parameter schema the backend already produces for ANY
 * recorded workflow (see backend/services/ruleBasedParameterizer.js /
 * workflowParameterizer.js): { name, type, label, description, defaultValue,
 * options }. A new API therefore gets a working parameter form automatically,
 * with no frontend changes, the moment its workflow.parameters exists.
 */
(function (global) {
    const escapeHtml = (str) => {
        if (str === null || typeof str === 'undefined') return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    const buildFieldHtml = (param) => {
        const inputId = `param-input-${param.name}`;
        const safeName = escapeHtml(param.name);
        const label = param.label || param.name;

        if (param.type === 'boolean') {
            const checked = param.defaultValue ? 'checked' : '';
            return `
                <div class="param-field">
                    <label class="param-field-checkbox-row" for="${inputId}">
                        <input type="checkbox" id="${inputId}" data-param-name="${safeName}" data-param-type="boolean" ${checked}>
                        <span class="param-field-label">${escapeHtml(label)}</span>
                    </label>
                    ${param.description ? `<p class="param-field-description">${escapeHtml(param.description)}</p>` : ''}
                </div>
            `;
        }

        // A select-type parameter (distinct option values the recording
        // implied — see workflowParameterizer.js) renders as a real <select>
        // instead of a free-text input, purely because the schema says so —
        // no site-specific handling involved.
        if (param.type === 'select' && Array.isArray(param.options) && param.options.length) {
            const defaultValue = String(param.defaultValue ?? '');
            const optionsHtml = param.options.map((opt) => {
                const optValue = String(opt);
                const selected = optValue === defaultValue ? 'selected' : '';
                return `<option value="${escapeHtml(optValue)}" ${selected}>${escapeHtml(optValue)}</option>`;
            }).join('');
            return `
                <div class="param-field">
                    <label class="param-field-label" for="${inputId}">${escapeHtml(label)}</label>
                    <select id="${inputId}" class="param-field-input" data-param-name="${safeName}" data-param-type="select">
                        ${optionsHtml}
                    </select>
                    ${param.description ? `<p class="param-field-description">${escapeHtml(param.description)}</p>` : ''}
                </div>
            `;
        }

        const inputType = param.type === 'number' ? 'number' : (param.type === 'date' ? 'date' : 'text');
        const value = escapeHtml(String(param.defaultValue ?? ''));

        return `
            <div class="param-field">
                <label class="param-field-label" for="${inputId}">${escapeHtml(label)}</label>
                <input type="${inputType}" id="${inputId}" class="param-field-input" data-param-name="${safeName}" data-param-type="${param.type || 'text'}" value="${value}">
                ${param.description ? `<p class="param-field-description">${escapeHtml(param.description)}</p>` : ''}
            </div>
        `;
    };

    // Full "Parameters" section (heading + hint + one field per parameter).
    // Returns '' for a workflow with no variable steps, so a caller can
    // splice this straight into a modal without a separate length check.
    const buildFieldsHtml = (parameters, options = {}) => {
        const list = Array.isArray(parameters) ? parameters : [];
        if (!list.length) return '';
        const hint = options.hint || "Pre-filled with the values captured while recording — edit any of them before running.";
        return `
            <h4>Parameters</h4>
            <p class="param-field-hint">${escapeHtml(hint)}</p>
            ${list.map(buildFieldHtml).join('')}
        `;
    };

    // Reads every rendered field back out by its data-param-name/-type —
    // the same generic contract buildFieldHtml wrote, so this works for
    // whatever set of parameters happened to be rendered, in any container.
    const collectValues = (container) => {
        const values = {};
        container.querySelectorAll('[data-param-name]').forEach((input) => {
            const name = input.dataset.paramName;
            const type = input.dataset.paramType;
            if (type === 'boolean') {
                values[name] = input.checked;
            } else if (type === 'number') {
                values[name] = input.value === '' ? null : Number(input.value);
            } else {
                values[name] = input.value;
            }
        });
        return values;
    };

    global.ForgeFlowParamForm = { buildFieldsHtml, collectValues };
})(window);

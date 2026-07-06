// Runs entirely inside the replayed page via page.evaluate — no Node/Playwright
// APIs are reachable here, only plain browser DOM. Two extraction modes:
//   - hint: caller supplies a CSS selector for the repeating result container.
//   - dom: auto-detect repeating sibling structures (cards/rows/lists/grids)
//     by grouping elements under a signature of (parent signature > own
//     signature) and picking the group that looks most like real content
//     (multiple members, substantial and consistent text length).
// Either way, each matched "item" root is walked in document order to pull
// out leaf-level text/attributes — that order is what lets the same slot
// line up across items, since repeating cards share the same structure.
const extractInPage = ({ hintSelector }) => {
  const elementSignature = (el) => {
    const classPart = (el.className && typeof el.className === 'string')
      ? el.className.trim().split(/\s+/).filter(Boolean).sort().join('.')
      : '';
    return `${el.tagName}#${classPart}`;
  };

  const detectRepeatingRoots = () => {
    const groups = new Map();
    const allElements = document.body ? document.body.querySelectorAll('*') : [];

    allElements.forEach((el) => {
      const parent = el.parentElement;
      if (!parent) return;
      const text = (el.innerText || '').trim();
      if (text.length < 15) return;
      const key = `${elementSignature(parent)}>${elementSignature(el)}`;
      if (!groups.has(key)) groups.set(key, []);
      const bucket = groups.get(key);
      if (bucket.length < 200) bucket.push(el);
    });

    let best = null;
    let bestScore = -1;

    groups.forEach((members) => {
      if (members.length < 2) return;
      const lengths = members.map((m) => (m.innerText || '').trim().length);
      const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      if (avg < 15) return;
      const variance = lengths.reduce((sum, l) => sum + Math.abs(l - avg), 0) / lengths.length;
      const consistency = 1 / (1 + variance / (avg || 1));
      const score = members.length * avg * consistency;
      if (score > bestScore) {
        bestScore = score;
        best = members;
      }
    });

    return best || [];
  };

  const extractFieldsFromRoot = (root) => {
    const fields = [];

    const visit = (el) => {
      const children = Array.from(el.children);
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .filter(Boolean)
        .join(' ');

      if (el.tagName === 'IMG') {
        const alt = el.getAttribute('alt') || '';
        const src = el.getAttribute('src') || '';
        if (alt || src) {
          fields.push({ tag: 'img', text: alt, attr: 'src', attrValue: src, hint: el.getAttribute('aria-label') || alt || null });
        }
        return;
      }

      if (el.tagName === 'A' && ownText) {
        fields.push({ tag: 'a', text: ownText, attr: 'href', attrValue: el.getAttribute('href') || null, hint: el.getAttribute('aria-label') || null });
      } else if (ownText && children.length === 0) {
        fields.push({
          tag: el.tagName.toLowerCase(),
          text: ownText,
          attr: null,
          attrValue: null,
          hint: el.getAttribute('aria-label')
            || el.getAttribute('data-testid')
            || el.getAttribute('data-qa')
            || el.getAttribute('placeholder')
            || null
        });
      }

      children.forEach(visit);
    };

    visit(root);
    return fields;
  };

  let roots = [];
  let mode = 'none';

  if (hintSelector) {
    try {
      roots = Array.from(document.querySelectorAll(hintSelector)).slice(0, 200);
      if (roots.length) mode = 'hint';
    } catch (error) {
      roots = [];
    }
  } else {
    roots = detectRepeatingRoots();
    if (roots.length) mode = 'dom';
  }

  return {
    items: roots.map(extractFieldsFromRoot),
    mode
  };
};

const extract = async (page, { hintSelector } = {}) => {
  try {
    return await page.evaluate(extractInPage, { hintSelector: hintSelector || null });
  } catch (error) {
    return { items: [], mode: 'none' };
  }
};

module.exports = { extract };

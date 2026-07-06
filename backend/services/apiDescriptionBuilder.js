// Generates a plain-English summary of a parameterized workflow so it's
// readable to a normal human (a marketplace buyer, not just a developer)
// wherever it's listed — My APIs, the API detail view, and the Marketplace.
// Deliberately template-based, not AI-generated: no external API call, no
// cost, no latency, consistent with the same choice already made for
// parameter naming (ruleBasedParameterizer.js).
const summarizeDomains = (steps) => {
  const domains = new Set();

  (steps || []).forEach((step) => {
    if (step.type !== 'navigation' || !step.value) {
      return;
    }
    try {
      domains.add(new URL(step.value).hostname);
    } catch (error) {
      // Not an absolute URL (e.g. a relative pushState navigation) — skip it,
      // this is a best-effort summary, not a correctness-critical parse.
    }
  });

  const list = Array.from(domains);
  if (list.length === 0) {
    return 'a recorded page';
  }
  if (list.length === 1) {
    return list[0];
  }
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
};

const buildApiDescription = ({ steps, parameters }) => {
  const siteText = summarizeDomains(steps);

  let clickCount = 0;
  let fieldCount = 0;
  (steps || []).forEach((step) => {
    if (step.type === 'click' || step.type === 'dblclick') {
      clickCount += 1;
    } else if (step.type === 'input' || step.type === 'change') {
      fieldCount += 1;
    }
  });

  const actions = [];
  if (clickCount > 0) {
    actions.push(`clicks ${clickCount} element${clickCount === 1 ? '' : 's'}`);
  }
  if (fieldCount > 0) {
    actions.push(`fills in ${fieldCount} field${fieldCount === 1 ? '' : 's'}`);
  }
  const actionText = actions.length > 0 ? actions.join(' and ') : 'replays the recorded steps';

  let description = `Automates a workflow on ${siteText}. It navigates to the page and ${actionText}.`;

  const params = parameters || [];
  if (params.length === 0) {
    description += ' Takes no inputs — every step uses a fixed, recorded value.';
  } else {
    const paramList = params
      .map((param) => {
        const example = param.defaultValue !== null && param.defaultValue !== undefined && param.defaultValue !== ''
          ? `, e.g. "${param.defaultValue}"`
          : '';
        return `${param.label} (${param.type}${example})`;
      })
      .join(', ');
    description += ` Takes ${params.length} input${params.length === 1 ? '' : 's'}: ${paramList}.`;
  }

  return description;
};

module.exports = { buildApiDescription };

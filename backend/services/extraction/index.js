const domExtractor = require('./domExtractor');
const { inferFieldNames, namesToObjects } = require('./semanticNaming');
const schemaStore = require('./schemaStore');
const { extractWithLlm } = require('./llmExtractor');

const MAX_ITEMS = 20;
const BASE_CONFIDENCE = { hint: 0.6, dom: 0.4, llm: 0.35, none: 0 };

// Canonical field names, once set for a workflow, are never renamed —
// only grown. Position 0..stored.length-1 always keeps its stored name;
// any new trailing slots this run found get appended and persisted.
const reconcileSchema = (workflowId, candidateNames) => {
  const stored = schemaStore.getSchema(workflowId);
  if (!stored || !stored.length) {
    schemaStore.saveSchema(workflowId, candidateNames);
    return candidateNames;
  }

  const reconciled = stored.slice();
  for (let i = stored.length; i < candidateNames.length; i += 1) {
    reconciled.push(candidateNames[i]);
  }
  if (reconciled.length !== stored.length) {
    schemaStore.saveSchema(workflowId, reconciled);
  }
  return reconciled;
};

const capItems = (data) => (
  data.length <= MAX_ITEMS
    ? { data, truncated: false, totalFound: data.length }
    : { data: data.slice(0, MAX_ITEMS), truncated: true, totalFound: data.length }
);

const consistencyBonus = (items, fieldNameCount) => {
  if (!items.length || !fieldNameCount) return 0;
  const completeCount = items.filter((item) => {
    for (let pos = 0; pos < fieldNameCount; pos += 1) {
      if (!item[pos]) return false;
    }
    return true;
  }).length;
  return 0.3 * (completeCount / items.length);
};

const emptyResult = (method = 'none') => ({ data: [], confidence: 0, method, truncated: false, totalFound: 0 });

const extractPageData = async ({ page, workflowId, extractionHint }) => {
  try {
    const hintSelector = extractionHint?.selector || null;
    let items = [];
    let method = 'none';

    if (hintSelector) {
      const result = await domExtractor.extract(page, { hintSelector });
      if (result.items.length) {
        items = result.items;
        method = 'hint';
      }
    }

    if (!items.length) {
      const result = await domExtractor.extract(page, {});
      if (result.items.length) {
        items = result.items;
        method = 'dom';
      }
    }

    if (items.length) {
      const candidateNames = inferFieldNames(items);
      const cachedBefore = schemaStore.getSchema(workflowId);
      const fieldNames = workflowId ? reconcileSchema(workflowId, candidateNames) : candidateNames;
      const objects = namesToObjects(items, fieldNames);
      const capped = capItems(objects);

      let confidence = BASE_CONFIDENCE[method] + consistencyBonus(items, fieldNames.length);
      if (cachedBefore && cachedBefore.length === candidateNames.length) confidence += 0.1;
      confidence = Math.min(0.95, Math.round(confidence * 100) / 100);

      console.log(`[Backend][extraction] method=${method} workflowId=${workflowId} itemsFound=${capped.totalFound} confidence=${confidence}`);

      return { data: capped.data, confidence, method, truncated: capped.truncated, totalFound: capped.totalFound };
    }

    // Only reached once the free/local strategies (hint + DOM auto-detect)
    // both come back empty — never attempted before that, per instruction.
    const llmItems = await extractWithLlm(page).catch((error) => {
      console.warn('[Backend][extraction] LLM extraction failed, ignoring:', error.message);
      return null;
    });

    if (Array.isArray(llmItems) && llmItems.length) {
      const capped = capItems(llmItems);
      const firstKeys = JSON.stringify(Object.keys(llmItems[0]).sort());
      const keysConsistent = llmItems.every((obj) => JSON.stringify(Object.keys(obj).sort()) === firstKeys);
      const confidence = Math.min(0.95, BASE_CONFIDENCE.llm + (keysConsistent ? 0.2 : 0));

      console.log(`[Backend][extraction] method=llm workflowId=${workflowId} itemsFound=${capped.totalFound} confidence=${confidence}`);

      return { data: capped.data, confidence, method: 'llm', truncated: capped.truncated, totalFound: capped.totalFound };
    }

    console.log(`[Backend][extraction] method=none workflowId=${workflowId} itemsFound=0 confidence=0`);
    return emptyResult('none');
  } catch (error) {
    console.warn('[Backend][extraction] extraction pipeline failed, returning empty result:', error.message);
    return emptyResult('error');
  }
};

module.exports = { extractPageData };
